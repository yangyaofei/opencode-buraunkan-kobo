// quota-retry 运行日志: 默认常开, 固定路径 + 容量上限。
// 用途: 出事(例如"第一次失败没被识别为配额")时能直接看到每个 hook 收到了什么、
// 判定结果与算出的等待 —— 不必再依赖现场是否还在。
import { appendFileSync, mkdirSync, statSync, truncateSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// 容量上限: 超过就先清空再写(保留最新内容, 避免无限增长)
export const LOG_CAP_BYTES = 512 * 1024

export function defaultLogFile(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")
  return path.join(base, "opencode", "buraunkan", "quota-retry.log")
}

// 追加一行(带 HH:MM:SS 前缀)。任何失败都静默(日志不能影响主流程)。
export function appendLogLine(file: string, line: string, capBytes: number = LOG_CAP_BYTES): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    try {
      if (statSync(file).size > capBytes) truncateSync(file, 0)
    } catch {}
    appendFileSync(file, new Date().toISOString().slice(11, 19) + " " + line + "\n")
  } catch {}
}
