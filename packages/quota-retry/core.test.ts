import { describe, expect, test } from "bun:test"
import {
  computeWaitMs,
  expandProviders,
  isQuotaError,
  isQuotaResponse,
  isQuotaText,
  needsHeartbeat,
  parseResetAtMs,
  readProviderApiKeys,
  stripMarkerUsers,
  shouldContinue,
  type PluginConfig,
  xdgDataDir,
  zhipuResetAtMs,
  DEFAULT_HEARTBEAT_MS,
  HEARTBEAT_TEXT_PREFIX,
  MARKER_TEXT_PREFIX,
} from "./core"

describe("expandProviders", () => {
  test("id 数组展开为多个具体 provider", () => {
    const cfg: PluginConfig = { providers: [{ id: ["a", "b"], quota: "body" }] }
    const out = expandProviders(cfg, [])
    expect([...out.keys()].sort()).toStrictEqual(["a", "b"])
    expect(out.get("a")?.id).toBe("a")
  })

  test("idPattern 对现有 providerID 求命中(i 标志)", () => {
    const cfg: PluginConfig = { providers: [{ id: "seed", idPattern: "^zhipu", quota: "zhipu" }] }
    const out = expandProviders(cfg, ["zhipu-coding", "Zhipu-Paid", "other"])
    expect([...out.keys()].sort()).toStrictEqual(["Zhipu-Paid", "seed", "zhipu-coding"])
  })

  test("同一 ID 命中多条配置先到先得", () => {
    const cfg: PluginConfig = {
      providers: [
        { id: "x", quota: "body", bufferMs: 1000 },
        { id: "x", quota: "zhipu", bufferMs: 9999 },
      ],
    }
    expect(expandProviders(cfg, ["x"]).get("x")?.bufferMs).toBe(1000)
  })

  test("非法 idPattern 整条跳过(含显式 id), 不产生半生效配置", () => {
    const cfg: PluginConfig = { providers: [{ id: "seed", idPattern: "([", quota: "body" }] }
    expect(expandProviders(cfg, ["seed"]).size).toBe(0)
  })
})

describe("isQuotaText / isQuotaError", () => {
  test("命中默认配额特征(智谱/火山)", () => {
    expect(isQuotaText('{"error":{"code":"1308","message":"AccountQuotaExceeded"}}')).toBe(true)
    expect(isQuotaText("您当前的使用上限已用完")).toBe(true)
    expect(isQuotaText("too many concurrent requests")).toBe(false)
  })

  test("自定义 quotaMatch 覆盖默认", () => {
    expect(isQuotaText("hit the hard limit now", "hard limit")).toBe(true)
    expect(isQuotaText("AccountQuotaExceeded", "hard limit")).toBe(false)
  })

  test("provider.quota 类型直接视为配额", () => {
    expect(isQuotaError("provider.quota", "whatever")).toBe(true)
    expect(isQuotaError("provider.rate-limit", "AccountQuotaExceeded")).toBe(true)
    expect(isQuotaError("provider.rate-limit", "concurrency limit")).toBe(false)
  })
})

describe("isQuotaResponse(响应驱动判定, 对齐 1.x)", () => {
  test("默认只认 429 + 正文命中配额特征", () => {
    expect(isQuotaResponse(429, '{"error":{"code":"1308","message":"使用上限"}}')).toBe(true)
    // 非配额 429(并发限流) → 放行, 交回 opencode 原生退避
    expect(isQuotaResponse(429, "too many concurrent requests")).toBe(false)
    // 默认不含其它状态码
    expect(isQuotaResponse(503, '{"message":"AccountQuotaExceeded"}')).toBe(false)
  })

  test("statuses 可配(把 5xx/其它状态码纳入配额入口)", () => {
    const p = { statuses: [429, 503], quotaMatch: "使用上限" }
    expect(isQuotaResponse(503, "使用上限已用完", p)).toBe(true)
    expect(isQuotaResponse(429, "使用上限已用完", p)).toBe(true)
    expect(isQuotaResponse(500, "使用上限已用完", p)).toBe(false)
  })

  test("状态码缺失/非法 → false", () => {
    expect(isQuotaResponse(undefined, "使用上限")).toBe(false)
    expect(isQuotaResponse(null, "使用上限")).toBe(false)
    expect(isQuotaResponse(Number.NaN, "使用上限")).toBe(false)
  })
})

