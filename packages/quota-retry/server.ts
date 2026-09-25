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
//      execution.failed: revert 删掉(上轮内部标记 ?? 失败 assistant), 再注入
//      text="" 的 synthetic 通知行(description = 可见轮次)。空 synthetic 经
//      inbox 驱动新执行 = 全新 10 次原生重试。无限轮。
//   3. 出口净化 — session.http.request hook 剥掉空 synthetic 在出站请求里映射的
//      尾部空 user 消息, 第 2+ 轮请求与原始 turn 字节级一致。
//
// 部署约束(README 详述): 部件 2 的 revert 没有插件 API, 走本地 HTTP。要求
// opencode 以 `OPENCODE_PASSWORD=xxx opencode serve --port <port>` 运行, 客户端
// (TUI `--server`) 连接该 serve; 插件从环境变量读同一密码。
//
// 1.x 功能对照:
//   ✅ 配额识别(quotaMatch/resetExtract/zhipu API 精确重置)
//   ✅ 无限等待(decision.delay 无封顶)
//   ✅ 无限次数(轮次续命, 每轮原生 10 次; 1.x 靠二进制补丁, 2.0 出货二进制核心
//      chunk 是 JSC bytecode, 明文补丁无效 — 已实验证明)
//   ✅ TUI 可见性(原生徽标 + 每轮覆写的通知行 "quota-retry · 第 N 轮")
//   ✅ quota_retry_status 工具 / retry-setting 命令(零模型回复)
//   ❌ on-demand 降级链: 后续版本用 aisdk hook 设计实现

import { appendFileSync, mkdirSync } from "node:fs"
import {
  computeWaitMs,
  expandProviders,
  isQuotaError,
  parseResetAtMs,
  stripTrailingEmptyUsers,
  zhipuResetAtMs,
  DEFAULT_QUOTA_CACHE_MS,
  type PluginConfig,
  type ProviderConfig,
} from "./core"
import { loadConfig } from "./config"

