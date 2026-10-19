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
  // 判定"配额类响应"的状态码白名单(默认 [429], 与 1.x 写死的入口一致)。
  // 响应状态码命中这里、且正文命中 quotaMatch(默认 DEFAULT_QUOTA_MATCH)时按配额处理
  // (精确等待); 否则原样放行, 交回 opencode 原生退避(非配额 429 如并发限流即走此路)。
  statuses?: number[]
  quota: "zhipu" | "body"
  quotaUrl?: string
  quotaMatch?: string
  resetExtract?: string
  fallbackWaitMs?: number
  bufferMs?: number
  apiKey?: string
}

// 续命(轮次)触发策略: 原生 10 次耗尽后, 哪些失败应该再开一轮。
// 默认对齐 1.x `maxRetries=-1` 的语义 —— opencode 原生会重试的那一类错误, 耗尽后继续。
export type ContinuePolicy = {
  // 错误类型白名单(opencode SessionError.Error.type), 覆盖默认集合。
  types?: string[]
  // HTTP 状态码白名单。缺省 = 429 与全部 5xx(500-599)。
  // 例如"某些 400 也要重试"就写进这里, 或用 match 正则。
  statuses?: number[]
  // 显式拒绝的类型, 优先级最高(鉴权/内容策略/非法请求/不支持/无路由)。
  denyTypes?: string[]
  // 消息文本正则: 命中则续命(用于按错误文本列举的场景)。
  match?: string
}

export type PluginConfig = {
  providers?: ProviderConfig[]
  quotaCacheMs?: number
  // 运行日志文件(默认关闭, 只在排查时开)。true = 默认路径
  // ~/.cache/opencode/buraunkan/quota-retry.log; 传字符串 = 自定义路径; false/缺省 = 关闭。
  // 512KB 上限自动截断。只记关键决策: 判定命中与算出的等待、心跳发送/失败、加载/卸载与错误,
  // 用于事后定位"等待为什么没撑住"这类问题。
  logFile?: string | boolean
  // 轮次续命的轮数上限; -1 = 不限(默认)。每轮 = 原生 10 次重试。
  maxRounds?: number
  // 续命触发策略(默认: 可重试错误类型 + 429/5xx)。
  continueOn?: ContinuePolicy
  // 长等待心跳间隔(ms)。opencode 的 location 不活动回收在 60 分钟无 durable 会话事件时以
  // reason="inactivity" 打断正在等待的执行(core/src/location-activity.ts, TTL 写死、只被
  // "带 location 的 durable 会话事件"刷新)。等待配额重置期间不产生事件, 所以超过 60 分钟的
  // 等待会被掐断。心跳 = 等待期间落一条 durable 标记(session.synthetic, resume:false,
  // 不唤醒执行), 让 TTL 持续被刷新; 发送时机由宿主事件驱动(插件只做被调用时能做的事),
  // 每次收到事件时检查到期。默认 45 分钟(留余量); 0 = 关闭心跳。
  heartbeatMs?: number
}

export const DEFAULT_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
export const DEFAULT_FALLBACK_WAIT_MS = 30_000
export const DEFAULT_BUFFER_MS = 10_000
export const DEFAULT_QUOTA_CACHE_MS = 60_000
// 长等待心跳默认间隔: 45 分钟(低于 opencode location 回收的 60 分钟 TTL, 留 15 分钟余量)
export const DEFAULT_HEARTBEAT_MS = 45 * 60 * 1000
// 判定 429 是不是配额耗尽的默认正则(智谱+火山特征)
export const DEFAULT_QUOTA_MATCH = 'AccountQuotaExceeded|usage quota|使用上限|限额将在|"code"\\s*:\\s*"1308"'
// 判定"配额类响应"的默认状态码。1.x 写死 429; 2.0 起可由 provider.statuses 覆盖。
export const DEFAULT_QUOTA_STATUSES = [429]
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

