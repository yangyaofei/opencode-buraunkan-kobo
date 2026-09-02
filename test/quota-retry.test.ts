// quota-retry 自测: bun test test/quota-retry.test.ts
// 单元部分用合成二进制(纯 latin1 文本, 满足 findRetryChain 等正则的锚定条件);
// 集成部分对真实安装的二进制做"副本 patch→verify→smoke→restore"往返, 不触碰安装本体。
import { describe, expect, test } from "bun:test"
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { quotaRetry } from "../plugins/quota-retry"

const I = (quotaRetry as any).__internals as Record<string, any>

// 当前安装(1.18.26)的补丁态与出厂态参数, 仅用于集成测试期望值
const REAL_BIN = "/opt/homebrew/Cellar/opencode/1.18.26/bin/opencode"
const FACTORY_YH = 5
const FACTORY_TH = 30000

// 合成"二进制": 常量链 + delay 尾部(封顶判定窗) + attempt 比较点, 布局与真机一致。
// 链尾带逗号: 真机链后总是紧跟下一组常量, findRetryChain 的 after 正则要求 "RV=5,"
function syntheticBinary(): Buffer {
  const head = Buffer.from("JUNK.".repeat(40), "latin1")
  const chain = Buffer.from(",TH=30000,DH=2147483647,RV=5,", "latin1")
  const backoff = Buffer.from("function wh(){return cl(eh(e,l))}}return cl(Math.min(eh(e,l),th))", "latin1")
  const cmp = Buffer.from("if(!i)return be.done(o.attempt);if(o.attempt>RV)return be.done(o.attempt);return s.gen()", "latin1")
  const tail = Buffer.from("END.".repeat(50), "latin1")
  return Buffer.concat([head, chain, backoff, cmp, tail])
}

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(import.meta.dir, `.${prefix}-`))
  return dir
}

describe("expandProviders: 多 provider 匹配", () => {
  test("id 数组展开, 每个具体 ID 拿到固化 id 的配置克隆", () => {
    const m = I.expandProviders({ providers: [{ id: ["volces-ark", "volces-ark-agent-plan"], quota: "body", fallbackWaitMs: 1234 }] }, [])
    expect([...m.keys()].sort()).toEqual(["volces-ark", "volces-ark-agent-plan"])
    expect(m.get("volces-ark")!.id).toBe("volces-ark")
    expect(m.get("volces-ark-agent-plan")!.id).toBe("volces-ark-agent-plan")
    expect(m.get("volces-ark")!.fallbackWaitMs).toBe(1234)
  })

  test("idPattern 对已存在的 providerID 正则匹配", () => {
    const m = I.expandProviders(
      { providers: [{ id: "zhipu-x", idPattern: "^volces-", quota: "body" }] },
      ["volces-ark", "volces-ark-agent-plan", "zhipuai-coding-plan"],
    )
    expect([...m.keys()].sort()).toEqual(["volces-ark", "volces-ark-agent-plan", "zhipu-x"])
    expect(m.get("volces-ark-agent-plan")!.id).toBe("volces-ark-agent-plan")
  })

  test("同 ID 先到先得; 非法正则整条跳过", () => {
    const m = I.expandProviders(
      {
        providers: [
          { id: "x", quota: "zhipu" },
          { id: ["x"], quota: "body" },
          { id: "y", idPattern: "([", quota: "body" },
        ],
      },
      ["x", "y"],
    )
    expect(m.get("x")!.quota).toBe("zhipu")
    expect(m.has("y")).toBe(false)
    expect(m.size).toBe(1)
  })

  test("空 id 与空条目忽略", () => {
    const m = I.expandProviders({ providers: [{ id: ["", "a"], quota: "body" }, { id: "", quota: "body" }, null as any] }, [])
    expect([...m.keys()]).toEqual(["a"])
  })
})

describe("合成二进制: 字节工具", () => {
  test("findRetryChain 锚定 + backupFresh 出厂/补丁态判定", () => {
    const buf = syntheticBinary()
    const chain = I.findRetryChain(buf)
    expect(chain).toBeDefined()
    expect(chain.retryVar).toBe("RV")
    expect(chain.retryVal).toBe("5")
    expect(I.hasUnlimitedPatch(buf)).toBe(false)
    expect(I.hasBackoffCap(buf, chain)).toBe(false)
    expect(I.backupFresh(buf)).toBe(true)
    const at = buf.indexOf(".attempt>RV)") + ".attempt".length
    buf.write("<-1)", at, "latin1")
    expect(I.hasUnlimitedPatch(buf)).toBe(true)
    expect(I.backupFresh(buf)).toBe(false)
  })

  test("backupFresh: 封顶分号补丁也算补丁态", () => {
    const buf = syntheticBinary()
    const chain = I.findRetryChain(buf)
    const win = buf.slice(chain.spanStart + chain.span.length, chain.spanStart + chain.span.length + 2048)
    const m = win.toString("latin1").match(/return cl\(eh\(e,l\)\)/)!
    const at = chain.spanStart + chain.span.length + m.index!
    buf.write(";".repeat(m[0].length), at, "latin1")
    expect(I.hasBackoffCap(buf, chain)).toBe(true)
    expect(I.backupFresh(buf)).toBe(false)
  })
})

