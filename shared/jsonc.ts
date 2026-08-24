// JSONC 配置读取(jsonc-parser, VS Code 同款; 替代各插件自带的手写剥离逻辑)

import { existsSync, readFileSync } from "node:fs"
import { parse as parseJsonc } from "jsonc-parser"

// 读取并解析 JSONC 文件。
// 不存在 → undefined; 解析失败 → log 后 undefined(调用方走安全默认, 不 crash 宿主)。
export function loadJsonc<T>(file: string, tag: string): T | undefined {
  if (!existsSync(file)) return undefined
  try {
    const text = readFileSync(file, "utf8")
    const errors: unknown[] = []
    const value = parseJsonc(text, errors, { allowTrailingComma: true }) as T
    if (errors.length > 0) throw new Error(`${errors.length} parse error(s)`)
    return value
  } catch (err) {
    console.error(`[${tag}] config parse failed: ${file}`, err)
    return undefined
  }
}