describe("parseResetAtMs", () => {
  test("无时区后缀按 +08:00 解析", () => {
    const ms = parseResetAtMs('{"nextResetTime":"2026-09-24 20:00:00"}')
    expect(ms).toBe(Date.parse("2026-09-24T20:00:00+08:00"))
  })

  test("默认正则捕获组不含时区: 一律按 +08:00 解析(与 1.x 一致)", () => {
    // DEFAULT_RESET_EXTRACT 的捕获组到秒为止, 尾部 Z 不在捕获串里, 故时区判定为假 → +08:00
    expect(parseResetAtMs("reset at 2026-09-24T12:00:00Z")).toBe(Date.parse("2026-09-24T12:00:00+08:00"))
  })

  test("自定义 resetExtract 捕获时区时按原样解析", () => {
    const custom = "((?:\\d{4}-\\d{2}-\\d{2})[\\sT]\\d{2}:\\d{2}:\\d{2}(?:Z|[+-]\\d{2}:?\\d{2}))"
    expect(parseResetAtMs("reset at 2026-09-24T12:00:00Z", custom)).toBe(Date.parse("2026-09-24T12:00:00Z"))
  })

  test("无时间戳返回 NaN", () => {
    expect(Number.isNaN(parseResetAtMs("no timestamp here"))).toBe(true)
  })
})

describe("computeWaitMs", () => {
  const now = Date.parse("2026-09-24T10:00:00+08:00")

  test("有重置时刻: (reset - now) + buffer", () => {
    const resetAt = now + 5 * 60_000
    expect(computeWaitMs({ now, resetAtMs: resetAt, bufferMs: 10_000 })).toBe(5 * 60_000 + 10_000)
  })

  test("无重置时刻: fallbackWaitMs", () => {
    expect(computeWaitMs({ now, fallbackWaitMs: 30_000 })).toBe(30_000)
  })

  test("NaN 重置时刻: fallbackWaitMs", () => {
    expect(computeWaitMs({ now, resetAtMs: Number.NaN, fallbackWaitMs: 30_000 })).toBe(30_000)
  })

  test("重置时刻已过: 钳到 minWaitMs, 不为负", () => {
    expect(computeWaitMs({ now, resetAtMs: now - 60_000, bufferMs: 10_000, minWaitMs: 1_000 })).toBe(1_000)
  })
})

describe("zhipuResetAtMs", () => {
  const now = Date.parse("2026-09-24T10:00:00+08:00")

  test("取所有已耗尽限额里最早的重置时刻", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          data: {
            limits: [
              { percentage: 100, nextResetTime: now + 60 * 60_000 },
              { percentage: 40, nextResetTime: now + 5 * 60_000 },
              { remaining: 0, nextResetTime: now + 30 * 60_000 },
            ],
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    expect(await zhipuResetAtMs("k", { fetchImpl })).toBe(now + 30 * 60_000)
  })

  test("无已耗尽限额返回 NaN", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: { limits: [{ percentage: 10, remaining: 90 }] } }), {
        status: 200,
      })) as unknown as typeof fetch
    expect(Number.isNaN(await zhipuResetAtMs("k", { fetchImpl }))).toBe(true)
  })

  test("HTTP 非 2xx 返回 NaN", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch
    expect(Number.isNaN(await zhipuResetAtMs("k", { fetchImpl }))).toBe(true)
  })
})

describe("端到端(body 场景)", () => {
  test("从 429 body 提取重置 → 得到正等待", () => {
    const now = Date.parse("2026-09-24T10:00:00+08:00")
    const body = '{"error":{"code":"1308","message":"限额将在 2026-09-24 20:30:00 重置"}}'
    expect(isQuotaText(body)).toBe(true)
    const resetAt = parseResetAtMs(body)
    const wait = computeWaitMs({ now, resetAtMs: resetAt, bufferMs: 10_000 })
    expect(wait).toBe(10 * 60 * 60_000 + 30 * 60_000 + 10_000)
  })
})

