// session-reaper: pipeline session 治理插件
//
// 目的:
//   scheduled pipeline 会话(OpenChamber schedule / opencode run 发起)每次运行
//   都产生一个主 session + 数十个 subagent 子会话, 无人治理时 opencode.db
//   无限膨胀(实测 3 个月 12GB)。本插件把「登记 + 清理」内化到 opencode 进程内:
//   pipeline 运行时自报身份, 清理在下次运行时自动发生, 无外部 cron。
//
// 命令(config hook 注册, 安装即有):
//   /session-reaper run --pipeline <name> <原始prompt>
//       执行: reap 超期 → register 当前 sessionID → agent 收到逐字原样的 prompt
//   /session-reaper status
//       查看各 pipeline 桶状态与超期项(零模型)
//   /session-reaper set --pipeline <name> [--keep-days N] [--max-sessions M] [--remove]
//       配置 upsert / 查看 / 删除(零模型)
//   /session-reaper reap --pipeline <name>
//       立即清理该 pipeline 并报告(零模型)
//
// 参数约定: flags(--pipeline/--keep-days/--max-sessions/--remove)只在开头识别,
// 其余全部视为 prompt(裸拼接, prompt 以 -- 开头的概率为零)。
//
// 配置 ~/.config/opencode/session-reaper.jsonc:
//   { "defaultKeepDays": 30, "defaultMaxSessions": 10,
//     "pipelines": { "twitter-daily": { "keepDays": 10, "maxSessions": 10 } } }
//   未配置的 pipeline 用 default*; default 也未设 → 只登记不清理(安全默认)。
//   set 命令会重写该文件(注释丢失, 归程序管)。
//
// 零模型路径(同 quota-retry /retry-setting): 本地生成报告 → noReply+ignored
// 消息写入会话(可回看不触发模型) → 抛哨兵中断模型轮次。
//
// 闭包边界(不改什么):
//   - 只治理通过 /session-reaper run 显式声明的会话; 手动/其他会话零打扰
//   - 删除幂等: HTTP 404 视为已清理, 从桶中移除
//   - 删除失败(网络等): 保留在桶中下次重试, 不阻塞 register
//   - registry 原子写(tmp+rename); 损坏时备份重建, 不 crash 宿主
//   - 不读 session 内容, 只按 registry 账本删除

import { readFileSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { loadJsonc } from "../shared/jsonc"
import { atomicWrite } from "../shared/fsutil"
import { replyLocal as replyLocalImpl } from "../shared/reply"
import { configDir, stateDir } from "../shared/paths"
import { gateActive } from "../shared/gate"
import { maybeSync } from "../shared/sync"

const COMMAND = "session-reaper"
const SENTINEL = "__SESSION_REAPER_HANDLED__"

type PipelineRule = { keepDays?: number; maxSessions?: number }
type ReaperConfig = {
  registryPath?: string
  defaultKeepDays?: number
  defaultMaxSessions?: number
  logKeep?: number
  pipelines?: Record<string, PipelineRule>
}
type Entry = { id: string; created: number }
type Registry = Record<string, Entry[]>
type Parsed = {
  action?: string
  pipeline?: string
  keepDays?: number
  maxSessions?: number
  remove?: boolean
  prompt?: string
}

function configPath(): string {
  return path.join(configDir(), "opencode", "session-reaper.jsonc")
}

function defaultRegistryPath(): string {
  return path.join(stateDir(), "opencode", "session-reaper", "registry.json")
}

function loadConfig(): ReaperConfig {
  return loadJsonc<ReaperConfig>(configPath(), "session-reaper") ?? {}
}

function saveConfig(cfg: ReaperConfig): void {
  atomicWrite(configPath(), JSON.stringify(cfg, null, 2))
}

function registryFileOf(cfg: ReaperConfig): string {
  return cfg.registryPath
    ? cfg.registryPath.replace(/^~/, homedir())
    : defaultRegistryPath()
}

function loadRegistry(file: string): Registry {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Registry
  } catch (err: any) {
    if (err?.code === "ENOENT") return {}
    console.error(`[session-reaper] registry unreadable, resetting: ${file}`, err)
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {}
    return {}
  }
}

