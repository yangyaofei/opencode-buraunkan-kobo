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
