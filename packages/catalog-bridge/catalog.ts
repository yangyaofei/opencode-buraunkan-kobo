// catalog-bridge 2.0 — 纯逻辑层(可单测): models.dev 目录加载 + 1.x catalog → 2.0 Model.Info 翻译。
//
// 问题(与 1.x 相同): 自定义 providerID(如 volces-ark / litellm)不在 models.dev,
// 其下模型的 limit/cost/capabilities 等全空, TUI 显示为 0。
//
// 2.0 数据源变化: 1.x 读 opencode 缓存文件 ~/.cache/opencode/models.json; 2.0 把
// models.dev 目录存进了内部 kv(opencode.db), 插件不可达。本插件改为自行拉取
// https://models.dev/api.json 并落自己的缓存(24h TTL), 兼容读取旧 models.json。
//
// 2.0 字段翻译(1.x models.dev 格式 → packages/schema/src/model.ts 的 Model.Info):
//   limit{context,output[,input]}   ← limit (直译)
//   cost: [{input, output, cache{read,write}}] ← cost{input,output,cache_read,cache_write}
//   capabilities{tools,input,output}  ← tool_call + modalities
//   family                          ← family
//   time.released (epoch 秒)        ← release_date "YYYY-MM-DD"
//   status (枚举)                   ← status (仅映射合法枚举值)
//   variants: [{id, settings{reasoningEffort}}] ← reasoning_options effort (仅
//     @ai-sdk/openai-compatible, 参数名同 1.x)
//   1.x 的 reasoning/temperature/interleaved/experimental 在 2.0 无对应字段, 不迁移。
//
// 覆盖策略(同 1.x "只补缺失"): 2.0 未配置的模型带静态默认值(limit 200k/32k,
// capabilities 默认, cost 空), 检测到"仍是默认值"才用 catalog 填充。

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

type CatalogModel = {
  limit: { context: number; input?: number; output: number }
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number }
  reasoning?: boolean
  tool_call?: boolean
  attachment?: boolean
  temperature?: boolean
  family?: string
  release_date?: string
  interleaved?: { field: string } | true
  modalities?: { input?: string[]; output?: string[] }
  status?: string
  experimental?: boolean
  reasoning_options?: Array<{ type: string; values?: (string | null)[] }>
}

export type Catalog = Record<string, { models?: Record<string, CatalogModel> }>

export function cacheDir(): string {
  return process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache")
}

export function ownCachePath(): string {
  return path.join(cacheDir(), "opencode", "buraunkan", "models-dev.json")
}

export function legacyCachePath(): string {
  return path.join(cacheDir(), "opencode", "models.json")
}

const CACHE_TTL_MS = 24 * 3600_000

function readCachedCatalog(): { fetchedAt: number; body: Catalog } | null {
  const file = ownCachePath()
  if (!existsSync(file)) return null
  try {
    const cached = JSON.parse(readFileSync(file, "utf8")) as { fetchedAt: number; body: Catalog }
    if (cached.body && typeof cached.body === "object") return cached
  } catch {}
  return null
}

/** 同步读取目录: 优先磁盘缓存(带 TTL), 回退旧版 opencode 的 models.json。 */
export function loadCatalogSync(): Catalog | null {
  const cached = readCachedCatalog()
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.body
  if (existsSync(legacyCachePath())) {
    try {
      return JSON.parse(readFileSync(legacyCachePath(), "utf8")) as Catalog
    } catch {}
  }
  // 缓存存在但已过期: 仍返回旧数据(TTL 语义 = 每 boot 刷新一次), 由 refreshCatalog 异步更新
  return cached?.body ?? null
}

/** 异步刷新: 拉取 models.dev 并落盘(供下一次 transform 重放使用)。 */
export async function refreshCatalog(fetchImpl: typeof fetch = fetch): Promise<Catalog | null> {
  try {
    const res = await fetchImpl("https://models.dev/api.json")
    if (res.ok) {
      const body = (await res.json()) as Catalog
      mkdirSync(path.dirname(ownCachePath()), { recursive: true })
      writeFileSync(ownCachePath(), JSON.stringify({ fetchedAt: Date.now(), body }), "utf8")
      return body
    }
  } catch {}
  return readCachedCatalog()?.body ?? null
}

function isValid(m: any): m is CatalogModel {
  return !!(m && typeof m.limit?.context === "number" && m.limit.context > 0 && m.limit.output < m.limit.context)
}

// 优先 provider: 目录里字段完整、可信的条目（实测 reasoning_options/limit 无缺项）。
// 用户可在 catalog-bridge.jsonc 的 preferredProviders 里追加自己的优先 provider。
export const DEFAULT_PRIORITY_PROVIDERS = ["deepseek", "zhipuai", "opencode-go", "opencode"]

/** 合并默认优先列表与用户配置（去重、保序：默认在前，配置追加在后）。 */
export function mergePriority(extra?: readonly string[]): string[] {
  const out: string[] = []
  for (const id of [...DEFAULT_PRIORITY_PROVIDERS, ...(extra ?? [])]) {
    const pid = String(id ?? "").trim()
    if (!pid || out.includes(pid)) continue
    out.push(pid)
  }
  return out
}

