// quota-retry 2.0 — 插件入口(正式版)。
//
// 加载契约(packages/core/src/plugin/module.ts): 本地目录插件的默认导出必须是
// { id, setup } 或 { id, effect }。这里用 Promise 形态的 setup。
//
// 机制(三个部件, 全部经 Docker 实测验证):
//   1. 轮内等待 — session.http.response hook 抓 429 body + session.retry hook
//      写 decision = { retry: true, delay }。原生 runner 执行重试, TUI 显示原生
//      徽标("⚠ Retrying in Ns · attempt N"), 延迟不封顶。
//   2. 轮次续命 — 原生 10 次耗尽后(core 硬编码 recurs(10)), 从事件流收到
//      execution.failed: 注入 text="" 的 synthetic 通知行(description = 可见
//      轮次)。空 synthetic 经 inbox 驱动新执行 = 全新 10 次原生重试。无限轮。
//      代价(已接受): 不删失败现场, 每轮累积一条失败 assistant + 一条标记。
//   3. 出口净化 — session.http.request hook 剥掉空 synthetic 在出站请求里映射的
//      尾部空 user 消息。
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
//   ✅ on-demand 降级链(config stub 挂载组 + http hook 链改写 + 死亡标记)

import { appendFileSync, mkdirSync } from "node:fs"
import {
  computeWaitMs,
  expandOnDemand,
  expandProviders,
  isQuotaError,
  isQuotaText,
  markDead,
  pickHop,
  parseResetAtMs,
  readProviderApiKeys,
  stripTrailingEmptyUsers,
  xdgDataDir,
  zhipuResetAtMs,
  DEFAULT_QUOTA_CACHE_MS,
  DEFAULT_FALLBACK_WAIT_MS,
  type PluginConfig,
  type ProviderConfig,
} from "./core"
import { loadConfig } from "./config"

// 只声明本插件用到的 Context 子集, 避免仓库内安装 @opencode/plugin 依赖。
type Ctx = {
  location: { directory: string }
  session: {
    hook: (name: string, cb: (evt: any) => any) => Promise<{ dispose: () => Promise<void> }>
    synthetic: (input: { sessionID: string; id?: string; text: string; description?: string }) => Promise<unknown>
  }
  provider: {
    list: () => Promise<ReadonlyArray<any>>
    transform: (cb: (editor: any) => void) => Promise<unknown>
  }
  command: { transform: (cb: (editor: { add: (def: any) => void }) => void) => Promise<unknown> }
  tool: { transform: (cb: (editor: { add: (def: any) => void }) => void) => Promise<unknown> }
  event: { subscribe: () => AsyncIterable<any> }
}

const MARKER_PREFIX = "quota-retry"
const DEBUG_LOG = "/tmp/quota-retry-debug.log"

