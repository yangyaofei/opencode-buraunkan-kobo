// catalog-bridge 2.0 — 配置加载: 项目 .opencode/ 优先, 全局兜底。
//
// 目前只有一个键：
//   preferredProviders: 追加到内置优先列表后面的 provider 名称。
// 查找顺序 = 内置优先(opencode / opencode-go / zhipuai / deepseek) + 这里配置的
// provider，仍找不到才回退到"按目录顺序取第一个有效条目"。

import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export type CatalogBridgeConfig = {
  preferredProviders?: string[]
}

// 零依赖 JSONC 解析: 纯 JSON 直接 parse, 失败则剥离行/块注释与尾逗号后重试。
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
  return path.join(xdg, "opencode", "catalog-bridge.jsonc")
}

export function loadConfig(projectDir?: string): CatalogBridgeConfig {
  const candidates = [
    projectDir ? path.join(projectDir, ".opencode", "catalog-bridge.jsonc") : undefined,
    globalConfigPath(),
  ].filter((file): file is string => !!file)
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const parsed = parseJsonc(readFileSync(file, "utf8")) as CatalogBridgeConfig
      if (parsed && typeof parsed === "object") return parsed
    } catch {}
  }
  return {}
}
