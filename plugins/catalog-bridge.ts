// catalog-bridge: 自定义 provider 的模型自动复用 models.dev 已收录模型的元数据
//
// 问题:
//   opencode 的 catalog 元数据匹配按 providerID 严格隔离 —— 自定义 providerID
//   (如 litellm/volces-ark) 不在 models.dev 里, 其下模型的 limit/cost/reasoning/
//   variants 等全部为空, TUI 显示为 0。
//
// 解决:
//   在 config 解析后、provider Store 构建前, 按 modelID(外层 key) 从 models.dev
//   取模型配置, 逐字段补全。用户已手写的字段不覆盖, 只补缺失的。
//
// 闭包边界(不改什么):
//   - model.id        保留用户自定义的真实 API id(如 vibe-bot/glm-5.2)
//   - provider.options baseURL/apiKey, endpoint 由用户自己配
//   - name            保留用户自定义的显示名(如 "GLM 5.2 (火山引擎 Ark)")

import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { cacheDir } from "../shared/paths"
import { gateActive } from "../shared/gate"
import { maybeSync } from "../shared/sync"

// models.dev 缓存路径(opencode models-dev.ts 默认落在 cache/opencode/models.json)
const MODELS_JSON_PATHS = [path.join(cacheDir(), "opencode", "models.json")]

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

type Catalog = Record<string, { models?: Record<string, CatalogModel> }>

function loadCatalog(): Catalog | null {
  for (const p of MODELS_JSON_PATHS) {
    if (!existsSync(p)) continue
    try {
      return JSON.parse(readFileSync(p, "utf8")) as Catalog
    } catch {}
  }
  return null
}

// 按 modelID 获取模型配置, 优先 opencode 官方 catalog(标准数据) > 厂商官方 > 第一个有效数据
function findModelMeta(catalog: Catalog, modelID: string): CatalogModel | null {
  const isvalid = (m: any): m is CatalogModel =>
    m && typeof m.limit?.context === "number" && m.limit.context > 0 && m.limit.output < m.limit.context

  for (const pid of ["opencode", "zhipuai", "deepseek"]) {
    const m = catalog[pid]?.models?.[modelID]
    if (isvalid(m)) return m
  }
  for (const provider of Object.values(catalog)) {
    const m = provider.models?.[modelID]
    if (isvalid(m)) return m
  }
  return null
}

// 从 reasoning_options 生成 variants (参考 opencode transform.ts reasoningEffort)
// 仅支持 @ai-sdk/openai-compatible(参数名 reasoningEffort); 其他 npm 包需用户手写 variants
function buildVariants(meta: CatalogModel, npm: string): Record<string, any> | null {
  if (!meta.reasoning_options || npm !== "@ai-sdk/openai-compatible") return null
  const effort = meta.reasoning_options.find((o) => o.type === "effort")
  if (!effort || !Array.isArray(effort.values)) return null

  const variants: Record<string, any> = {}
  for (const value of effort.values) {
    if (value === null) continue
    variants[value] = { reasoningEffort: value }
  }
  return Object.keys(variants).length > 0 ? variants : null
}

// 默认 effort: reasoning_options values 最后一个非 null(通常是最高的, 如 "max")
function defaultEffort(meta: CatalogModel): string | null {
  if (!meta.reasoning_options) return null
  const effort = meta.reasoning_options.find((o) => o.type === "effort")
  if (!effort || !Array.isArray(effort.values) || effort.values.length === 0) return null
  for (let i = effort.values.length - 1; i >= 0; i--) {
    if (effort.values[i] !== null) return effort.values[i] as string
  }
  return null
}

// 安装别名 = catalog-bridge; 别名不匹配的副本返回空 hooks(见 shared/gate.ts)
export const catalogBridge = async () => {
  if (!gateActive("catalog-bridge")) return {}
  void maybeSync(() => {})
  return {
    config: (cfg: any) => {
      const catalog = loadCatalog()
      if (!catalog || !cfg.provider) return

      for (const provider of Object.values(cfg.provider)) {
        const p = provider as any
        if (!p || typeof p !== "object" || !p.models) continue

        for (const [modelID, model] of Object.entries(p.models)) {
          const m = model as any
          if (!m || typeof m !== "object") continue

          const meta = findModelMeta(catalog, modelID)
          if (!meta) continue

          // limit
          if (!(m.limit && typeof m.limit.context === "number" && m.limit.context > 0)) {
            m.limit = { context: meta.limit.context, output: meta.limit.output }
            if (meta.limit.input !== undefined) m.limit.input = meta.limit.input
          }

          // cost
          if (!m.cost && meta.cost) {
            m.cost = {
              input: meta.cost.input,
              output: meta.cost.output,
              ...(meta.cost.cache_read !== undefined ? { cache_read: meta.cost.cache_read } : {}),
              ...(meta.cost.cache_write !== undefined ? { cache_write: meta.cost.cache_write } : {}),
            }
          }

          // capabilities
          if (m.reasoning === undefined && meta.reasoning !== undefined) m.reasoning = meta.reasoning
          if (m.tool_call === undefined && meta.tool_call !== undefined) m.tool_call = meta.tool_call
          if (m.attachment === undefined && meta.attachment !== undefined) m.attachment = meta.attachment
          if (m.temperature === undefined && meta.temperature !== undefined) m.temperature = meta.temperature

          // string fields
          if (!m.family && meta.family) m.family = meta.family
          if (!m.release_date && meta.release_date) m.release_date = meta.release_date

          // interleaved (reasoning 字段名)
          if (!m.interleaved && meta.interleaved) {
            m.interleaved = typeof meta.interleaved === "object" ? { ...meta.interleaved } : meta.interleaved
          }

          // modalities
          if (!m.modalities && meta.modalities) {
            m.modalities = {
              ...(meta.modalities.input ? { input: [...meta.modalities.input] } : {}),
              ...(meta.modalities.output ? { output: [...meta.modalities.output] } : {}),
            }
          }

          // status / experimental
          if (!m.status && meta.status) m.status = meta.status
          if (m.experimental === undefined && meta.experimental !== undefined) m.experimental = meta.experimental

          // variants: 从 reasoning_options 自动生成
          if (!m.variants || Object.keys(m.variants).length === 0) {
            const variants = buildVariants(meta, p.npm)
            if (variants) m.variants = variants
          }

          // 默认 reasoningEffort
          if (!m.options?.reasoningEffort) {
            const effort = defaultEffort(meta)
            if (effort) {
              if (!m.options) m.options = {}
              m.options.reasoningEffort = effort
            }
          }
        }
      }
    },
  }
}
