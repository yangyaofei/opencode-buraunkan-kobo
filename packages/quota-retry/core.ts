// quota-retry 2.0 (spike) — 纯逻辑层: 无 opencode 宿主依赖, 可独立单测。
//
// 这是 1.x plugins/quota-retry.ts 里"配额判定 + 重置时刻计算"部分的一比一移植,
// 剥掉了 fetch 注入/二进制补丁, 只保留能确定性计算、可测的部分。
// 2.0 的宿主接入见 server.ts: session.http.response 抓 429 body, session.retry 决定等待。

export type ProviderConfig = {
  // 匹配哪些 provider: 单个 ID、ID 数组; 配合 idPattern 可一条配置覆盖多个 provider
  id: string | string[]
  // 对 opencode 已配置的 providerID 做正则匹配(i 标志)
  idPattern?: string
  quota: "zhipu" | "body"
  quotaUrl?: string
  quotaMatch?: string
  resetExtract?: string
  fallbackWaitMs?: number
  bufferMs?: number
  apiKey?: string
}

export type PluginConfig = {
  providers?: ProviderConfig[]
  quotaCacheMs?: number
  // 轮次续命的轮数上限; -1 = 不限(默认)。每轮 = 原生 10 次重试。
  maxRounds?: number
  // opencode serve 的本地端口(revert 无插件 API, 只能走 HTTP; 见 README 部署约束)。
  serverPort?: number
}

export const DEFAULT_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
export const DEFAULT_FALLBACK_WAIT_MS = 30_000
export const DEFAULT_BUFFER_MS = 10_000
export const DEFAULT_QUOTA_CACHE_MS = 60_000
// 判定 429 是不是配额耗尽的默认正则(智谱+火山特征)
export const DEFAULT_QUOTA_MATCH = 'AccountQuotaExceeded|usage quota|使用上限|限额将在|"code"\\s*:\\s*"1308"'
// 从 body 提取重置时间的默认正则(捕获组 1 = 完整时间串)
export const DEFAULT_RESET_EXTRACT = "((?:\\d{4}-\\d{2}-\\d{2})[\\sT]\\d{2}:\\d{2}:\\d{2})"

// provider 条目展开: id 支持数组, idPattern 对现有 providerID 求命中。
// 同一 ID 命中多条配置时先到先得; idPattern 非法正则时整条跳过, 不产生半生效配置。
export function expandProviders(cfg: PluginConfig, existingProviderIds: string[]): Map<string, ProviderConfig> {
  const out = new Map<string, ProviderConfig>()
  for (const p of cfg.providers ?? []) {
    if (!p) continue
    const ids = new Set<string>()
    for (const id of Array.isArray(p.id) ? p.id : [p.id]) if (id) ids.add(id)
    if (p.idPattern) {
      try {
        const re = new RegExp(p.idPattern, "i")
        for (const pid of existingProviderIds) if (re.test(pid)) ids.add(pid)
      } catch {
        continue
      }
    }
    for (const id of ids) if (!out.has(id)) out.set(id, { ...p, id })
  }
  return out
}

export function isQuotaText(text: string, quotaMatch?: string): boolean {
  return new RegExp(quotaMatch ?? DEFAULT_QUOTA_MATCH, "i").test(text)
}

// 2.0 的 session.retry 事件只带 SessionError.Error = {type, message, status?}。
// type=="provider.quota" 视为配额; 否则再匹配 message(provider 原始错误文本)。
export function isQuotaError(type: string | undefined, message: string, quotaMatch?: string): boolean {
  if (type === "provider.quota") return true
  return isQuotaText(message, quotaMatch)
}