describe("stripMarkerUsers(出口净化: 任意位置、前缀+随机 token 形状)", () => {
  const roundText = (token = "rd7f3a01") => `${MARKER_TEXT_PREFIX}${token}`
  const hbText = (token = "hb5c9e02") => `${HEARTBEAT_TEXT_PREFIX}${token}`

  test("剥掉任意位置的标记 user(字符串与 parts 形态)", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
      { role: "user", content: roundText() },
      { role: "user", content: [{ type: "text", text: hbText() }] },
    ]
    const out = stripMarkerUsers(msgs)!
    expect(out.length).toBe(2)
    expect(out.map((m: any) => m.content)).toEqual(["hi", "done"])
  })

  test("中间的标记也要剥(标记后面还有真实内容: 心跳标记的典型场景)", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "user", content: hbText() },
      { role: "assistant", content: "resumed and wrote real content" },
      { role: "user", content: "next turn" },
    ]
    const out = stripMarkerUsers(msgs)!
    expect(out.map((m: any) => m.content)).toEqual(["hi", "resumed and wrote real content", "next turn"])
  })

  test("多轮累积: 两轮各 10 条标记 + 真实内容 → 标记全剥、内容全留", () => {
    const round = (n: number) =>
      Array.from({ length: 10 }, (_, i) => ({ role: "user", content: roundText(`r${n}tok${i}abc`) }))
    const msgs = [
      { role: "user", content: "hi" },
      ...round(1),
      { role: "assistant", content: "content after round 1" },
      ...round(2),
      { role: "assistant", content: "content after round 2" },
    ]
    expect(stripMarkerUsers(msgs)!.map((m: any) => m.content)).toEqual([
      "hi",
      "content after round 1",
      "content after round 2",
    ])
  })

  test("真实用户消息只是以标记前缀开头(带后续文字) → 不误删", () => {
    expect(stripMarkerUsers([{ role: "user", content: `${MARKER_TEXT_PREFIX}rd7f3a01 是什么？` }])).toBeNull()
    expect(stripMarkerUsers([{ role: "user", content: `${HEARTBEAT_TEXT_PREFIX} 什么意思` }])).toBeNull()
    // 纯随机 token 但太短(不像我们的 token)也不剥
    expect(stripMarkerUsers([{ role: "user", content: `${MARKER_TEXT_PREFIX}abc` }])).toBeNull()
  })

  test("兼容旧前缀(已部署版本发出过的标记)", () => {
    const legacy = [
      { role: "user", content: "quota-retry-round-ab12cd34" },
      { role: "user", content: "quota-retry-round--hb-ab12cd34" },
      { role: "user", content: "quota-retry-heartbeat-ab12cd34" },
    ]
    expect(stripMarkerUsers([{ role: "user", content: "hi" }, ...legacy])!.length).toBe(1)
  })

  test("空 user 不再被剥(空可能是用户真的发了空串)", () => {
    expect(stripMarkerUsers([{ role: "user", content: "" }])).toBeNull()
    expect(stripMarkerUsers([{ role: "user", content: [] }])).toBeNull()
  })

  test("不误伤: 普通消息/assistant/带前缀但不匹配的 parts 返回 null", () => {
    expect(stripMarkerUsers([{ role: "user", content: "hi" }])).toBeNull()
    expect(stripMarkerUsers([{ role: "assistant", content: roundText() }])).toBeNull()
    expect(stripMarkerUsers([{ role: "user", content: [{ type: "text", text: "hi" }] }])).toBeNull()
    // parts 里混有普通文本 → 不算标记
    expect(
      stripMarkerUsers([
        { role: "user", content: [{ type: "text", text: roundText() }, { type: "text", text: "hi" }] },
      ]),
    ).toBeNull()
  })

  test("自定义前缀生效(仍需前缀+随机 token 形状)", () => {
    expect(stripMarkerUsers([{ role: "user", content: "xyz-abcdef" }], "xyz-")!.length).toBe(0)
    expect(stripMarkerUsers([{ role: "user", content: "xyz-abcdef" }], "abc-")).toBeNull()
    expect(stripMarkerUsers([{ role: "user", content: "xyz-abcdef" }], ["abc-", "xyz-"])!.length).toBe(0)
    expect(stripMarkerUsers([{ role: "user", content: "xyz-1" }], "xyz-")).toBeNull()
  })
})

