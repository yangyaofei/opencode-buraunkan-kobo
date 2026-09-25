import { describe, expect, test } from "bun:test"
import {
  effectiveRule,
  parseArgs,
  planReap,
  statusReport,
  parseJsonc,
  type ReaperConfig,
  type Registry,
} from "./reaper"

describe("parseArgs", () => {
  test("action + flags + prompt", () => {
    const p = parseArgs("run --pipeline twitter-daily --keep-days 10 do the daily report")
    expect(p.action).toBe("run")
    expect(p.pipeline).toBe("twitter-daily")
    expect(p.keepDays).toBe(10)
    expect(p.prompt).toBe("do the daily report")
  })
  test("等号形式 flags", () => {
    const p = parseArgs("set --pipeline=a --max-sessions=5")
    expect(p.action).toBe("set")
    expect(p.pipeline).toBe("a")
    expect(p.maxSessions).toBe(5)
    expect(p.prompt).toBe("")
  })
  test("剥掉误传的命令名", () => {
    const p = parseArgs("/session-reaper status")
    expect(p.action).toBe("status")
  })
  test("空输入", () => {
    const p = parseArgs("")
    expect(p.action).toBeUndefined()
    expect(p.prompt).toBeUndefined()
  })
  test("prompt 以 -- 开头时不被吞(flags 只在开头贪婪识别)", () => {
    const p = parseArgs('run --pipeline a "--verbose" is part of prompt')
    expect(p.pipeline).toBe("a")
    expect(p.prompt).toBe('"--verbose" is part of prompt')
  })
})

describe("effectiveRule", () => {
  const cfg: ReaperConfig = {
    defaultKeepDays: 30,
    defaultMaxSessions: 10,
    pipelines: { a: { keepDays: 5 }, b: {} },
  }
  test("显式配置覆盖 default", () => {
    const r = effectiveRule(cfg, "a")
    expect(r.explicit).toBe(true)
    expect(r.keepDays).toBe(5)
    expect(r.maxSessions).toBe(10)
  })
  test("空规则回落 default 且非显式", () => {
    const r = effectiveRule(cfg, "b")
    expect(r.explicit).toBe(false)
    expect(r.keepDays).toBe(30)
  })
  test("未配置的 pipeline 回落 default", () => {
    const r = effectiveRule(cfg, "unknown")
    expect(r.explicit).toBe(false)
  })
})

describe("planReap", () => {
  const now = Date.parse("2026-09-25T00:00:00Z")
  const day = 86400_000
  const reg: Registry = {
    p: [
      { id: "old1", created: now - 40 * day },
      { id: "old2", created: now - 35 * day },
      { id: "mid", created: now - 20 * day },
      { id: "new1", created: now - 5 * day },
      { id: "new2", created: now - 1 * day },
    ],
  }
  test("keepDays 过期分类", () => {
    const { expired, overflow, survivors } = planReap(reg, "p", { keepDays: 30 }, now)
    expect(expired.map((e) => e.id)).toEqual(["old1", "old2"])
    expect(overflow).toEqual([])
    expect(survivors.map((e) => e.id)).toEqual(["mid", "new1", "new2"])
  })
  test("maxSessions 溢出(最老的先删)", () => {
    const { overflow, survivors } = planReap(reg, "p", { maxSessions: 2 }, now)
    expect(overflow.map((e) => e.id)).toEqual(["old1", "old2", "mid"])
    expect(survivors.map((e) => e.id)).toEqual(["new1", "new2"])
  })
  test("无规则 = 只登记不清理", () => {
    const { expired, overflow, survivors } = planReap(reg, "p", {}, now)
    expect(expired).toEqual([])
    expect(overflow).toEqual([])
    expect(survivors).toHaveLength(5)
  })
  test("空桶", () => {
    const r = planReap({}, "missing", { keepDays: 1 }, now)
    expect(r.survivors).toEqual([])
  })
})

describe("statusReport", () => {
  test("无 pipeline 时的提示", () => {
    const text = statusReport({}, {}, "/tmp/registry.json")
    expect(text).toContain("无已登记的 pipeline")
  })
  test("桶内容与超期标记", () => {
    const now = Date.now()
    const cfg: ReaperConfig = { defaultKeepDays: 1, pipelines: { p: { keepDays: 1 } } }
    const reg: Registry = { p: [{ id: "ses_old", created: now - 2 * 86400_000 }, { id: "ses_new", created: now }] }
    const text = statusReport(cfg, reg, "/tmp/registry.json")
    expect(text).toContain("p  keepDays=1d")
    expect(text).toContain("ses_old  2.0d  ← 超期")
    expect(text).toContain("ses_new")
    expect(text).toContain("/tmp/registry.json")
  })
})

describe("parseJsonc", () => {
  test("注释与尾逗号", () => {
    const v = parseJsonc('{ // hi\n "a": 1, /* block */ "b": [1, 2,], }') as Record<string, unknown>
    expect(v.a).toBe(1)
    expect(v.b).toEqual([1, 2])
  })
})
