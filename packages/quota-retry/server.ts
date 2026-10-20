// quota-retry 2.0 — 插件入口(正式版, effect 形态)。
//
// 加载契约(packages/core/src/plugin/module.ts): 默认导出必须是 { id, effect } 或 { id, setup }。
// 这里用 effect 形态: 只有它拿到宿主 Effect 运行时的 Scope, 才能用框架原语做"定时"——
// 与 opencode 自己的插件(provider/digitalocean.ts 等)同一机制。
//
// 机制(三个部件, 全部经 Docker/真机实测验证):
//   1. 轮内等待 — session.http.response hook 抓 429 body + session.retry hook
//      写 decision = { retry: true, delay }。原生 runner 执行重试, TUI 显示原生
//      徽标("⚠ Retrying in Ns · attempt N"), 延迟不封顶。
//   2. 轮次续命 — 原生 10 次耗尽后(core 硬编码 recurs(10)), 从事件流收到
//      execution.failed: 注入 text=<前缀+随机> 的 synthetic 通知行(description =
//      可见轮次)。标记经 inbox 驱动新执行 = 全新 10 次原生重试。无限轮。
//      代价(已接受): 不删失败现场, 每轮累积一条失败 assistant + 一条标记。
//   3. 出口净化 — session.http.request hook 剥掉标记 synthetic 在出站请求里映射的
//      尾部 user 消息(按文本前缀判定, 不按"空"判定)。
//
// 长等待心跳(effect 形态的核心动机): 等待期间不产生 durable 会话事件, opencode 的
// location 不活动回收(60 分钟 TTL, core/src/location-activity.ts, 只被"带 location 的
// durable 会话事件"刷新)会把长等待打断。心跳 = 等待期间每 heartbeatMs 落一条 durable
// 标记(session.synthetic, resume:false → 只入队不唤醒, 不打断睡眠), 刷新 TTL。
// 实现: 每个长等待 fork 一个随插件 Scope 生灭的定时 fiber(Effect.sleep 循环),
// 等待结束(step.started / interrupted / succeeded / execution.failed)即中断。
// **不依赖任何宿主周期事件**——定时能力来自框架原语本身。
//
// 零进程外依赖: 全部走插件 API(ctx.session/ctx.event)。revert 无插件 API(上游
// 缺口, 已提 issue), 续命不做消息删除, 用界面噪音换部署自由。
//
// 1.x 功能对照:
//   ✅ 配额识别(quotaMatch/resetExtract/zhipu API 精确重置)
//   ✅ 无限等待(decision.delay 无封顶)
//   ✅ 无限次数(轮次续命, 每轮原生 10 次; 1.x 靠二进制补丁, 2.0 出货二进制核心
//      chunk 是 JSC bytecode, 明文补丁无效 — 已实验证明)
//   ✅ TUI 可见性(原生徽标 + 每轮覆写的通知行 "quota-retry · 第 N 轮")
//   ✅ quota-retry-status 工具 / retry-setting 命令(零模型回复)
//   消息可见性(全部本插件自建消息): id = msg_quota-retry-*, resume 只决定是否唤醒,
//   是否进模型请求由 context hook 按 id 剥除决定(详见 README 的"消息总表")
//   ✅ 长等待心跳(插件自己的定时 fiber, 框架原语, 不依赖宿主事件)
//   ❌ on-demand 降级链: 已移除(2.0 无模型路由能力; 见 issue #2)

import { Plugin } from "@opencode/plugin/effect"
import { Effect, Fiber, Schema, Stream } from "effect"
import {
  computeWaitMs,
  expandProviders,
  isQuotaError,
  isQuotaResponse,
  needsHeartbeat,
  parseResetAtMs,
  shouldContinue,
  zhipuResetAtMs,
  DEFAULT_QUOTA_CACHE_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_QUOTA_STATUSES,
  HEARTBEAT_TEXT_PREFIX,
  MARKER_TEXT_PREFIX,
  MESSAGE_ID_PREFIX,
  isPluginMessageId,
  resolveEventOwner,
  type PluginConfig,
  type ProviderConfig,
} from "./core"
import { loadConfig } from "./config"
import { appendLogLine, defaultLogFile } from "./log"

const MARKER_PREFIX = "quota-retry"

