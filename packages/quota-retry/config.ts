// quota-retry 2.0 (spike) — 配置加载: 项目 .opencode/ 优先, 全局兜底。

import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { PluginConfig } from "./core"

// 零依赖 JSONC 解析: 纯 JSON 直接 parse, 失败则剥离行/块注释与尾逗号后重试。
// (容器/无 node_modules 环境下 jsonc-parser 不可达; 配置文件本身是纯 JSON)
function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {}
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^\s*|[^:"'\w])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1")
  return JSON.parse(stripped)
}

export function globalConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(xdg, "opencode", "quota-retry.jsonc")
}

export function loadConfig(projectDir: string): PluginConfig {
  const candidates = [path.join(projectDir, ".opencode", "quota-retry.jsonc"), globalConfigPath()]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const parsed = parseJsonc(readFileSync(file, "utf8")) as PluginConfig
      if (parsed && typeof parsed === "object") return parsed
    } catch {}
  }
  return { providers: [] }
}