// 按 modelID 取模型配置: 优先列表逐个查; 都没有则按目录原顺序取第一个有效数据。
export function findModelMeta(
  catalog: Catalog,
  modelID: string,
  priority: readonly string[] = DEFAULT_PRIORITY_PROVIDERS,
): CatalogModel | null {
  for (const pid of priority) {
    const m = catalog[pid]?.models?.[modelID]
    if (isValid(m)) return m
  }
  for (const provider of Object.values(catalog)) {
    const m = provider.models?.[modelID]
    if (isValid(m)) return m
  }
  return null
}

// 2.0 Model.Info 的静态默认值(packages/schema/src/model.ts Model.Info.pipe(statics))
export const MODEL_INFO_DEFAULTS = {
  limitContext: 200_000,
  limitOutput: 32_000,
  capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
} as const

export function isDefaultLimit(limit: { context: number; output: number }): boolean {
  return limit.context === MODEL_INFO_DEFAULTS.limitContext && limit.output === MODEL_INFO_DEFAULTS.limitOutput
}

export function isDefaultCapabilities(caps: { tools: boolean; input: string[]; output: string[] }): boolean {
  return (
    caps.tools === MODEL_INFO_DEFAULTS.capabilities.tools &&
    caps.input.length === MODEL_INFO_DEFAULTS.capabilities.input.length &&
    caps.input.every((v, i) => v === MODEL_INFO_DEFAULTS.capabilities.input[i]) &&
    caps.output.length === MODEL_INFO_DEFAULTS.capabilities.output.length &&
    caps.output.every((v, i) => v === MODEL_INFO_DEFAULTS.capabilities.output[i])
  )
}

/**
 * 平台为 openai-compatible 自动生成的默认 variants（low/medium/high）。
 * 这类值不是用户手写的，命中时应允许用目录里的真实选项覆盖；
 * 用户自定义的其它集合一律不动。
 */
export function isPlatformDefaultVariants(
  variants: Array<{ id: string; settings?: Record<string, unknown> }>,
): boolean {
  if (variants.length !== 3) return false
  const ids = variants.map((v) => String(v.id)).sort()
  if (ids.join(",") !== "high,low,medium") return false
  return variants.every((v) => v.settings?.reasoningEffort === String(v.id))
}

const STATUS_MAP: Record<string, "alpha" | "beta" | "deprecated"> = {
  alpha: "alpha",
  beta: "beta",
  deprecated: "deprecated",
  legacy: "deprecated",
}

// 将 catalog 元数据合并进 2.0 Model.Info(就地修改, 只填默认值)。
// pkg: provider 的包标识(2.0 为字符串, 如 '@opencode/ai/providers/openai-compatible';
//      兼容 1.x 形态 '@ai-sdk/openai-compatible')。
export function applyMeta(
  model: {
    limit: { context: number; input?: number; output: number }
    cost: Array<{ input: number; output: number; cache: { read: number; write: number } }>
    capabilities: { tools: boolean; input: string[]; output: string[] }
    variants: Array<{ id: string; settings?: Record<string, unknown> }>
    family?: string
    time: { released: number }
    status: string
  },
  meta: CatalogModel,
  pkg?: string,
): void {
  const isOpenAICompatible = typeof pkg === "string" && /openai-compatible/.test(pkg)
  if (isDefaultLimit(model.limit)) {
    model.limit = { context: meta.limit.context, output: meta.limit.output }
    if (meta.limit.input !== undefined) model.limit.input = meta.limit.input
  }
  if (model.cost.length === 0 && meta.cost) {
    model.cost = [
      {
        input: meta.cost.input,
        output: meta.cost.output,
        cache: { read: meta.cost.cache_read ?? 0, write: meta.cost.cache_write ?? 0 },
      },
    ]
  }
  if (isDefaultCapabilities(model.capabilities)) {
    model.capabilities = {
      tools: meta.tool_call ?? true,
      input: meta.modalities?.input ?? [...MODEL_INFO_DEFAULTS.capabilities.input],
      output: meta.modalities?.output ?? [...MODEL_INFO_DEFAULTS.capabilities.output],
    }
  }
  if (!model.family && meta.family) model.family = meta.family
  if (model.time.released === 0 && meta.release_date) {
    const ts = Date.parse(meta.release_date)
    if (Number.isFinite(ts)) model.time.released = Math.floor(ts / 1000)
  }
  if (model.status === "active" && meta.status) {
    const mapped = STATUS_MAP[meta.status]
    if (mapped) model.status = mapped
  }
  // variants: 从 reasoning_options effort 自动生成(仅 openai-compatible)。
  // 平台会给 openai-compatible 预生成 low/medium/high 默认集合；那不是用户手写的值，
  // 命中默认集合时用目录里的真实选项覆盖（用户自定义的其它集合不动）。
  if (
    (model.variants.length === 0 || isPlatformDefaultVariants(model.variants)) &&
    isOpenAICompatible &&
    meta.reasoning_options
  ) {
    const effort = meta.reasoning_options.find((o) => o.type === "effort")
    if (effort && Array.isArray(effort.values)) {
      model.variants = effort.values
        .filter((v): v is string => v !== null)
        .map((value) => ({ id: value, settings: { reasoningEffort: value } }))
    }
  }
}