// 运行日志(默认关闭, 排查时开): 只记关键决策(判定命中/算出的等待/心跳发送与失败/加载卸载/错误)。
// 开启: 配置 logFile: true(默认路径 ~/.cache/opencode/buraunkan/quota-retry.log)或自定义路径;
// 缺省/false = 关闭。
let LOG_FILE: string | null = null

function dbg(...a: any[]) {
  if (!LOG_FILE) return
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")
  appendLogLine(LOG_FILE, line)
}

function providerIdsOf(records: ReadonlyArray<any>): string[] {
  const out: string[] = []
  for (const r of records) {
    const id = r?.providerID ?? r?.provider?.providerID ?? r?.provider?.id ?? r?.id
    if (typeof id === "string") out.push(id)
  }
  return out
}

function humanWait(ms: number): string {
  const minutes = ms / 60_000
  if (minutes >= 60) return `约 ${Math.round(minutes / 60)} 小时`
  if (minutes >= 1) return `约 ${Math.round(minutes)} 分钟`
  return "不到 1 分钟"
}

// 把 async 函数包成"永不失败"的 Effect(hook 回调要求 Effect<void, never>)。
function runAsync(fn: () => Promise<void>, onError?: (err: unknown) => void) {
  return Effect.tryPromise({ try: fn, catch: (err) => err }).pipe(
    Effect.catch((err) =>
      Effect.sync(() => {
        if (onError) onError(err)
      }),
    ),
  )
}

