import { describe, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { appendLogLine } from "./log"

describe("appendLogLine", () => {
  test("自动建目录, 逐行追加, 带时间前缀", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qr-log-"))
    const f = path.join(dir, "nested", "a.log")
    appendLogLine(f, "hello")
    appendLogLine(f, "world")
    const text = readFileSync(f, "utf8")
    expect(text).toContain("hello")
    expect(text).toContain("world")
    expect(text.split("\n").filter(Boolean).length).toBe(2)
    const first = text.split("\n")[0]
    expect(first).toMatch(/^\d{2}:\d{2}:\d{2} hello$/)
    rmSync(dir, { recursive: true, force: true })
  })

  test("超过容量上限时先清空再写", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qr-log-"))
    const f = path.join(dir, "b.log")
    appendFileSync(f, "x".repeat(64))
    appendLogLine(f, "after", 16)
    const text = readFileSync(f, "utf8")
    expect(text).toContain("after")
    expect(text).not.toContain("xxxx")
    expect(statSync(f).size).toBeLessThan(64)
    rmSync(dir, { recursive: true, force: true })
  })

  test("写不进去也不抛(例如目录不可写)", () => {
    expect(() => appendLogLine("/proc/definitely/not/writable/a.log", "x")).not.toThrow()
  })
})
