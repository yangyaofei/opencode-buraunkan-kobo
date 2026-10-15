// session-reaper 2.0 — 纯逻辑层(可单测): 参数解析 / 规则 / 清理计划 / 报告 / 持久化。
//
// 目的(与 1.x 相同): scheduled pipeline 会话(OpenChamber schedule / opencode run
// 发起)每次运行产生一个主 session + 数十个 subagent 子会话, 无人治理时 opencode.db
// 无限膨胀。本插件把「登记 + 清理」内化到 opencode 进程内。
//
// 2.0 与 1.x 的差异:
//   - 命令分派: 1.x 拦截 command.execute.before + 改写 parts; 2.0 命令 execute 由
//     插件直接执行, 零模型回复用 session.synthetic(不再需要哨兵异常)。
//   - 会话删除: 2.0 插件 API 未暴露 session.remove(host/adapter 均未桥接), 通过
//     子进程 `opencode session delete <id>` 兜底(后台服务模式下可用), 失败保留
//     下次重试 — 与 1.x 的失败语义一致。
//   - shell.env 注入 OPENCODE_SESSION_ID: 2.0 的 shell.create.before hook 不携带
//     sessionID, 无法映射, 已移除(该变量仅辅助用途)。

import { readFileSync, renameSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type PipelineRule = { keepDays?: number; maxSessions?: number }
export type ReaperConfig = {
  registryPath?: string
  defaultKeepDays?: number
  defaultMaxSessions?: number
  logKeep?: number
  pipelines?: Record<string, PipelineRule>
}
export type Entry = { id: string; created: number }
export type Registry = Record<string, Entry[]>
export type Parsed = {
  action?: string
  pipeline?: string
  keepDays?: number
  maxSessions?: number
  remove?: boolean
  prompt?: string
}

// 零依赖 JSONC 解析(同 quota-retry/config.ts)
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {}
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^\s*|[^:"'\w])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1")
  return JSON.parse(stripped)
}

export function configDir(): string {
  return process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config")
}

export function stateDir(): string {
  return process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state")
}

export function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(tmp, content, "utf8")
  renameSync(tmp, file)
}

export function projectConfigPath(projectDir: string): string {
  return path.join(projectDir, ".opencode", "session-reaper.jsonc")
}

export function globalConfigPath(): string {
  return path.join(configDir(), "opencode", "session-reaper.jsonc")
}

export function defaultRegistryPath(): string {
  return path.join(stateDir(), "opencode", "session-reaper", "registry.json")
}

export function loadConfig(projectDir: string): ReaperConfig {
  for (const file of [projectConfigPath(projectDir), globalConfigPath()]) {
    if (!existsSync(file)) continue
    try {
      const parsed = parseJsonc(readFileSync(file, "utf8")) as ReaperConfig
      if (parsed && typeof parsed === "object") return parsed
    } catch {}
  }
  return {}
}

export function saveConfig(cfg: ReaperConfig): void {
  atomicWrite(globalConfigPath(), JSON.stringify(cfg, null, 2))
}

export function registryFileOf(cfg: ReaperConfig): string {
  return cfg.registryPath ? cfg.registryPath.replace(/^~/, homedir()) : defaultRegistryPath()
}

export function loadRegistry(file: string): Registry {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Registry
  } catch (err: any) {
    if (err?.code === "ENOENT") return {}
    console.error(`[session-reaper] registry unreadable, resetting: ${file}`, err?.message ?? err)
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {}
    return {}
  }
}

export function saveRegistry(file: string, reg: Registry): void {
  atomicWrite(file, JSON.stringify(reg, null, 2))
}

// 行为日志: jsonl 追加, 保留最近 logKeep 条(默认 100, 0 = 关闭), 与 registry 同目录
export type LogEntry = {
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

export function appendLog(cfg: ReaperConfig, registryFile: string, entry: LogEntry): void {
  const keep = cfg.logKeep ?? 100
  if (keep <= 0) return
  const file = path.join(path.dirname(registryFile), "log.jsonl")
  let lines: string[] = []
  try {
    lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.error(`[session-reaper] log unreadable, resetting: ${file}`, err?.message ?? err)
      try {
        renameSync(file, `${file}.corrupt-${Date.now()}`)
      } catch {}
    }
  }
  lines.push(JSON.stringify(entry))
  atomicWrite(file, lines.slice(-keep).join("\n") + "\n")
}

// flags 只在开头贪婪识别, 剩余全部是 prompt(裸拼接, prompt 以 -- 开头的概率为零)
export function parseArgs(raw: string): Parsed {
  const res: Parsed = {}
  let rest = raw.trim()
  if (!rest) return res
  // 防御: 若调用方把命令名一并传入, 先剥掉
  rest = rest.replace(/^\/?session-reaper\b\s*/, "")
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

export function effectiveRule(cfg: ReaperConfig, pipeline: string): Required<PipelineRule> & { explicit: boolean } {
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

export function ageText(created: number, now: number): string {
  return `${((now - created) / 86400_000).toFixed(1)}d`
}

// 纯清理计划: 过期(keepDays) 与溢出(maxSessions) 分别列出, 不执行删除
export function planReap(
  reg: Registry,
  pipeline: string,
  rule: { keepDays?: number; maxSessions?: number },
  now = Date.now(),
): { expired: Entry[]; overflow: Entry[]; survivors: Entry[] } {
  const bucket = [...(reg[pipeline] ?? [])].sort((a, b) => a.created - b.created)
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
  return { expired, overflow, survivors }
}

export function statusReport(cfg: ReaperConfig, reg: Registry, registryFile: string): string {
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
  lines.push(`registry: ${registryFile}`)
  return lines.join("\n")
}

export const USAGE = `[session-reaper] 用法:
  /session-reaper run --pipeline <name> <原始prompt>   以 pipeline 身份执行任务(prompt 原样透传)
  /session-reaper status                               查看各 pipeline 桶状态与超期项
  /session-reaper set --pipeline <name> [--keep-days N] [--max-sessions M] [--remove]
                                                       配置 upsert(不带修改参数=查看)
  /session-reaper reap --pipeline <name>               立即清理该 pipeline`
