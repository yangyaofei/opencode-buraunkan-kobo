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
//   ✅ quota_retry_status 工具 / retry-setting 命令(零模型回复)
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
          id: `${MESSAGE_ID_PREFIX}-heartbeat-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}` as any,
          text: `${HEARTBEAT_TEXT_PREFIX}${Math.random().toString(36).slice(2, 10)}`,
          description: `${MARKER_PREFIX} heartbeat · 内部标记(不发给模型)`,
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
        yield* disarmHeartbeat(sid, "succeeded")
      })

    // ── 部件 3: 出口净化 — 剥掉尾部"轮次标记"映射出的 user 消息 ──
    // 只认标记文本前缀(前缀+随机 token), 不按"空"判定: 空 user 可能是用户真的发了 ""。
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
    // synthetic 在请求里会变成 user 消息; 在 context hook(HTTP 序列化之前)按 id 前缀整段丢掉,
    // 模型永远看不到轮次标记/心跳/retry-setting 回复。旧实现的 id 同前缀, 一并覆盖。
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
        // 标记 text = 前缀 + 随机 token: 出口按前缀精确剥掉(不靠"空"判定),
        // description 前台可见, id 自指定便于定位。
        const markerID = `${MESSAGE_ID_PREFIX}-round-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        const markerText = `${MARKER_TEXT_PREFIX}${Math.random().toString(36).slice(2, 10)}`
        yield* ctx.session
          .synthetic({
            sessionID: sessionID as any,
            id: markerID as any,
            text: markerText,
            description: `${MARKER_PREFIX} round · 第 ${round} 轮`,
          })
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => console.log(`[quota-retry] ${sessionID} 第 ${round} 轮续命(原生 10 次重试重新计数)`)),
            ),
            Effect.catch((err) =>
              Effect.sync(() => dbg("[round] synthetic FAIL:", String((err as any)?.message ?? err).slice(0, 140))),
            ),
          )
      })

    // ── 事件流: 续命判定 + 心跳 arm/disarm + 状态清零 ──
    const handleEventInner = (ev: any) =>
      Effect.gen(function* () {
        const type = ev?.type
        const data = ev?.data ?? ev
        // 事件流是全 location 广播(每个实例都收到): 只处理本实例自己 location 的事件。
        // 否则同一个会话会被每个实例各处理一遍(重复心跳 / 重复续命 / 重复标记——
        // 实测 3 个 location 实例 = 3 条重复标记)。会话事件都带 location 信封
        // (bus.publish 从发布者上下文的 Location.Service 取), 无 location 的全局事件与本插件无关。
        const evLoc = String(ev?.location?.directory ?? "")
        if (evLoc !== String(ctx.location?.directory ?? "")) return
        if (type === "session.inbox.enqueued" && data?.item?.type === "user") {
          // 用户接管: 仅在本 turn 已处于续命救援中才算接管(初始 prompt 的入队不算,
          // 否则每个 turn 的第一次入队就会把续命全关掉)。
          if (inRescue(String(data.sessionID ?? ""))) {
            stopped.add(String(data.sessionID))
            console.log(`[quota-retry] ${data.sessionID} 用户接管, 停止续命`)
          }
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
        name: "quota_retry_status",
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
                text: statusReport(sessionID),
              })
              .pipe(Effect.asVoid, Effect.catch(() => Effect.void))
          }),
      })
    })

    // 卸载: effect 形态不需要显式 cleanup——hook 注册与心跳 fiber 都挂在插件 Scope 上,
    // 插件卸载时 Scope 关闭, 全部自动清理(与 opencode 自己的插件一致)。
  }),
})
