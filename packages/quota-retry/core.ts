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
  // location 保活总开关(默认 true)。防的是: location 60 分钟无 durable 会话事件 → 宿主以
  // reason="inactivity" 打断执行并回收 location(后台 shell 进程随回收被杀, 生产已踩)。
  // 模型与上游 anomalyco/opencode#57416(2026-10-20 合并)的保护集对齐, 数据源是插件可见的
  // 事件流; 该修复随正式 release 落地并升级后, 设 keepalive:false 即可整体关闭
  // (轮次续命不受影响)。
  keepalive?: boolean
  // 保活扫描间隔(ms)。每 45 分钟(默认, 低于 60 分钟 TTL 留余量)检查一次:
  // 有 pending(活跃执行/后台 shell)→ 发一条 durable 标记刷新本 location TTL; 无 → 不发。
  // 0 = 等效 keepalive:false。
  heartbeatMs?: number
}

export const DEFAULT_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
export const DEFAULT_FALLBACK_WAIT_MS = 30_000
export const DEFAULT_BUFFER_MS = 10_000
export const DEFAULT_QUOTA_CACHE_MS = 60_000
// 长等待心跳默认间隔: 45 分钟(低于 opencode location 回收的 60 分钟 TTL, 留 15 分钟余量)
export const DEFAULT_HEARTBEAT_MS = 45 * 60 * 1000
// pending 条目(活跃执行/后台 shell)最大存活时间: 事件流推导没有宿主内存注册表的天然自清理,
// 终态事件一旦丢失(断连/会话被删/插件重载错位)条目会永久残留 → 永久保活 + 每 45 分钟一条标记。
// 超龄条目在 sweep 时剔除。连续续命轮每轮都有新的 execution.started(刷新时间戳), 不受影响;
// 代价是超过 12h 的真实后台 shell 失去保护(dbg 有记录)——两害取其轻。
export const MAX_PENDING_AGE_MS = 12 * 60 * 60 * 1000
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

// 保活目标选择: 优先"活跃执行"里最早的会话, 否则"后台 shell"里最早的会话; 都空 → undefined。
// 只取一个: TTL 是 location 级的, 一条 durable 事件就能整体刷新(与上游 #57416 的保护集
// 对齐 —— 它用内存注册表, 插件只能用事件流近似, 语义一致)。
export function pickKeepaliveTarget(active: Iterable<string>, shellSids: Iterable<string>): string | undefined {
  for (const sid of active) if (sid) return sid
  for (const sid of shellSids) if (sid) return sid
  return undefined
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

// ── 事件归属(location 级订阅) ──
//
// 宿主的事件流是**全 location 广播**: 每个插件实例都会收到所有 location 的事件
// (否则多实例会重复续命 / 重复心跳 / 重复标记 —— 实测 3 个 location 实例 = 3 条标记)。
// 因此每个实例必须先判定"这条事件属于哪个 location"。
//
// 坑: 宿主 2.0.32 的事件信封**并不统一**
//   · location 级事件(step.* / inbox.* / tool.* / retry.scheduled ...) 带 location;
//   · execution.* / usage.updated 由服务器级执行队列发布(发布点在 location 作用域
//     之外, fiber 上下文里没有 Location.Service), **不带** location。
// 所以不能用 `evLoc !== selfDir` 一刀切 —— 那样会把所有 execution.* 静默丢掉,
// 表现为"续命 / 轮次清零 / 心跳 disarm 全部不生效", 且没有任何报错(已实机复现,
// 2026-10-20 事故: 10 次原生重试耗尽后 90 秒会话直接 failed)。
//
// 判据: 有信封 → 信封是权威(location 级事件高频, 走这条快路径避免逐事件查库);
//       无信封 → 用 sessionID 反查会话目录再比(调用方负责查询)。
export function resolveEventOwner(
  evLoc: string | undefined,
  selfDir: string,
  sessionDir: string | undefined,
): "match" | "skip" {
  const loc = String(evLoc ?? "")
  if (loc) return loc === selfDir ? "match" : "skip"
  const dir = String(sessionDir ?? "")
  if (!dir) return "skip"
  return dir === selfDir ? "match" : "skip"
}

// 轮次标记的文本前缀。标记的 text = 前缀 + 随机 token。
// 注意: 出口过滤已改为按 message.id(MESSAGE_ID_PREFIX)剥, 不再依赖文本;
// text 前缀只用于在 session DB / 日志里一眼辨认"这是插件注入的", 以及界面显示时的可读性。
export const MARKER_TEXT_PREFIX = "EL-PSY-CONGROO-quota-retry-round-"
// 心跳标记的前缀(与轮次标记分开命名, 语义各归各的)
export const HEARTBEAT_TEXT_PREFIX = "EL-PSY-CONGROO-quota-retry-heartbeat-"

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

// 本插件自建消息的 id 前缀: 轮次标记 / 心跳标记 / retry-setting 回复 都用它,
// 在 context hook 里按 id 整段剥除(HTTP 序列化之前), 请求里不会出现这些消息。
// 旧实现的 id(msg_quota-retry_rN_* / msg_quota-retry-heartbeat-* / msg_quota-retry-round-_hb_*)
// 同前缀, 一并覆盖。注: opencode 的消息 id 必须以 "msg_" 开头, 所以首个下划线保留, 其余分隔用中划线。
export const MESSAGE_ID_PREFIX = "msg_quota-retry"

export function isPluginMessageId(id: unknown): boolean {
  // 必须带分隔符边界: msg_quota-retry-*(新) / msg_quota-retry_*(旧)
  return typeof id === "string" && /^msg_quota-retry[-_]/.test(id)
}

// 为什么按 id 而不是文本: synthetic 到 provider 只剩 role/content(to-llm-message.ts:287-288),
// http.request 阶段已看不到 id 与 type; 而 context hook 在序列化之前拿到 Message[], id 仍在,
// 因此在那里按 id 前缀剥除是确定性做法(不会误删真实用户消息, 也覆盖旧标记)。
// 为什么 resume 不够: resume 只控制 execution.wake(session.ts:174), 不改变消息是否进请求。

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
