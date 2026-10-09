import { describe, expect, test } from "bun:test"
import {
  computeWaitMs,
  expandOnDemand,
  expandProviders,
  isQuotaError,
  isQuotaText,
  markDead,
  parseResetAtMs,
  pickHop,
  readProviderApiKeys,
  stripTrailingMarkerUsers,
  shouldContinue,
  type PluginConfig,
  xdgDataDir,
  zhipuResetAtMs,
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

describe("stripTrailingMarkerUsers(出口净化)", () => {
  test("剥掉尾部的前缀标记 user(字符串形态)", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
      { role: "user", content: "quota-retry-round-ab12cd34" },
    ]
    const out = stripTrailingMarkerUsers(msgs)!
    expect(out.length).toBe(2)
    expect((out[1] as any).role).toBe("assistant")
  })

  test("剥掉多个连续标记 user(含 parts 形态)", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "user", content: [{ type: "text", text: "quota-retry-round-x1" }] },
      { role: "user", content: "quota-retry-round-x2" },
    ]
    expect(stripTrailingMarkerUsers(msgs)!.length).toBe(1)
  })

  test("空 user 不再被剥(空可能是用户真的发了空串)", () => {
    expect(stripTrailingMarkerUsers([{ role: "user", content: "" }])).toBeNull()
    expect(stripTrailingMarkerUsers([{ role: "user", content: [] }])).toBeNull()
  })

  test("不误伤: 普通消息/assistant/带前缀但不匹配的 parts 返回 null", () => {
    expect(stripTrailingMarkerUsers([{ role: "user", content: "hi" }])).toBeNull()
    expect(stripTrailingMarkerUsers([{ role: "assistant", content: "quota-retry-round-x" }])).toBeNull()
    expect(stripTrailingMarkerUsers([{ role: "user", content: [{ type: "text", text: "hi" }] }])).toBeNull()
    // parts 里混有普通文本 → 不算标记
    expect(
      stripTrailingMarkerUsers([
        { role: "user", content: [{ type: "text", text: "quota-retry-round-x" }, { type: "text", text: "hi" }] },
      ]),
    ).toBeNull()
  })

  test("自定义前缀生效", () => {
    expect(stripTrailingMarkerUsers([{ role: "user", content: "xyz-1" }], "xyz-")!.length).toBe(0)
    expect(stripTrailingMarkerUsers([{ role: "user", content: "xyz-1" }], "abc-")).toBeNull()
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

describe("on-demand 降级链", () => {
  test("expandOnDemand: 非法条目跳过(空链/缺 model/缺 provider)", () => {
    const out = expandOnDemand([
      { model: "ok", provider: "g", baseURL: "http://h/v1", chain: [{ model: "m1", baseURL: "http://h/v1" }, { model: "" }, undefined as any] },
      { model: "", provider: "g", chain: [{ model: "m", baseURL: "http://h/v1" }] },
      { model: "x", chain: [{ model: "m", baseURL: "http://h/v1" }] },
      { model: "y", provider: "g", chain: [] },
    ])
    expect(out.length).toBe(1)
    expect(out[0].chain.length).toBe(1)
  })
})

describe("on-demand HTTP 链状态机", () => {
  const chain = [
    { provider: "a", model: "m", baseURL: "http://a/v1" },
    { provider: "b", model: "m", baseURL: "http://b/v1" },
  ]
  test("全活选第 0 跳; 首跳死亡选第 1 跳; 全死选最后一跳", () => {
    const st = { deadUntil: new Map<number, number>() }
    expect(pickHop(chain, st)).toBe(0)
    markDead(chain, st, 0, Date.now() + 60_000)
    expect(pickHop(chain, st)).toBe(1)
    markDead(chain, st, 1, Date.now() + 60_000)
    expect(pickHop(chain, st)).toBe(1)
  })
  test("死亡到期后重扫回第 0 跳", () => {
    const st = { deadUntil: new Map([[0, Date.now() - 1]]) }
    expect(pickHop(chain, st)).toBe(0)
  })
  test("markDead 越界忽略", () => {
    const st = { deadUntil: new Map<number, number>() }
    markDead(chain, st, 5, Date.now())
    expect(st.deadUntil.size).toBe(0)
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