// 从 429 body 提取重置时刻(捕获组 1 = 完整时间串); 无时区后缀按 +08:00 解析。
// 返回绝对毫秒时间戳; 解析失败返回 NaN。
export function parseResetAtMs(text: string, resetExtract?: string): number {
  const re = new RegExp(resetExtract ?? DEFAULT_RESET_EXTRACT, "i")
  const s = text.match(re)?.[1]
  if (!s) return Number.NaN
  const base = /(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s.replace(" ", "T")}+08:00`
  return Date.parse(base)
}

// 等待时长 = (重置时刻 - now) + buffer; 拿不到精确重置时刻时用 fallbackWaitMs。
// 结果钳到 >= minWaitMs(默认 1s), 绝不为负/NaN。
export function computeWaitMs(opts: {
  now: number
  resetAtMs?: number
  bufferMs?: number
  fallbackWaitMs?: number
  minWaitMs?: number
}): number {
  const buffer = opts.bufferMs ?? DEFAULT_BUFFER_MS
  const fallback = opts.fallbackWaitMs ?? DEFAULT_FALLBACK_WAIT_MS
  const min = opts.minWaitMs ?? 1_000
  const base =
    opts.resetAtMs !== undefined && Number.isFinite(opts.resetAtMs)
      ? opts.resetAtMs - opts.now + buffer
      : fallback
  return Math.max(min, Math.ceil(base))
}

// 智谱配额 API: 取所有"已耗尽"限额里最早的重置时刻(绝对 ms); 失败返回 NaN。
// fetchImpl 可注入, 便于单测。
export async function zhipuResetAtMs(
  apiKey: string,
  opts: { quotaUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<number> {
  const quotaUrl = opts.quotaUrl ?? DEFAULT_QUOTA_URL
  const fetchImpl = opts.fetchImpl ?? fetch
  try {
    const res = await fetchImpl(quotaUrl, { headers: { Authorization: `Bearer ${apiKey}` } })
    if (!res.ok) return Number.NaN
    const body = (await res.json()) as {
      data?: { limits?: Array<{ percentage?: number; remaining?: number; nextResetTime?: number }> }
    }
    const limits = body?.data?.limits ?? []
    const exhausted = limits.filter((l) => (l.percentage ?? 0) >= 100 || (l.remaining ?? 1) <= 0)
    if (exhausted.length === 0) return Number.NaN
    const reset = Math.min(...exhausted.map((l) => l.nextResetTime ?? Infinity))
    return Number.isFinite(reset) ? reset : Number.NaN
  } catch {
    return Number.NaN
  }
}

// 出站请求体净化: 剥掉尾部"轮次标记"映射出的空 user 消息, 让第 2+ 轮请求与
// 原始 turn 字节级一致。空 = content 为空字符串或空数组(OpenAI 兼容两种形态)。
// 返回新数组; 无需剥离时返回 null(调用方保持原请求不动)。
export function stripTrailingEmptyUsers(messages: ReadonlyArray<{ role?: string; content?: unknown }>): unknown[] | null {
  const out = [...messages]
  let changed = false
  while (out.length > 0) {
    const last = out[out.length - 1] as { role?: string; content?: unknown }
    const isEmptyUser =
      last != null &&
      last.role === "user" &&
      (last.content === "" || (Array.isArray(last.content) && last.content.length === 0))
    if (!isEmptyUser) break
    out.pop()
    changed = true
  }
  return changed ? out : null
}

// ── on-demand 虚模型降级链(1.x onDemandModels 的 2.0 移植) ──

export type OnDemandChainEntry = {
  provider?: string // 跳的标识(仅用于配额匹配与展示)
  model: string // 该跳的真实 model id(写入请求体)
  baseURL: string // 该跳的 API 端点(http.request 改写目标)
  apiKey?: string // 该跳的鉴权(替换 Authorization)
  quotaMatch?: string // 该跳的配额特征(缺省用全局)
}

export type OnDemandModel = {
  model: string // 虚模型 ID(TUI 模型列表里出现)
  provider: string // 挂载的 opencode providerID
  name?: string
  npm?: string // 自动创建挂载组时用的 SDK 包, 默认 @ai-sdk/openai-compatible
  providerName?: string // 自动创建挂载组时的分组显示名
  // 挂载组自身的连接信息(=链首跳的 baseURL/apiKey)。
  // 2.0 外部插件的重放视图里 config 型 provider 排在后面, 运行时拿不到它们的 settings,
  // 因此挂载组连接必须显式声明(1.x 是从 config provider 自动继承的)。
  baseURL?: string // 挂载组自身连接(缺省取链首跳)
  apiKey?: string
  chain: OnDemandChainEntry[]
}

// 校验并展开 onDemandModels: chain 非空、model/provider 必填; 非法条目整条跳过。
export function expandOnDemand(list: OnDemandModel[] | undefined): OnDemandModel[] {
  const out: OnDemandModel[] = []
  for (const m of list ?? []) {
    if (!m || typeof m.model !== "string" || !m.model) continue
    if (!m.provider) continue
    const chain = (m.chain ?? []).filter((h) => h && typeof h.model === "string" && h.model !== "")
    if (chain.length === 0) continue
    const okChain = chain.every((h) => typeof h.baseURL === "string" && h.baseURL !== "")
    if (!okChain && typeof m.baseURL !== "string") continue
    out.push({ ...m, chain })
  }
  return out
}

// on-demand HTTP 链状态机: deadUntil 记录各跳配额死亡时刻, 选第一个活跳(全死时用最后一跳等原生重试轮次续命重扫)。
export type ChainState = { deadUntil: Map<number, number> }

export function pickHop(chain: OnDemandChainEntry[], state: ChainState, now = Date.now()): number {
  for (let i = 0; i < chain.length; i++) {
    const until = state.deadUntil.get(i) ?? 0
    if (now >= until) return i
  }
  return chain.length - 1
}

export function markDead(chain: OnDemandChainEntry[], state: ChainState, hop: number, resetAtMs: number) {
  if (hop < 0 || hop >= chain.length) return
  state.deadUntil.set(hop, Math.max(state.deadUntil.get(hop) ?? 0, resetAtMs))
}

// ── provider 凭据读取(opencode.db credential 表, 参考 OpenChamber credential-db.js) ──
// 2.x 没有 HTTP 路由交回 apiKey; 凭据存 <dataDir>/opencode.db 的 credential 表(明文 JSON)。
// 表结构以 v2.0.15 packages/core/src/credential/sql.ts 核实: integration_id/value/active/time_updated。
// 返回 {providerID → apiKey}; 读不到(SQLite 不可用/表不存在)返回 null(调用方回退显式配置)。
export function readProviderApiKeys(dataDir: string, env: { OPENCODE_DB?: string } = process.env): Record<string, string> | null {
  let Database: any
  try {
    Database = (globalThis as any).Bun !== undefined ? require("bun:sqlite").Database : undefined
  } catch {
    Database = undefined
  }
  if (!Database) return null
  const path = require("node:path") as typeof import("node:path")
  const fs = require("node:fs") as typeof import("node:fs")
  const configured = (env.OPENCODE_DB ?? "").trim()
  const dbPath = configured && configured !== ":memory:" ? path.resolve(dataDir, configured) : path.join(dataDir, "opencode.db")
  if (!fs.existsSync(dbPath)) return null
  let db: any
  try {
    db = new Database(dbPath, { readonly: true } as any)
    const rows = db
      .query(
        "SELECT integration_id, value FROM credential WHERE integration_id IS NOT NULL " +
          "ORDER BY integration_id, active DESC, time_updated DESC",
      )
      .all() as Array<{ integration_id: string; value: string }>
    const out: Record<string, string> = {}
    for (const row of rows) {
      const id = row?.integration_id
      if (!id || id in out) continue
      try {
        const v = JSON.parse(row.value)
        if (v?.type === "key" && typeof v.key === "string") out[id] = v.key
      } catch {
        /* 非 JSON 或非 key 型(如 oauth)跳过 */
      }
    }
    return out
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      /* 只读连接, 关闭失败无影响 */
    }
  }
}

// XDG data 目录(与 opencode 一致): XDG_DATA_HOME 或 ~/.local/share
export function xdgDataDir(env: { XDG_DATA_HOME?: string; HOME?: string } = process.env): string {
  if (env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim() !== "") return env.XDG_DATA_HOME
  return require("node:path").join(env.HOME ?? require("node:os").homedir(), ".local", "share")
}