function saveRegistry(file: string, reg: Registry): void {
  atomicWrite(file, JSON.stringify(reg, null, 2))
}

// 行为日志: jsonl 追加, 保留最近 logKeep 条(默认 100, 0 = 关闭), 与 registry 同目录
type LogEntry = {
  ts: number
  event: "run" | "reap" | "set"
  pipeline: string
  sessionID?: string
  registered?: string
  expired?: number
  overflow?: number
  reaped?: string[]
  failed?: string[]
  bucket?: number
  change?: Record<string, unknown> | "remove"
}

function appendLog(cfg: ReaperConfig, registryFile: string, entry: LogEntry): void {
  const keep = cfg.logKeep ?? 100
  if (keep <= 0) return
  const file = path.join(path.dirname(registryFile), "log.jsonl")
  let lines: string[] = []
  try {
    lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.error(`[session-reaper] log unreadable, resetting: ${file}`, err)
      try {
        renameSync(file, `${file}.corrupt-${Date.now()}`)
      } catch {}
    }
  }
  lines.push(JSON.stringify(entry))
  atomicWrite(file, lines.slice(-keep).join("\n") + "\n")
}

async function deleteSession(serverUrl: URL, sessionID: string): Promise<boolean> {
  const headers: Record<string, string> = {}
  const user = process.env.OPENCODE_SERVER_USERNAME
  const pass = process.env.OPENCODE_SERVER_PASSWORD
  if (user && pass) {
    headers.authorization = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64")
  }
  const url = new URL(`/session/${encodeURIComponent(sessionID)}`, serverUrl)
  try {
    const res = await fetch(url, { method: "DELETE", headers })
    return res.ok || res.status === 404
  } catch (err) {
    console.error(`[session-reaper] delete ${sessionID} failed:`, err)
    return false
  }
}

// flags 只在开头贪婪识别, 剩余全部是 prompt
function parseArgs(raw: string): Parsed {
  const res: Parsed = {}
  let rest = raw.trim()
  if (!rest) return res
  const head = rest.match(/^(\S+)\s*([\s\S]*)$/)
  if (!head) return res
  res.action = head[1]
  rest = head[2].trim()
  for (;;) {
    let m: RegExpMatchArray | null
    if ((m = rest.match(/^--pipeline[=\s]+(\S+)\s*/))) {
      res.pipeline = m[1]
      rest = rest.slice(m[0].length)
      continue
    }
    if ((m = rest.match(/^--keep-days[=\s]+(\S+)\s*/))) {
      res.keepDays = Number(m[1])
      rest = rest.slice(m[0].length)
      continue
    }
    if ((m = rest.match(/^--max-sessions[=\s]+(\S+)\s*/))) {
      res.maxSessions = Number(m[1])
      rest = rest.slice(m[0].length)
      continue
    }
    if ((m = rest.match(/^--remove(?:\s+|$)/))) {
      res.remove = true
      rest = rest.slice(m[0].length)
      continue
    }
    break
  }
  res.prompt = rest
  return res
}

function effectiveRule(cfg: ReaperConfig, pipeline: string): Required<PipelineRule> & { explicit: boolean } {
  const rule = cfg.pipelines?.[pipeline]
  if (rule && (rule.keepDays !== undefined || rule.maxSessions !== undefined)) {
    return {
      keepDays: rule.keepDays ?? cfg.defaultKeepDays as number,
      maxSessions: rule.maxSessions ?? cfg.defaultMaxSessions as number,
      explicit: true,
    }
  }
  return { keepDays: cfg.defaultKeepDays as number, maxSessions: cfg.defaultMaxSessions as number, explicit: false }
}

function ageText(created: number, now: number): string {
  return `${((now - created) / 86400_000).toFixed(1)}d`
}