function dbg(...a: any[]) {
  if (process.env.QUOTA_RETRY_DEBUG !== "1") return
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")
  try {
    mkdirSync("/tmp", { recursive: true })
    appendFileSync(DEBUG_LOG, new Date().toISOString().slice(11, 19) + " " + line + "\n")
  } catch {}
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

export default {
  id: "quota-retry",
  setup: async (ctx: Ctx) => {
    const projectDir = ctx.location?.directory ?? process.cwd()
    const cfg = loadConfig(projectDir)
    const quotaCacheMs = cfg.quotaCacheMs ?? DEFAULT_QUOTA_CACHE_MS
    const maxRounds = cfg.maxRounds ?? Number(process.env.QUOTA_RETRY_MAX_ROUNDS ?? -1)

    // 运行时 providerID → 配置: setup 时先算一次, 之后按需刷新。
    let expanded = expandProviders(cfg, [])
    const refreshExpanded = async () => {
      try {
        expanded = expandProviders(cfg, providerIdsOf(await ctx.provider.list()))
      } catch {}
    }
    await refreshExpanded()

    // ── on-demand 虚模型降级链(1.x onDemandModels 移植) ──
    const onDemand = expandOnDemand((cfg as any).onDemandModels)
    const odReloadTries = new Map<string, number>()
    // 链跳 apiKey 解析优先级: 显式配置 > opencode.db credential 表(2.x 无 HTTP 路由交回 key)
    let credKeys: Record<string, string> | null = null
    const hopApiKey = (provider: string | undefined, explicit?: string) => {
      if (explicit) return explicit
      if (!provider) return undefined
      if (credKeys === null) {
        try {
          credKeys = readProviderApiKeys(xdgDataDir())
        } catch {
          credKeys = null
        }
      }
      return credKeys?.[provider] ?? authCache.get(provider)
    }
    dbg(`[boot] loaded: pid=${process.pid} providers=${(cfg.providers ?? []).length} onDemand=${onDemand.length} maxRounds=${maxRounds}`)
    // 挂载组不在此创建: 插件 provider.add 只支持 native 包契约(@opencode/ai/providers/* 的
    // model(modelID, settings) 导出), 而 native 通道不挂插件 http/retry hook 且 2.0.15 有未知缺陷
    // (429 → error{type:"unknown", message:"Invalid Date"}, 分类/重试/hook 全部失效)。
    // aisdk 通道(npm:@ai-sdk/openai-compatible, hook 全通)只能由 config 声明进入——
    // 因此挂载组由用户在 opencode.jsonc 里声明(npm:@ai-sdk/openai-compatible + 链首跳 baseURL),
    // 插件负责运行时链改写(http.request)与配额死亡标记(http.response)。

    // ── on-demand HTTP 链运行时(挂 http.request/http.response hook, 均为已验证可用的通道) ──
    // 每会话: 链死亡时刻表 + 最近一次请求用的跳(供 http.response 归因)
    const chainStates = new Map<string, { deadUntil: Map<number, number>; lastHop: number }>()
    const chainOf = (providerID: string, modelID: string) =>
      onDemand.find((m) => m.provider === providerID && m.model === modelID)
    const stateOf = (sid: string) => {
      let st = chainStates.get(sid)
      if (!st) {
        st = { deadUntil: new Map(), lastHop: 0 }
        chainStates.set(sid, st)
      }
      return st
    }
    // http.request: 虚模型请求按链状态改写到活跳(改 URL/Authorization/body.model)
    const chainRewrite = async (evt: any) => {
      const providerID = String(evt?.model?.providerID ?? "")
      const modelID = String(evt?.model?.id ?? evt?.model?.modelID ?? "")
      const virtual = chainOf(providerID, modelID)
      if (!virtual || virtual.chain.length === 0) return
      const st = stateOf(String(evt.sessionID ?? ""))
      const hop = pickHop(virtual.chain, st)
      st.lastHop = hop
      if (hop === 0) return // 链首活: 请求本就指向链首(挂载组 baseURL), 无需改写
      const entry = virtual.chain[hop]
      try {
        const orig = evt.request as Request
        const u = new URL(orig.url)
        const b = new URL(entry.baseURL)
        const basePath = b.pathname.replace(/\/$/, "")
        const suffix = u.pathname.startsWith(basePath) ? u.pathname.slice(basePath.length) : u.pathname
        const body: any = JSON.parse(await orig.clone().text())
        const next = JSON.stringify({ ...body, model: entry.model })
        const rewritten = new Request(b.origin + basePath + suffix, {
          method: orig.method,
          headers: new Headers(orig.headers),
          body: orig.method === "GET" || orig.method === "HEAD" ? undefined : next,
        })
        const hopKey = hopApiKey(entry.provider, entry.apiKey)
        if (hopKey) rewritten.headers.set("authorization", `Bearer ${hopKey}`)
        evt.request = rewritten
        dbg(`[on-demand] ${providerID}/${modelID} 第 ${hop + 1} 跳改写 → ${entry.baseURL} model=${entry.model}`)
      } catch (err) {
        dbg("[on-demand] 改写失败(裸请求照发):", String(err))
      }
    }

    // ── 会话内状态 ──
    const recent429 = new Map<string, { at: number; text: string }>() // sid -> 最近 429 body
    const zhipuCache = new Map<string, { at: number; resetAt: number }>() // providerID -> 精确重置时刻缓存
    const rounds = new Map<string, number>() // sid -> 当前 turn 已续命轮数
    const stopped = new Set<string>() // 用户接管/中断后不再续命
    const quotaHit = new Set<string>() // retry hook 判定过配额的会话(轮次触发条件)
    // providerID -> 出站 Authorization 头(zhipu 配额查询的 apiKey 回退来源, 对齐 1.x)
    const authCache = new Map<string, string>()

    const resetSession = (sid: string) => {
      rounds.delete(sid)
      stopped.delete(sid)
      quotaHit.delete(sid)
    }

    // ── 部件 3: 出口净化 — 剥掉尾部空 user 消息(轮次标记的映射残留) ──
    await ctx.session.hook("http.request", async (evt: any) => {
      try {
        const req: Request = evt.request
        const providerID = String(evt?.model?.providerID ?? "")
        if (providerID) {
          const auth = req.headers.get("authorization")
          if (auth) authCache.set(providerID, auth.replace(/^Bearer\s+/i, ""))
        }
        // 注意: 这里只能用嵌套块, 不能 return — return 会跳过尾部的 chainRewrite(虚模型链改写),
        // 同一轮原生重试全部漏改写(实测卡死在第 1 跳)。
        if (req.method === "POST") {
          const body: any = await req.clone().json().catch(() => null)
          if (body && Array.isArray(body.messages) && body.messages.length > 0) {
            const stripped = stripTrailingEmptyUsers(body.messages)
            if (stripped) {
              const headers = new Headers(req.headers)
              headers.delete("content-length")
              evt.request = new Request(req, { method: "POST", headers, body: JSON.stringify({ ...body, messages: stripped }) })
              dbg("[strip] removed trailing empty user message(s)")
            }
          }
        }
      } catch (err) {
        dbg("[strip] error:", String(err))
      }
      try {
        await chainRewrite(evt)
      } catch (err) {
        dbg("[on-demand] rewrite error:", String(err))
      }
    })

    // ── 部件 1a 前置: 续命期间压制 title 重生成(空标记驱动的新执行会触发它, 浪费一次请求) ──
    await ctx.session.hook("title", async (evt: any) => {
      const sessionID = String(evt?.sessionID ?? "")
      if (!sessionID || !quotaHit.has(sessionID)) return
      // 一律置空跳过 title 模型请求(续命期间 title 保持原值)
      evt.result = ""
    })

    // ── 部件 1a: 抓 429 body(retry 事件的 error 不带 body, 需从 http.response 捕获) ──
    await ctx.session.hook("http.response", async (evt: any) => {
      try {
        if (evt?.response?.status !== 429) return
        dbg("[resp-hook] 429:", evt?.model?.providerID, evt?.kind)
        let text = ""
        try {
          text = await evt.response.clone().text()
          recent429.set(String(evt.sessionID), { at: Date.now(), text })
        } catch (err) {
          dbg("[resp-hook] clone/text err:", String(err))
        }
        // on-demand: 虚模型链当前跳配额耗尽 → 标记死亡到 reset 时刻, 下次请求改写下一跳。
        // 整段必须自捕获: http.response hook 在请求管线内运行, 未捕获异常会杀死该请求
        // 并把原始 429 变形为 unclassified 错误(实测 error{type:"unknown", message:"Invalid Date"}),
        // 分类/重试/hook 全部失效。
        const providerID = String(evt?.model?.providerID ?? "")
        const modelID = String(evt?.model?.id ?? evt?.model?.modelID ?? "")
        const virtual = chainOf(providerID, modelID)
        if (virtual && text) {
          const p = expanded.get(virtual.chain[0].provider ?? "")
          if (isQuotaText(text, p?.quotaMatch) || isQuotaText(text)) {
            const st = stateOf(String(evt.sessionID ?? ""))
            // parseResetAtMs 无匹配返回 NaN(不是 null), ?? 兜不住, 必须 isFinite 显式判
            const parsed = parseResetAtMs(text, p?.resetExtract)
            const resetAt = Number.isFinite(parsed)
              ? parsed
              : Date.now() + (p?.fallbackWaitMs ?? DEFAULT_FALLBACK_WAIT_MS)
            markDead(virtual.chain, st, st.lastHop, resetAt + (p?.bufferMs ?? 0))
            dbg(`[on-demand] 第 ${st.lastHop + 1} 跳配额耗尽, 死亡至 ${new Date(resetAt).toISOString()}`)
          }
        }
      } catch (err) {
        dbg("[resp-hook] handler ERROR:", String(err?.stack ?? err).slice(0, 200))
      }
    })

    // ── 部件 1b: 轮内精确等待(原生徽标, delay 不封顶) ──
    await ctx.session.hook("retry", async (evt: any) => {
      const sessionID = String(evt?.sessionID ?? "")
      const providerID = String(evt?.model?.providerID ?? "")
      dbg("[retry-hook] fired:", providerID, String(evt?.error?.type ?? ""), String(evt?.error?.message ?? "").slice(0, 60))
      const p = expanded.get(providerID)
      const type = evt?.error?.type
      const message = String(evt?.error?.message ?? "")
      if (!isQuotaError(type, message, p?.quotaMatch)) return

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
      if (!Number.isFinite(resetAtMs)) {
        const captured = recent429.get(sessionID)
        if (captured) resetAtMs = parseResetAtMs(captured.text, p?.resetExtract)
      }
      const delay = computeWaitMs({ now, resetAtMs, bufferMs: p?.bufferMs, fallbackWaitMs: p?.fallbackWaitMs })
      evt.decision = { retry: true, delay }
      console.log(`[quota-retry] ${providerID} 配额耗尽(attempt=${evt?.attempt}), ${humanWait(delay)}后重试`)
    })

    // ── 部件 2: 轮次续命 — 10 次耗尽 → 空标记驱动新一轮(纯插件 API, 零进程外依赖) ──
    // 代价(已接受): 不删失败现场, 每轮累积一条失败 assistant + 一条标记(界面噪音);
    // 发给模型的请求由出口 strip 保持干净(空 user 剥除)。
    const redoRound = async (sessionID: string, round: number) => {
      // 空标记: description 前台可见, text="" 是驱动执行的载体(出口剥掉)。
      const markerID = `msg_${MARKER_PREFIX}_r${round}_${Date.now().toString(36)}`
      try {
        await ctx.session.synthetic({
          sessionID,
          id: markerID,
          text: "",
          description: `${MARKER_PREFIX} · 第 ${round} 轮 · 内部标记(不发给模型)`,
        })
      } catch (err: any) {
        dbg("[round] synthetic FAIL:", String(err?.message ?? err).slice(0, 140))
        return
      }
      console.log(`[quota-retry] ${sessionID} 第 ${round} 轮续命(原生 10 次重试重新计数)`)
    }

    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe()) {
          try {
            const type = (ev as any).type
            const data = (ev as any).data ?? ev
            if (type === "session.inbox.enqueued" && data?.item?.type === "user") {
              // 用户接管: 仅在本 turn 已处于配额救援中才算接管(初始 prompt 的入队不算,
              // 否则每个 turn 的第一次入队就会把续命全关掉)。
              if (quotaHit.has(String(data.sessionID ?? ""))) {
                stopped.add(String(data.sessionID))
                console.log(`[quota-retry] ${data.sessionID} 用户接管, 停止续命`)
              }
              continue
            }
            if (type === "session.step.failed") {
              dbg("[ev] step.failed:", JSON.stringify(data).slice(0, 300))
              continue
            }
            if (type === "session.execution.failed") {
              dbg("[ev] execution.failed:", JSON.stringify(data).slice(0, 300))
            }
            if (type === "session.execution.interrupted") {
              stopped.add(data.sessionID)
              continue
            }
            if (type === "session.execution.succeeded") {
              resetSession(data.sessionID) // turn 完成: 轮次状态清零(新 turn 重新计轮)
              continue
            }
            if (type !== "session.execution.failed") continue
            const sid = String(data.sessionID ?? "")
            if (!sid || stopped.has(sid) || !quotaHit.has(sid)) continue
            const n = (rounds.get(sid) ?? 0) + 1
            if (maxRounds >= 0 && n > maxRounds) {
              console.log(`[quota-retry] ${sid} 达到轮数上限 ${maxRounds}, 停止续命`)
              continue
            }
            rounds.set(sid, n)
            await redoRound(sid, n)
          } catch (err: any) {
            dbg("[event] handler ERROR:", String(err?.stack ?? err).slice(0, 250))
          }
        }
      } catch (err: any) {
        dbg("[event] subscribe ERROR:", String(err))
      }
    })()

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
      return lines.join("\n")
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "quota_retry_status",
        description: "读取 quota-retry 配置与匹配到的 provider(只读, 无副作用)。",
        execute: async () => {
          await refreshExpanded()
          return statusReport()
        },
      })
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "retry-setting",
        description: "查看 quota-retry 配置与匹配状态(零模型, 直接回写会话)",
        execute: async (input: any) => {
          await refreshExpanded()
          const sessionID = String(input?.sessionID ?? "")
          if (!sessionID) return
          await ctx.session.synthetic({ sessionID, text: statusReport(sessionID) })
        },
      })
    })

    // 卸载: setup 返回 cleanup(2.0 由宿主在插件卸载时调用)
    return () => {
      recent429.clear()
      zhipuCache.clear()
      rounds.clear()
      stopped.clear()
      quotaHit.clear()
    }
  },
}