// 2.0 的主判定入口(对齐 1.x 的响应驱动): 用 http.response 捕获到的原始响应判定——
// 状态码命中 statuses(默认 [429])且正文命中 quotaMatch 才算"配额耗尽"。
// 非配额 429(并发限流等)与其它状态码一律放行, 与 1.x "非配额 429 不注入" 的行为一致。
export function isQuotaResponse(
  status: number | undefined | null,
  text: string,
  p?: { statuses?: number[]; quotaMatch?: string },
): boolean {
  const s = Number(status)
  if (!Number.isFinite(s)) return false
  if (!(p?.statuses ?? DEFAULT_QUOTA_STATUSES).includes(s)) return false
  return isQuotaText(text, p?.quotaMatch)
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

// 该等待是否需要心跳: 只有"等待长于心跳间隔"才需要(短等待本来就在 TTL 内)。
// heartbeatMs <= 0 / 非有限值 = 关闭心跳。
export function needsHeartbeat(delayMs: number, heartbeatMs?: number): boolean {
  const hb = heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  if (!Number.isFinite(hb) || hb <= 0) return false
  if (!Number.isFinite(delayMs) || delayMs <= 0) return false
  return delayMs > hb
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

// 轮次标记的文本前缀。标记的 text = 前缀 + 随机 token: 既让出站过滤能精确识别
// "这必然是我们注入的"(不靠"空字符串"这种可能撞上真实用户输入的判据), 也让它在
// session DB / 日志里一眼可辨。
export const MARKER_TEXT_PREFIX = "quota-retry-round-"
// 心跳标记的前缀(与轮次标记分开命名, 语义各归各的)
export const HEARTBEAT_TEXT_PREFIX = "quota-retry-heartbeat-"
// 出口净化认识的全部标记前缀(任意位置、按前缀整段剥除)
export const MARKER_TEXT_PREFIXES = [MARKER_TEXT_PREFIX, HEARTBEAT_TEXT_PREFIX] as const

// 续命默认可续的错误类型 = opencode 原生 isRetryable 的那一组
// (RateLimit/ProviderInternal/Transport/InvalidProviderOutput/UnknownProvider + 插件翻转的 Quota)
export const DEFAULT_CONTINUE_TYPES = [
  "provider.quota",
  "provider.rate-limit",
  "provider.internal",
  "provider.transport",
  "provider.invalid-output",
  "provider.unknown",
]
// 永远不续命的类型: 鉴权/内容策略/非法请求/不支持/无路由 —— 重试无意义。
export const DEFAULT_CONTINUE_DENY_TYPES = [
  "provider.auth",
  "provider.content-filter",
  "provider.invalid-request",
  "provider.unsupported-operation",
  "provider.no-route",
]

// 续命判定: deny 优先; 其次类型白名单; 其次状态码(缺省 429 + 5xx); 最后正则。
export function shouldContinue(
  error: { type?: string; status?: number; message?: string } | undefined | null,
  policy?: ContinuePolicy,
): boolean {
  if (!error) return false
  const type = String(error.type ?? "")
  if (type && (policy?.denyTypes ?? DEFAULT_CONTINUE_DENY_TYPES).includes(type)) return false
  if (type && (policy?.types ?? DEFAULT_CONTINUE_TYPES).includes(type)) return true
  const status = Number(error.status)
  if (Number.isFinite(status)) {
    const statuses = policy?.statuses
    if (statuses) {
      if (statuses.includes(status)) return true
    } else if (status === 429 || (status >= 500 && status <= 599)) {
      return true
    }
  }
  if (policy?.match) {
    try {
      if (new RegExp(policy.match, "i").test(String(error.message ?? ""))) return true
    } catch {}
  }
  return false
}

// 判定一条 content 是不是本插件注入的标记: 字符串直接看前缀; parts 形态要求
// 全部文本 part 都带前缀(避免把用户真实消息误判为标记)。
export function isMarkerText(
  content: unknown,
  prefixes: string | readonly string[] = MARKER_TEXT_PREFIXES,
): boolean {
  const list = typeof prefixes === "string" ? [prefixes] : prefixes
  const matches = (text: unknown) =>
    typeof text === "string" && list.some((prefix) => text.startsWith(prefix))
  if (typeof content === "string") return matches(content)
  if (Array.isArray(content)) {
    const texts = content.filter(
      (part): part is { type: string; text: string } =>
        Boolean(part) && typeof part === "object" && (part as { type?: string }).type === "text",
    )
    return texts.length > 0 && texts.every((part) => matches(part.text))
  }
  return false
}

// 出站请求体净化: 剥掉"标记"映射出的 user 消息(轮次标记 / 心跳标记), 任意位置都剥,
// 让请求里不出现任何内部标记。只认标记文本前缀, 不按"空"判定(空 user 可能是用户真的发了 "")。
// 返回新数组; 无需剥离时返回 null(调用方保持原请求不动)。
export function stripMarkerUsers(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>,
  prefixes: string | readonly string[] = MARKER_TEXT_PREFIXES,
): unknown[] | null {
  const out = messages.filter(
    (message) => !(message && message.role === "user" && isMarkerText(message.content, prefixes)),
  )
  return out.length === messages.length ? null : out
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