describe("shouldContinue(续命触发策略)", () => {
  test("默认可重试类型续命", () => {
    for (const type of ["provider.quota", "provider.rate-limit", "provider.internal", "provider.transport", "provider.invalid-output", "provider.unknown"]) {
      expect(shouldContinue({ type }, undefined)).toBe(true)
    }
  })

  test("默认拒绝类型不续命(鉴权/内容/非法请求/不支持/无路由)", () => {
    for (const type of ["provider.auth", "provider.content-filter", "provider.invalid-request", "provider.unsupported-operation", "provider.no-route"]) {
      expect(shouldContinue({ type }, undefined)).toBe(false)
    }
  })

  test("默认状态码: 429 与 5xx 续命, 4xx(除 429)不续命", () => {
    expect(shouldContinue({ status: 429 }, undefined)).toBe(true)
    expect(shouldContinue({ status: 503 }, undefined)).toBe(true)
    expect(shouldContinue({ status: 599 }, undefined)).toBe(true)
    expect(shouldContinue({ status: 400 }, undefined)).toBe(false)
    expect(shouldContinue({ status: 404 }, undefined)).toBe(false)
  })

  test("denyTypes 优先于类型/状态码", () => {
    expect(shouldContinue({ type: "provider.invalid-request", status: 503 }, undefined)).toBe(false)
    expect(shouldContinue({ type: "provider.rate-limit", status: 400 }, undefined)).toBe(true)
  })

  test("自定义 types/statuses/match 覆盖默认", () => {
    expect(shouldContinue({ type: "provider.timeout" }, { types: ["provider.timeout"] })).toBe(true)
    expect(shouldContinue({ status: 400 }, { statuses: [400] })).toBe(true)
    expect(shouldContinue({ status: 400, message: "rate limited by upstream" }, { match: "rate limited" })).toBe(true)
    expect(shouldContinue({ status: 400, message: "bad input" }, { match: "rate limited" })).toBe(false)
    // 自定义 types 后, 默认集合不再生效
    expect(shouldContinue({ type: "provider.internal" }, { types: ["provider.quota"] })).toBe(false)
  })

  test("denyTypes 一票否决: 默认 deny 里的类型需显式移除才能续命", () => {
    // provider.invalid-request 在默认 deny 里 → 即使 match 命中也不续命
    expect(shouldContinue({ type: "provider.invalid-request", message: "rate limited" }, { match: "rate limited" })).toBe(false)
    // 显式 denyTypes: [] 后, match / types 生效
    expect(shouldContinue({ type: "provider.invalid-request", message: "rate limited" }, { match: "rate limited", denyTypes: [] })).toBe(true)
    expect(shouldContinue({ type: "provider.content-filter" }, { types: ["provider.content-filter"], denyTypes: [] })).toBe(true)
  })

  test("空错误不续命", () => {
    expect(shouldContinue(undefined, undefined)).toBe(false)
    expect(shouldContinue(null, undefined)).toBe(false)
  })
})


describe("needsHeartbeat", () => {
  test("等待长于心跳间隔 → 需要心跳", () => {
    expect(needsHeartbeat(3 * 3600_000, 2_700_000)).toBe(true)
  })
  test("等待短于心跳间隔 → 不需要(本来就在 TTL 内)", () => {
    expect(needsHeartbeat(10 * 60_000, 2_700_000)).toBe(false)
    expect(needsHeartbeat(2_700_000, 2_700_000)).toBe(false)
  })
  test("缺省间隔 = 45 分钟", () => {
    expect(DEFAULT_HEARTBEAT_MS).toBe(45 * 60 * 1000)
    expect(needsHeartbeat(3 * 3600_000)).toBe(true)
  })
  test("0 / 负数 / 非有限值 = 关闭心跳", () => {
    expect(needsHeartbeat(3 * 3600_000, 0)).toBe(false)
    expect(needsHeartbeat(3 * 3600_000, -1)).toBe(false)
    expect(needsHeartbeat(3 * 3600_000, Number.NaN)).toBe(false)
  })
  test("非法等待时长 → 不需要心跳", () => {
    expect(needsHeartbeat(Number.NaN, 2_700_000)).toBe(false)
    expect(needsHeartbeat(0, 2_700_000)).toBe(false)
  })
})

describe("provider 凭据读取", () => {
  test("readProviderApiKeys: 无 bun:sqlite 或库缺失时返回 null 而非抛错", () => {
    expect(readProviderApiKeys("/nonexistent-dir-xyz")).toBe(null)
  })
  test("xdgDataDir: XDG_DATA_HOME 优先, 否则 ~/.local/share", () => {
    expect(xdgDataDir({ XDG_DATA_HOME: "/xdg", HOME: "/h" })).toBe("/xdg")
    expect(xdgDataDir({ XDG_DATA_HOME: "", HOME: "/h" })).toBe("/h/.local/share")
  })
})
