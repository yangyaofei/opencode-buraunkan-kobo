import { describe, expect, test } from "bun:test"
import {
  computeWaitMs,
  expandProviders,
  isQuotaError,
  isQuotaText,
  parseResetAtMs,
  zhipuResetAtMs,
  stripTrailingEmptyUsers,
  type PluginConfig,
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

describe("stripTrailingEmptyUsers(出口净化)", () => {
  test("剥掉尾部空字符串 user", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
      { role: "user", content: "" },
    ]
    const out = stripTrailingEmptyUsers(msgs)!
    expect(out.length).toBe(2)
    expect((out[1] as any).role).toBe("assistant")
  })

  test("剥掉多个连续空 user(含空数组形态)", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "user", content: [] },
      { role: "user", content: "" },
    ]
    expect(stripTrailingEmptyUsers(msgs)!.length).toBe(1)
  })

  test("不误伤: 尾部是非空 user / assistant 时不改动(返回 null)", () => {
    expect(stripTrailingEmptyUsers([{ role: "user", content: "hi" }])).toBeNull()
    expect(stripTrailingEmptyUsers([{ role: "assistant", content: "" }])).toBeNull()
    expect(stripTrailingEmptyUsers([{ role: "user", content: [{ type: "text", text: "x" }] }])).toBeNull()
  })

  test("全部是空 user 时剥到空数组", () => {
    expect(stripTrailingEmptyUsers([{ role: "user", content: "" }])!.length).toBe(0)
  })
})