// 只声明本插件用到的 Context 子集, 避免仓库内安装 @opencode/plugin 依赖。
type Ctx = {
  location: { directory: string }
  session: {
    hook: (name: string, cb: (evt: any) => any) => Promise<{ dispose: () => Promise<void> }>
    synthetic: (input: { sessionID: string; text: string; description?: string }) => Promise<unknown>
  }
  provider: { list: () => Promise<ReadonlyArray<any>> }
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
    const serverPort = cfg.serverPort ?? Number(process.env.RETRY_SERVER_PORT ?? 18082)

    const apiBase = `http://127.0.0.1:${serverPort}`
    const authHeaders = () => ({
      "content-type": "application/json",
      authorization: "Basic " + Buffer.from("opencode:" + (process.env.OPENCODE_PASSWORD ?? "")).toString("base64"),
    })

    // 运行时 providerID → 配置: setup 时先算一次, 之后按需刷新。
    let expanded = expandProviders(cfg, [])
    const refreshExpanded = async () => {
      try {
        expanded = expandProviders(cfg, providerIdsOf(await ctx.provider.list()))
      } catch {}
    }
    await refreshExpanded()

    // ── 会话内状态 ──
    const recent429 = new Map<string, { at: number; text: string }>() // sid -> 最近 429 body
    const zhipuCache = new Map<string, { at: number; resetAt: number }>() // providerID -> 精确重置时刻缓存
    const rounds = new Map<string, number>() // sid -> 当前 turn 已续命轮数
    const failedAssistant = new Map<string, string>() // sid -> 失败 assistantMessageID(下轮 stage 目标)
    const lastMarker = new Map<string, string>() // sid -> 上轮 synthetic 标记消息 id(下轮 stage 目标)
    const stopped = new Set<string>() // 用户接管/中断后不再续命
    const quotaHit = new Set<string>() // retry hook 判定过配额的会话(轮次触发条件)
    // providerID -> 出站 Authorization 头(zhipu 配额查询的 apiKey 回退来源, 对齐 1.x)
    const authCache = new Map<string, string>()

    const resetSession = (sid: string) => {
      rounds.delete(sid)
      failedAssistant.delete(sid)
      lastMarker.delete(sid)
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
        if (req.method !== "POST") return
        const body: any = await req.clone().json().catch(() => null)
        if (!body || !Array.isArray(body.messages) || body.messages.length === 0) return
        const stripped = stripTrailingEmptyUsers(body.messages)
        if (!stripped) return
        const headers = new Headers(req.headers)
        headers.delete("content-length")
        evt.request = new Request(req, { method: "POST", headers, body: JSON.stringify({ ...body, messages: stripped }) })
        dbg("[strip] removed trailing empty user message(s)")
      } catch (err) {
        dbg("[strip] error:", String(err))
      }
    })

    // ── 部件 1a 前置: 续命期间压制 title 重生成(空标记驱动的新执行会触发它, 浪费一次请求) ──
    await ctx.session.hook("title", async (evt: any) => {
      const sessionID = String(evt?.sessionID ?? "")
      if (!sessionID || !quotaHit.has(sessionID)) return
      try {
        const info = await (await fetch(`${apiBase}/api/session/${sessionID}`, { headers: authHeaders() })).json()
        const title = info?.data?.title
        // 续命期间一律跳过 title 重生成: 有标题用标题, 没有就置空(省一次注定 429 的请求)
        evt.result = typeof title === "string" ? title : ""
      } catch (e) { dbg("[title] fetch err:", String(e)) }
    })

    // ── 部件 1a: 抓 429 body(retry 事件的 error 不带 body, 需从 http.response 捕获) ──
    await ctx.session.hook("http.response", async (evt: any) => {
      if (evt?.response?.status !== 429) return
      try {
        const text = await evt.response.clone().text()
        recent429.set(String(evt.sessionID), { at: Date.now(), text })
      } catch {}
    })

    // ── 部件 1b: 轮内精确等待(原生徽标, delay 不封顶) ──
    await ctx.session.hook("retry", async (evt: any) => {
      const sessionID = String(evt?.sessionID ?? "")
      const providerID = String(evt?.model?.providerID ?? "")
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

    // ── 部件 2: 轮次续命 — 10 次耗尽 → revert + 空标记 → 新一轮 ──
    const redoRound = async (sessionID: string, round: number) => {
      const target = lastMarker.get(sessionID) ?? failedAssistant.get(sessionID)
      if (!target) {
        dbg("[round] no stage target cached, skip")
        return
      }
      // stage 语义 = 删除 messageID 及其后所有。第 1 轮删失败 assistant;
      // 第 2+ 轮删上一轮标记(连同其后新失败 assistant 一起, 标记恒一条)。
      let stageRes = await fetch(`${apiBase}/api/session/${sessionID}/revert/stage`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ messageID: target }),
      })
      for (let tries = 0; !stageRes.ok && tries < 3; tries++) {
        await new Promise((r) => setTimeout(r, 150))
        stageRes = await fetch(`${apiBase}/api/session/${sessionID}/revert/stage`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ messageID: target }),
        })
      }
      if (!stageRes.ok) {
        dbg("[round] stage FAIL:", stageRes.status, (await stageRes.text()).slice(0, 120))
        return
      }
      const commitRes = await fetch(`${apiBase}/api/session/${sessionID}/revert/commit`, {
        method: "POST",
        headers: authHeaders(),
      })
      if (commitRes.status !== 204) {
        dbg("[round] commit FAIL:", commitRes.status)
        return
      }
      // 空标记: description 前台可见(每轮覆写), text="" 是驱动执行的载体(出口剥掉)。
      try {
        await ctx.session.synthetic({
          sessionID,
          text: "",
          description: `${MARKER_PREFIX} · 第 ${round} 轮 · 内部标记(不发给模型)`,
        })
      } catch (err: any) {
        dbg("[round] synthetic FAIL:", String(err?.message ?? err).slice(0, 140))
        return
      }
      // 插件事件流收不到 session.synthetic(实测), 用 export 捕获标记消息 id 供下轮 stage。
      try {
        const exp = await (await fetch(`${apiBase}/api/experimental/session/${sessionID}/export`, { headers: authHeaders() })).json()
        for (let k = (exp?.data?.messages ?? []).length - 1; k >= 0; k--) {
          const m = exp.data.messages[k]
          if (m.type === "synthetic" && String(m.description ?? "").startsWith(MARKER_PREFIX)) {
            lastMarker.set(sessionID, m.id)
            break
          }
        }
      } catch {}
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
              const fid = data?.assistantMessageID
              if (fid) failedAssistant.set(data.sessionID, fid)
              continue
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
      failedAssistant.clear()
      lastMarker.clear()
      stopped.clear()
      quotaHit.clear()
    }
  },
}