// reap 一个 pipeline 的桶; 过期与溢出分别列出, 删除成功/失败分开记录
async function reapBucket(
  serverUrl: URL,
  reg: Registry,
  pipeline: string,
  rule: { keepDays?: number; maxSessions?: number },
): Promise<{ expired: Entry[]; overflow: Entry[]; reaped: Entry[]; failed: Entry[]; survivors: Entry[] }> {
  const bucket = [...(reg[pipeline] ?? [])].sort((a, b) => a.created - b.created)
  const now = Date.now()
  const expired = bucket.filter(
    (e) => rule.keepDays !== undefined && now - e.created >= rule.keepDays * 86400_000,
  )
  let survivors = bucket.filter(
    (e) => rule.keepDays === undefined || now - e.created < rule.keepDays * 86400_000,
  )
  let overflow: Entry[] = []
  if (rule.maxSessions !== undefined && survivors.length > rule.maxSessions) {
    overflow = survivors.slice(0, survivors.length - rule.maxSessions)
    survivors = survivors.slice(survivors.length - rule.maxSessions)
  }
  const reaped: Entry[] = []
  const failed: Entry[] = []
  for (const e of [...expired, ...overflow]) {
    if (await deleteSession(serverUrl, e.id)) reaped.push(e)
    else failed.push(e)
  }
  return { expired, overflow, reaped, failed, survivors }
}

function statusReport(cfg: ReaperConfig, reg: Registry): string {
  const now = Date.now()
  const lines: string[] = ["[session-reaper] status", ""]
  const pipelines = new Set([...Object.keys(reg), ...Object.keys(cfg.pipelines ?? {})])
  if (pipelines.size === 0) {
    lines.push("无已登记的 pipeline。配置: ~/.config/opencode/session-reaper.jsonc")
    return lines.join("\n")
  }
  for (const p of [...pipelines].sort()) {
    const rule = effectiveRule(cfg, p)
    const bucket = [...(reg[p] ?? [])].sort((a, b) => b.created - a.created)
    const src = rule.explicit ? "显式配置" : "default 兜底"
    const kd = rule.keepDays !== undefined && !Number.isNaN(rule.keepDays) ? `${rule.keepDays}d` : "不清理"
    const ms = rule.maxSessions !== undefined && !Number.isNaN(rule.maxSessions) ? String(rule.maxSessions) : "不限"
    lines.push(`${p}  keepDays=${kd} maxSessions=${ms} (${src}) — ${bucket.length} sessions`)
    for (const e of bucket) {
      const expired = rule.keepDays !== undefined && now - e.created >= rule.keepDays * 86400_000
      lines.push(`  ${e.id}  ${ageText(e.created, now)}${expired ? "  ← 超期，下次 run/reap 时清理" : ""}`)
    }
  }
  lines.push("")
  lines.push(`registry: ${registryFileOf(cfg)}`)
  return lines.join("\n")
}

const USAGE = `[session-reaper] 用法:
  /session-reaper run --pipeline <name> <原始prompt>   以 pipeline 身份执行任务(prompt 原样透传)
  /session-reaper status                               查看各 pipeline 桶状态与超期项
  /session-reaper set --pipeline <name> [--keep-days N] [--max-sessions M] [--remove]
                                                      配置 upsert(不带修改参数=查看)
  /session-reaper reap --pipeline <name>               立即清理该 pipeline`