describe("windowsMatch: 窗口校验", () => {
  test("命中 / 篡改一个字节即失配", () => {
    const dir = tmpDir("win")
    const bin = path.join(dir, "synthetic")
    const buf = syntheticBinary()
    writeFileSync(bin, buf)
    const chain = I.findRetryChain(buf)
    const at = buf.indexOf(".attempt>RV)")
    const windows = { chainAt: chain.spanStart, chainSpan: chain.span, unlimAt: at, unlimMark: buf.slice(at, at + 16).toString("latin1") }
    expect(I.windowsMatch(bin, windows)).toBe(true)
    const fd = openSync(bin, "r+")
    writeSync(fd, Buffer.from("X"), 0, 1, windows.chainAt + 1)
    closeSync(fd)
    expect(I.windowsMatch(bin, windows)).toBe(false)
    expect(I.windowsMatch(bin, {})).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})

const realBinAvailable = existsSync(REAL_BIN)
describe("真实二进制: patch→verify→smoke→restore 往返", () => {
  test(
    "副本上完成无限补丁/次数改写/窗口校验/还原出厂",
    () => {
      const dir = tmpDir("real")
      const bin = path.join(dir, "opencode")
      copyFileSync(REAL_BIN, bin)

      // 1) 副本继承安装态(无限补丁), 期望 already 且带窗口指纹; 验证+冒烟通过
      const r0 = I.patchBinaryFull(bin, { maxRetries: -1, backoffCapMs: FACTORY_TH })
      expect(["patched", "already"]).toContain(r0.status)
      expect(r0.windows).toBeDefined()
      expect(I.verifyPatchBin(bin, { unlimited: true, cap: true, th: FACTORY_TH }).ok).toBe(true)
      expect(I.bootSmoke(bin)).toBe(true)
      expect(I.windowsMatch(bin, r0.windows)).toBe(true)

      // 2) 改回出厂次数(5): 等价于纯还原, 期望 already(或 patched), 验证按出厂态
      const r1 = I.patchBinaryFull(bin, { maxRetries: FACTORY_YH })
      expect(["patched", "already"]).toContain(r1.status)
      expect(I.verifyPatchBin(bin, { unlimited: false, yh: FACTORY_YH, cap: false }).ok).toBe(true)

      // 3) 再打无限补丁: patched + 验证 + 冒烟
      const r2 = I.patchBinaryFull(bin, { maxRetries: -1, backoffCapMs: FACTORY_TH })
      expect(r2.status).toBe("patched")
      expect(I.verifyPatchBin(bin, { unlimited: true, cap: true, th: FACTORY_TH }).ok).toBe(true)
      expect(I.bootSmoke(bin)).toBe(true)
      expect(I.windowsMatch(bin, r2.windows)).toBe(true)

      // 4) 篡改一个字节 → 窗口校验失败(缓存作废路径)
      const win = r2.windows!
      const fd = openSync(bin, "r+")
      writeSync(fd, Buffer.from("X"), 0, 1, win.chainAt + 1)
      closeSync(fd)
      expect(I.windowsMatch(bin, win)).toBe(false)

      // 5) 还原出厂: backupFresh 恢复为真
      expect(I.restoreBinary(bin)).toBe(true)
      expect(I.backupFresh(readFileSync(bin))).toBe(true)

      rmSync(dir, { recursive: true, force: true })
    },
    180_000,
  )

  test("patchStatusReport(注入副本路径): 输出进程新鲜度与备份状态", () => {
    const dir = tmpDir("report")
    const bin = path.join(dir, "opencode")
    copyFileSync(REAL_BIN, bin)
    I.patchBinaryFull(bin, { maxRetries: -1, backoffCapMs: FACTORY_TH })
    const text = I.patchStatusReport("/nonexistent-project", [bin]) as string
    // 补丁态 + 无运行进程新鲜度干扰(副本 mtime 刚写入, 但报告以 want 比对为准)
    expect(text).toContain("无限重试: 已开启")
    expect(text).toContain(path.basename(bin))
    rmSync(dir, { recursive: true, force: true })
  }, 60_000)
})