export default Plugin.define({
  id: "quota-retry",
  effect: Effect.fn(function* (ctx) {
    const projectDir = ctx.location?.directory ?? process.cwd()
    const cfg = loadConfig(projectDir)
    LOG_FILE = cfg.logFile === true ? defaultLogFile() : cfg.logFile ? String(cfg.logFile) : null
    const quotaCacheMs = cfg.quotaCacheMs ?? DEFAULT_QUOTA_CACHE_MS
    const maxRounds = cfg.maxRounds ?? Number(process.env.QUOTA_RETRY_MAX_ROUNDS ?? -1)

    // 运行时 providerID → 配置: 懒刷新。
    // 2.0.16 死锁教训: setup 期间 await provider State 读取会与插件层初始化循环等待
    // (provider State 的重放依赖插件层就绪), 内置插件列表变化放大了启动时序窗口 → 间歇挂死。
    // 规则: 插件 setup 绝不 await 任何 State 读取; expandProviders(cfg, []) 的静态展开已够,
    // 运行时 provider 清单在首个需要它的调用(工具/命令)时再补。
    let expanded = expandProviders(cfg, [])
    const refreshExpanded = ctx.provider.list().pipe(
      Effect.map((out) => {
        expanded = expandProviders(cfg, providerIdsOf(out.data))
      }),
      Effect.catch(() => Effect.void),
    )

    // ── 会话内状态 ──
    const recent429 = new Map<string, { at: number; status: number; text: string }>() // sid -> 最近一次"配额类状态码"响应
    const zhipuCache = new Map<string, { at: number; resetAt: number }>() // providerID -> 精确重置时刻缓存
    const rounds = new Map<string, number>() // sid -> 当前 turn 已续命轮数
    const stopped = new Set<string>() // 用户接管/中断后不再续命
    const quotaHit = new Set<string>() // retry hook 判定过配额的会话(精确等待来源)
    // sid -> 最近一次失败的错误(原生重试耗尽时判定是否续命, 见 shouldContinue)
    const lastFailure = new Map<string, { type?: string; status?: number; message?: string }>()
    // sid -> 最近一次失败 step 的 assistantMessageID(续命标记的幂等键, 见 redoRound)
    const lastFailureMessage = new Map<string, string>()
    // sid -> 会话目录反查缓存(60s TTL; 无信封事件归属判定用, 见 handleEventInner)
    const dirCache = new Map<string, { dir: string | undefined; at: number }>()
    // providerID -> 出站 Authorization 头(zhipu 配额查询的 apiKey 回退来源, 对齐 1.x)
    const authCache = new Map<string, string>()

    // ── 部件 1c: 长等待心跳(插件自己的定时 fiber, 框架原语) ──
    // 每个长等待一个 fiber: 随插件 Scope 生灭(插件卸载自动停), 等待结束显式中断。
    // 发送 = 一条 durable 标记(session.synthetic, resume:false → 只入队不唤醒, 不打断睡眠);
    // 标记文本用同一前缀, 出口会被 strip 剥掉, 不进入模型请求。
    const heartbeatMs = Number(cfg.heartbeatMs ?? DEFAULT_HEARTBEAT_MS)
    dbg("[boot] setup:", String(ctx.location?.directory ?? ""), "heartbeatMs=", heartbeatMs)
    const heartbeats = new Map<string, Fiber.Fiber<void>>() // sid -> 定时 fiber

    const sendHeartbeat = (sid: string) => {
      const now = Date.now()
      return ctx.session
        .synthetic({
          sessionID: sid as any,
          id: `${MESSAGE_ID_PREFIX}-heartbeat-${now.toString(36)}` as any,
          text: `${HEARTBEAT_TEXT_PREFIX}${Math.random().toString(36).slice(2, 10)}`,
          description: `${MARKER_PREFIX} heartbeat`,
          // 只刷 location TTL: 不唤醒(不打断正在进行的等待), 也不进模型请求(context hook 按 id 剥)
          resume: false,
        })
        .pipe(Effect.asVoid)
    }

    const armHeartbeat = (sid: string, delayMs: number) =>
      Effect.gen(function* () {
        if (!sid || !needsHeartbeat(delayMs, heartbeatMs)) return
        const prev = heartbeats.get(sid)
        if (prev) yield* Fiber.interrupt(prev)
        dbg("[heartbeat] arm:", sid, "heartbeatMs=", heartbeatMs)
        const fiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            // 每个间隔发一条; 发失败就停(下次等待会重新 arm), 不让坏 fiber 空转。
            while (true) {
              yield* Effect.sleep(heartbeatMs)
              const ok = yield* sendHeartbeat(sid).pipe(
                Effect.as(true),
                Effect.catch((err) =>
                  Effect.sync(() => {
                    dbg("[heartbeat] FAIL:", String((err as any)?.message ?? err).slice(0, 160))
                    return false
                  }),
                ),
              )
              if (!ok) break
              dbg("[heartbeat] sent:", sid)
            }
          }),
        )
        heartbeats.set(sid, fiber)
      })

    const disarmHeartbeat = (sid: string, reason: string) =>
      Effect.gen(function* () {
        const fiber = heartbeats.get(sid)
        if (!fiber) return
        heartbeats.delete(sid)
        dbg("[heartbeat] disarm:", reason, sid)
        yield* Fiber.interrupt(fiber)
      })

    // 本 turn 是否处于"续命救援"中(配额精确等待命中, 或已开始轮次)
    const inRescue = (sid: string) => quotaHit.has(sid) || rounds.has(sid)

    const resetSession = (sid: string) =>
      Effect.gen(function* () {
        rounds.delete(sid)
        stopped.delete(sid)
        quotaHit.delete(sid)
        lastFailure.delete(sid)
        lastFailureMessage.delete(sid)
        yield* disarmHeartbeat(sid, "succeeded")
      })

    // ── 部件 3: 记录出站 Authorization(配额查询/改写需要 apiKey 时使用) ──
    // 注: 消息的"不可见"不在这里做 —— 已改为 context hook 按 message.id 剥除(见部件 0)。
    const onHttpRequest = async (evt: any): Promise<void> => {
      const req: Request = evt.request
      const providerID = String(evt?.model?.providerID ?? "")
      if (providerID) {
        const auth = req.headers.get("authorization")
        if (auth) authCache.set(providerID, auth.replace(/^Bearer\s+/i, ""))
      }
    }
    yield* ctx.session.hook("http.request", (evt) =>
      runAsync(
        () => onHttpRequest(evt),
        (err) => dbg("[strip] error:", String(err)),
      ),
    )

    // ── 部件 0: 请求构造期按 id 剥除本插件自建的消息(标记/回复) ──
    // 两条互相独立的规则, 缺一不可:
    //   ① resume(各 synthetic 调用点) 只决定"是否唤醒模型"(core/src/session/session.ts:174
    //      `if (input.resume !== false) yield* execution.wake(sessionID)`), 不改变可见性;
    //   ② 可见性只由本 hook 决定: 每次请求构造时按 message.id 前缀整段丢掉。
    // 实测(移除本 hook 的副本 + mock): resume:false 的心跳标记会出现在之后每一轮请求里(17 次);
    // 保留本 hook 时同场景 0 次。synthetic 一经 HTTP 序列化只剩 role/content, 所以必须在这里剥。
    // 旧实现的 id(msg_quota-retry_* / msg_quota-retry-heartbeat-*)同前缀, 一并覆盖。
    yield* ctx.session.hook("context", (evt: any) =>
      Effect.sync(() => {
        try {
          if (!Array.isArray(evt?.messages)) return
          const kept = evt.messages.filter((m: any) => !isPluginMessageId(m?.id))
          const removed = evt.messages.length - kept.length
          if (removed > 0) {
            evt.messages = kept
            dbg("[context] stripped:", removed)
          }
        } catch (err) {
          dbg("[context] ERROR:", String(err))
        }
      }),
    )

    // ── 部件 1a 前置: 续命期间压制 title 重生成(标记驱动的新执行会触发它, 浪费一次请求) ──
    yield* ctx.session.hook("title", (evt: any) =>
      Effect.sync(() => {
        const sessionID = String(evt?.sessionID ?? "")
        if (!sessionID || !inRescue(sessionID)) return
        // 一律置空跳过 title 模型请求(续命期间 title 保持原值)
        evt.result = ""
      }),
    )

    // ── 部件 1a: 抓"配额类状态码"的响应本体 ──
    // retry 事件的 error 不带 body, 且首次失败时错误文案未必含配额特征(1.x 直接看响应,
    // 所以第一次就接管)。这里按 provider.statuses(默认 [429]) 捕获原始响应,
    // 判定放在 retry hook 里做(与 1.x 的响应驱动一致)。
    const onHttpResponse = async (evt: any): Promise<void> => {
      const providerID = String(evt?.model?.providerID ?? "")
      const p = expanded.get(providerID)
      const status = Number(evt?.response?.status)
      const statuses = p?.statuses ?? DEFAULT_QUOTA_STATUSES
      if (!Number.isFinite(status) || !statuses.includes(status)) return
      try {
        const text = await evt.response.clone().text()
        recent429.set(String(evt.sessionID), { at: Date.now(), status, text })
      } catch (err) {
        dbg("[resp-hook] clone/text err:", String(err))
      }
    }
    yield* ctx.session.hook("http.response", (evt) =>
      runAsync(
        () => onHttpResponse(evt),
        (err) => dbg("[resp-hook] handler ERROR:", String((err as any)?.stack ?? err).slice(0, 200)),
      ),
    )

    // ── 部件 1b: 轮内精确等待(原生徽标, delay 不封顶) ──
    const onRetry = async (evt: any): Promise<void> => {
      const sessionID = String(evt?.sessionID ?? "")
      const providerID = String(evt?.model?.providerID ?? "")
      const type = evt?.error?.type
      const message = String(evt?.error?.message ?? "")
      const p = expanded.get(providerID)
      const captured = recent429.get(sessionID)
      // ① 响应驱动(对齐 1.x): 捕获到的原始响应命中"状态码 ∈ statuses + 正文命中 quotaMatch"。
      const byResponse = captured ? isQuotaResponse(captured.status, captured.text, p) : false
      // ② 兜底: 没抓到响应时用 opencode 归纳出的错误(type == provider.quota 或文案命中正则)。
      const byError = !byResponse && isQuotaError(type, message, p?.quotaMatch)
      if (!byResponse && !byError) return

      quotaHit.add(sessionID)
      const now = Date.now()
      let resetAtMs = Number.NaN
      const zhipuKey = p?.apiKey ?? authCache.get(providerID)
      if (p?.quota === "zhipu" && zhipuKey) {
        const hit = zhipuCache.get(providerID)
        if (hit && now - hit.at < quotaCacheMs) resetAtMs = hit.resetAt
        else {
          resetAtMs = await zhipuResetAtMs(zhipuKey, { quotaUrl: p.quotaUrl })
          if (Number.isFinite(resetAtMs)) zhipuCache.set(providerID, { at: now, resetAt: resetAtMs })
        }
      }
      if (!Number.isFinite(resetAtMs) && captured) {
        resetAtMs = parseResetAtMs(captured.text, p?.resetExtract)
      }
      const delay = computeWaitMs({ now, resetAtMs, bufferMs: p?.bufferMs, fallbackWaitMs: p?.fallbackWaitMs })
      evt.decision = { retry: true, delay }
      // 心跳不在这里 arm: 排定重试的同一流程里宿主会先发 step.started(会 disarm), 随后才是
      // retry.scheduled。统一由事件流里的 session.retry.scheduled 按排定时刻 arm, 顺序确定。
      dbg(
        `[decision] engage: attempt=${evt?.attempt} via=${byResponse ? "response" : "error"} delayMs=${delay} (${humanWait(delay)}) resetAtMs=${resetAtMs}`,
      )
      console.log(
        `[quota-retry] ${providerID} 配额耗尽(attempt=${evt?.attempt}, via=${byResponse ? "response" : "error"}), ${humanWait(delay)}后重试`,
      )
    }
    yield* ctx.session.hook("retry", (evt) =>
      runAsync(
        () => onRetry(evt),
        (err) => dbg("[retry-hook] ERROR:", String((err as any)?.stack ?? err).slice(0, 200)),
      ),
    )

    // ── 部件 2: 轮次续命 — 10 次耗尽 → 标记驱动新一轮(纯插件 API, 零进程外依赖) ──
    // 代价(已接受): 不删失败现场, 每轮累积一条失败 assistant + 一条标记(界面噪音);
    // 发给模型的请求由出口 strip 保持干净(标记 user 消息剥除)。
    const redoRound = (sessionID: string, round: number) =>
      Effect.gen(function* () {
        // 标记 text = 前缀 + 随机 token: 出口按 id 前缀剥除(见部件 0), 不靠"空"判定,
        // description 前台可见, id 自指定便于定位。
        //
        // 幂等键 = 失败 step 的 assistantMessageID(每轮失败各不相同, 见 step.failed 分支):
        //   · 同一次失败在多实例下算出同一个 id, 第二个注入得到冲突
        //     (synthetic 不是 upsert) → 视为"已被续过", 幂等跳过;
        //   · 拿不到 assistantMessageID(drain 级失败, 未经 step.failed)→ 退回
        //     轮次号+时间戳: 宁可多续一次(重复标记代价是多跑一轮), 也不能用可能撞旧标记的
        //     纯轮次号 —— 那会静默丢续命, 与本插件的存在目的相反。
        const failureKey = lastFailureMessage.get(sessionID) ?? `r${round}-${Date.now().toString(36)}`
        const markerID = `${MESSAGE_ID_PREFIX}-round-${sessionID}-${failureKey}`
        const markerText = `${MARKER_TEXT_PREFIX}${Math.random().toString(36).slice(2, 10)}`
        yield* ctx.session
          .synthetic({
            sessionID: sessionID as any,
            id: markerID as any,
            text: markerText,
            description: `${MARKER_PREFIX} round · 第 ${round} 轮`,
            // 必须唤醒: 这条标记就是下一轮的驱动(新执行 -> 全新 10 次原生重试)
            resume: true,
          })
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => console.log(`[quota-retry] ${sessionID} 第 ${round} 轮续命(原生 10 次重试重新计数)`)),
            ),
            Effect.catch((err) =>
              Effect.sync(() => {
                const msg = String((err as any)?.message ?? err)
                const tag = String((err as any)?._tag ?? "")
                // 幂等跳过: 同一次失败被第二个实例先续过了(synthetic 同 id 冲突)
                // 冲突判定 tag 优先(有结构化错误类型时), 文案正则兜底
                if (/conflict|already exists/i.test(`${tag} ${msg}`)) {
                  dbg("[round] marker already injected, idempotent skip:", markerID)
                  return
                }
                dbg("[round] synthetic FAIL:", msg.slice(0, 140))
              }),
            ),
          )
      })

    // ── 事件流: 续命判定 + 心跳 arm/disarm + 状态清零 ──
    const handleEventInner = (ev: any) =>
      Effect.gen(function* () {
        const type = ev?.type
        const data = ev?.data ?? ev
        // 事件流是全 location 广播: 必须先判定归属, 否则同一个会话会被每个实例各处理一遍
        // (实测 3 个 location 实例 = 3 条重复标记)。归属判据见 core.resolveEventOwner:
        //   · 有信封(location 级事件, 高频) → 信封是权威, 快路径, 不查库;
        //   · 无信封(execution.* / usage.updated) → 按 sessionID 反查会话目录。
        // 不能只比信封: execution.* 不带信封, 只比信封会把续命/清零/disarm 全部静默丢弃
        // (2026-10-20 事故: 10 次原生重试耗尽后会话直接 failed, 无任何报错)。
        const evLoc = String(ev?.location?.directory ?? "")
        const selfDir = String(ctx.location?.directory ?? "")
        let sessionDir: string | undefined
        if (!evLoc) {
          const sid = String((data as any)?.sessionID ?? "")
          if (!sid) return // 全局事件(server.connected 等), 与本插件无关
          // sid→dir 短 TTL 缓存: 事件流是全 location 广播, 无信封事件(execution.*/usage.updated)
          // 每条都要反查一次 session, 多 location 部署下是热路径; 60s TTL 也兜住 session.move 的陈旧性。
          const cached = dirCache.get(sid)
          const fresh = cached && Date.now() - cached.at < 60_000
          if (fresh) {
            sessionDir = cached.dir
          } else {
            const info = yield* ctx.session
              .get({ sessionID: sid as any })
              .pipe(
                Effect.catch((e: any) =>
                  Effect.sync(() => {
                    dbg("[owner] get error:", String(e?._tag ?? e?.message ?? e).slice(0, 140))
                    return undefined as any
                  }),
                ),
              )
            // Session.Info 没有顶层 directory —— 目录在 info.location.directory
            const rawDir = (info as any)?.location?.directory
            sessionDir = rawDir === undefined || rawDir === null ? undefined : String(rawDir)
            // 只缓存成功结果: 查询失败(超时/实例刚启动)若是缓存了 undefined, 60s 内到达的
            // execution.failed(一次性事件, 无重试)会被误判"非本 location"而静默丢续命(#18 review r2)。
            // 失败不写缓存 → 下一条无信封事件(如 usage.updated)会再查, 等于免费重试。
            if (sessionDir !== undefined) {
              if (dirCache.size > 4096) dirCache.clear() // 粗上限: 防按会话数无限增长(插入序无法逐条淘汰, 清空代价可忽略)
              dirCache.set(sid, { dir: sessionDir, at: Date.now() })
            }
          }
          if (sessionDir === undefined) dbg("[owner] session lookup failed:", sid, type)
        }
        if (resolveEventOwner(evLoc, selfDir, sessionDir) === "skip") {
          if (!evLoc) dbg("[owner] skip by session dir:", sessionDir ?? "<not-found>", "self=", selfDir, type)
          return
        }
        if (type === "session.inbox.enqueued" && data?.item?.type === "user") {
          // 用户接管: 仅在本 turn 已处于续命救援中才算接管(初始 prompt 的入队不算,
          // 否则每个 turn 的第一次入队就会把续命全关掉)。
          if (inRescue(String(data.sessionID ?? ""))) {
            stopped.add(String(data.sessionID))
            console.log(`[quota-retry] ${data.sessionID} 用户接管, 停止续命`)
          }
          return
        }
        if (type === "session.execution.started") {
          // 新执行开始: 清掉上一 turn 的失败残留 —— 否则本轮若未经 step.failed 直接失败
          // (drain 级错误), 幂等键会指向旧消息, 撞上旧标记被误判"已续过"而静默不唤醒。
          const startedSid = String(data.sessionID ?? "")
          lastFailure.delete(startedSid)
          lastFailureMessage.delete(startedSid)
          return
        }
        if (type === "session.step.failed") {
          const err = data?.error
          if (err && data?.sessionID) {
            lastFailure.set(String(data.sessionID), {
              type: String(err.type ?? ""),
              status: typeof err.status === "number" ? err.status : undefined,
              message: String(err.message ?? ""),
            })
            // 记下失败 step 的消息 id: execution.failed 事件里没有它,
            // 续命标记要用它做幂等键(同一次失败 → 同一个 id)。
            if (data.assistantMessageID) lastFailureMessage.set(String(data.sessionID), String(data.assistantMessageID))
          }
          return
        }
        if (type === "session.execution.interrupted") {
          stopped.add(data.sessionID)
          yield* disarmHeartbeat(String(data.sessionID ?? ""), "interrupted")
          return
        }
        if (type === "session.step.started") {
          // 等待结束、步骤已开始 → 不再需要心跳(下一次等待会重新 arm)
          yield* disarmHeartbeat(String(data.sessionID ?? ""), "step.started")
          return
        }
        if (type === "session.retry.scheduled") {
          // 重试已排定(durable, 带绝对时刻 at) → 按剩余等待 arm 长等待心跳。
          // 必须在这里而不是 retry hook: 宿主排定重试的同一流程里会先发 step.started,
          // 在 hook 里 arm 会被随后的 step.started 删掉(实测: arm 后同秒被 disarm, 心跳永不发)。
          const sid = String(data.sessionID ?? "")
          const at = Number(data.at)
          if (sid && Number.isFinite(at)) {
            yield* armHeartbeat(sid, at - Date.now())
          }
          return
        }
        if (type === "session.execution.succeeded") {
          yield* resetSession(data.sessionID) // turn 完成: 轮次状态清零(新 turn 重新计轮)
          return
        }
        if (type !== "session.execution.failed") return
        const sid = String(data.sessionID ?? "")
        if (!sid || stopped.has(sid)) return
        // 失败即等待结束: 先停心跳(续命后会由新的 retry.scheduled 重新 arm)。
        yield* disarmHeartbeat(sid, "execution.failed")
        // 续命触发: 配额救援中, 或失败错误命中续命策略(可重试类型 / 429+5xx / 自定义 match)。
        const failure = data.error ?? lastFailure.get(sid)
        if (!inRescue(sid) && !shouldContinue(failure, cfg?.continueOn)) return
        const n = (rounds.get(sid) ?? 0) + 1
        if (maxRounds >= 0 && n > maxRounds) {
          console.log(`[quota-retry] ${sid} 达到轮数上限 ${maxRounds}, 停止续命`)
          return
        }
        rounds.set(sid, n)
        yield* redoRound(sid, n)
      })

    const handleEvent = (ev: any) =>
      handleEventInner(ev).pipe(
        Effect.catch((err) =>
          Effect.sync(() => dbg("[event] handler ERROR:", String((err as any)?.stack ?? err).slice(0, 250))),
        ),
      )

    yield* ctx.event
      .subscribe()
      .pipe(Stream.runForEach((ev) => handleEvent(ev)), Effect.forkScoped({ startImmediately: true }))

    // ── 状态报告 ──
    const statusReport = (sessionID?: string): string => {
      const lines = ["[quota-retry] status", ""]
      if (expanded.size === 0) lines.push("未匹配到任何 provider。配置: ~/.config/opencode/quota-retry.jsonc")
      for (const [id, p] of expanded) {
        lines.push(`  ${id}  quota=${p.quota}${p.idPattern ? `  (idPattern=${p.idPattern})` : ""}`)
      }
      if ((cfg.providers ?? []).length > 0 && expanded.size === 0)
        lines.push("  有配置但未命中运行时 providerID(检查 id / idPattern)")
      if (sessionID && rounds.has(sessionID))
        lines.push("", `  当前 turn 已续命 ${rounds.get(sessionID)} 轮(每轮 = 原生 10 次重试)`)
      lines.push("", "语义: 无限轮次续命, 每轮 10 次原生重试, 每次等待不封顶(可等到配额重置)。")
      lines.push("续命触发: 默认 = 可重试错误类型 + 429/5xx; 可用 continueOn.types/statuses/match 覆盖, denyTypes 排除。")
      return lines.join("\n")
    }

    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "quota-retry-status",
        description: "读取 quota-retry 配置与匹配到的 provider(只读, 无副作用)。",
        input: Schema.Struct({}),
        execute: () =>
          Effect.gen(function* () {
            yield* refreshExpanded
            return { content: statusReport() }
          }),
      })
    })

    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "retry-setting",
        description: "查看 quota-retry 配置与匹配状态(零模型, 直接回写会话)",
        execute: (input) =>
          Effect.gen(function* () {
            yield* refreshExpanded
            const sessionID = String(input?.sessionID ?? "")
            if (!sessionID) return
            yield* ctx.session
              .synthetic({
                sessionID: sessionID as any,
                id: `${MESSAGE_ID_PREFIX}-status-${Date.now().toString(36)}` as any,
                description: `quota-retry · status (${[...expanded.keys()].length} providers)`,
                text: statusReport(sessionID),
                // 命令回复只给用户看: 不唤醒模型回合, 也不进模型请求(context hook 按 id 剥)
                resume: false,
              })
              .pipe(Effect.asVoid, Effect.catch(() => Effect.void))
          }),
      })
    })

    // 卸载: effect 形态不需要显式 cleanup——hook 注册与心跳 fiber 都挂在插件 Scope 上,
    // 插件卸载时 Scope 关闭, 全部自动清理(与 opencode 自己的插件一致)。
  }),
})