export const sessionReaper = async (input: any) => {
  if (!gateActive("session-reaper")) return {}
  const serverUrl = new URL("/", input.serverUrl ?? "http://127.0.0.1:4096/")

  // 零模型回复: noReply+ignored 消息写入会话后抛哨兵中断模型轮次
  const replyLocal = (sessionID: string, text: string): Promise<never> =>
    replyLocalImpl(input.client, sessionID, text, SENTINEL)

  // 自更新: 节流 + opencode 原生补装(见 shared/sync.ts), 平行于业务逻辑不阻塞
  void maybeSync((title, message) => {
    try {
      input.client?.tui?.showToast?.({ body: { title, message, duration: 5000 } })
    } catch {}
  })

  return {
    // /session-reaper command 由插件自身注册(安装即有, 无独立 command 文件)。
    // 模板 $ARGUMENTS 仅兜底(老版本 opencode 无 hook 时); 实际分派与 prompt
    // 改写都在 command.execute.before hook 内完成。
    config: (ocCfg: any) => {
      ocCfg.command = ocCfg.command ?? {}
      ocCfg.command[COMMAND] = {
        description: "pipeline session 治理：run(执行+登记) / status(状态) / set(配置) / reap(清理)",
        template: "$ARGUMENTS",
      }
    },

    "command.execute.before": async (
      inp: { command: string; sessionID: string; arguments?: string },
      out: { parts?: Array<{ type: string; text?: string }> },
    ) => {
      if (inp?.command !== COMMAND || !inp.sessionID) return
      const parsed = parseArgs(inp.arguments ?? "")
      const cfg = loadConfig()
      const registryFile = registryFileOf(cfg)

      // ---- 无 action / 未知 action: 用法提示(零模型) ----
      if (!parsed.action || !["run", "status", "set", "reap"].includes(parsed.action)) {
        await replyLocal(inp.sessionID, parsed.action ? `[session-reaper] 未知 action: ${parsed.action}\n\n${USAGE}` : USAGE)
      }

      // ---- run: reap + register + prompt 逐字透传 ----
      if (parsed.action === "run") {
        if (!parsed.pipeline) {
          await replyLocal(inp.sessionID, `[session-reaper] run 需要 --pipeline <name>\n\n${USAGE}`)
        }
        const rule = effectiveRule(cfg, parsed.pipeline!)
        const reg = loadRegistry(registryFile)
        const { expired, overflow, reaped, failed, survivors } = await reapBucket(serverUrl, reg, parsed.pipeline!, rule)
        for (const e of reaped) console.log(`[session-reaper] reaped ${parsed.pipeline} ${e.id}`)
        const now = Date.now()
        const kept = [...survivors, ...failed]
          .filter((e) => e.id !== inp.sessionID)
          .sort((a, b) => a.created - b.created)
        kept.push({ id: inp.sessionID, created: now })
        reg[parsed.pipeline!] = kept
        saveRegistry(registryFile, reg)
        appendLog(cfg, registryFile, {
          ts: now,
          event: "run",
          pipeline: parsed.pipeline!,
          sessionID: inp.sessionID,
          registered: inp.sessionID,
          expired: expired.length,
          overflow: overflow.length,
          reaped: reaped.map((e) => e.id),
          failed: failed.map((e) => e.id),
          bucket: kept.length,
        })
        console.log(`[session-reaper] registered ${parsed.pipeline} ${inp.sessionID} (bucket=${kept.length})`)
        // agent 看到的 prompt 与原始完全一致: 剥掉 action/flags, 剩余原样
        const parts = out?.parts
        if (Array.isArray(parts) && parsed.prompt) {
          parts.length = 0
          parts.push({ type: "text", text: parsed.prompt })
        }
        return
      }

      // ---- status: 桶状态报告(零模型) ----
      if (parsed.action === "status") {
        await replyLocal(inp.sessionID, statusReport(cfg, loadRegistry(registryFile)))
      }

      // ---- set: 配置 upsert / 查看 / 删除(零模型) ----
      if (parsed.action === "set") {
        if (!parsed.pipeline) {
          await replyLocal(inp.sessionID, `[session-reaper] set 需要 --pipeline <name>\n\n${USAGE}`)
        }
        const name = parsed.pipeline!
        if (parsed.remove) {
          if (cfg.pipelines?.[name] !== undefined) {
            delete cfg.pipelines[name]
            saveConfig(cfg)
            appendLog(cfg, registryFile, {
              ts: Date.now(),
              event: "set",
              pipeline: name,
              sessionID: inp.sessionID,
              change: "remove",
            })
            await replyLocal(inp.sessionID, `[session-reaper] 已删除 ${name} 的显式配置(回落 default*)`)
          } else {
            await replyLocal(inp.sessionID, `[session-reaper] ${name} 无显式配置，无需删除`)
          }
        }
        const bad: string[] = []
        if (parsed.keepDays !== undefined && (!Number.isInteger(parsed.keepDays) || parsed.keepDays < 0))
          bad.push("--keep-days 需为非负整数")
        if (parsed.maxSessions !== undefined && (!Number.isInteger(parsed.maxSessions) || parsed.maxSessions < 0))
          bad.push("--max-sessions 需为非负整数")
        if (bad.length) await replyLocal(inp.sessionID, `[session-reaper] 参数错误: ${bad.join("; ")}`)
        if (parsed.keepDays !== undefined || parsed.maxSessions !== undefined) {
          cfg.pipelines = cfg.pipelines ?? {}
          const cur = cfg.pipelines[name] ?? {}
          cfg.pipelines[name] = {
            ...cur,
            ...(parsed.keepDays !== undefined ? { keepDays: parsed.keepDays } : {}),
            ...(parsed.maxSessions !== undefined ? { maxSessions: parsed.maxSessions } : {}),
          }
          saveConfig(cfg)
          appendLog(cfg, registryFile, {
            ts: Date.now(),
            event: "set",
            pipeline: name,
            sessionID: inp.sessionID,
            change: {
              ...(parsed.keepDays !== undefined ? { keepDays: parsed.keepDays } : {}),
              ...(parsed.maxSessions !== undefined ? { maxSessions: parsed.maxSessions } : {}),
            },
          })
          await replyLocal(
            inp.sessionID,
            `[session-reaper] ${name} 配置已更新: keepDays=${cfg.pipelines[name].keepDays ?? "(未设)"} maxSessions=${cfg.pipelines[name].maxSessions ?? "(未设)"}`,
          )
        }
        // 无修改参数 = 查看当前生效配置
        const rule = effectiveRule(loadConfig(), name)
        await replyLocal(
          inp.sessionID,
          `[session-reaper] ${name}: keepDays=${rule.keepDays ?? "不清理"} maxSessions=${rule.maxSessions ?? "不限"} (${rule.explicit ? "显式配置" : "default 兜底"})\n改变行为: /session-reaper set --pipeline ${name} --keep-days N --max-sessions M`,
        )
      }

      // ---- reap: 立即清理并报告(零模型) ----
      if (parsed.action === "reap") {
        if (!parsed.pipeline) {
          await replyLocal(inp.sessionID, `[session-reaper] reap 需要 --pipeline <name>\n\n${USAGE}`)
        }
        const rule = effectiveRule(cfg, parsed.pipeline!)
        const reg = loadRegistry(registryFile)
        const { expired, overflow, reaped, failed, survivors } = await reapBucket(serverUrl, reg, parsed.pipeline!, rule)
        reg[parsed.pipeline!] = [...survivors, ...failed]
        saveRegistry(registryFile, reg)
        appendLog(cfg, registryFile, {
          ts: Date.now(),
          event: "reap",
          pipeline: parsed.pipeline!,
          sessionID: inp.sessionID,
          expired: expired.length,
          overflow: overflow.length,
          reaped: reaped.map((e) => e.id),
          failed: failed.map((e) => e.id),
          bucket: survivors.length + failed.length,
        })
        const lines = [`[session-reaper] reap ${parsed.pipeline}: 删除 ${reaped.length}, 失败 ${failed.length}, 存活 ${survivors.length}`]
        for (const e of reaped) lines.push(`  已删除 ${e.id} (${ageText(e.created, Date.now())})`)
        for (const e of failed) lines.push(`  删除失败(保留重试) ${e.id}`)
        await replyLocal(inp.sessionID, lines.join("\n"))
      }
    },

    "shell.env": async (inp: { sessionID?: string }, out: { env: Record<string, string> }) => {
      if (inp?.sessionID) out.env.OPENCODE_SESSION_ID = inp.sessionID
    },
  }
}

