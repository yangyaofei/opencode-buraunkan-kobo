import { describe, expect, test } from "bun:test"
import {
  applyMeta,
  findModelMeta,
  mirrorMeta,
  isDefaultCapabilities,
  isDefaultLimit,
  isPlatformDefaultVariants,
  mergePriority,
  MODEL_INFO_DEFAULTS,
  type Catalog,
} from "./catalog"

const catalog: Catalog = {
  opencode: { models: { "glm-5.3": makeMeta("opencode") } },
  zhipuai: { models: { "glm-5.3": makeMeta("zhipuai") } },
  "other-vendor": { models: { "deepseek-v4.1": makeMeta("other") } },
  broken: { models: { "bad-model": { limit: { context: 0, output: 0 } } as any } },
}

function makeMeta(source: string) {
  return {
    limit: { context: 131072, output: 16384, input: 65536 },
    cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.5 },
    reasoning: true,
    tool_call: false,
    family: `fam-${source}`,
    release_date: "2026-08-01",
    status: "beta",
    modalities: { input: ["text"], output: ["text"] },
    temperature: true,
    interleaved: { field: "reasoning_content" },
    reasoning_options: [{ type: "effort", values: ["low", "high", null, "max"] }],
  }
}

function freshModel() {
  return {
    limit: { context: MODEL_INFO_DEFAULTS.limitContext, output: MODEL_INFO_DEFAULTS.limitOutput },
    cost: [] as any[],
    capabilities: {
      tools: MODEL_INFO_DEFAULTS.capabilities.tools,
      input: [...MODEL_INFO_DEFAULTS.capabilities.input],
      output: [...MODEL_INFO_DEFAULTS.capabilities.output],
    },
    variants: [] as any[],
    time: { released: 0 },
    status: "active",
  }
}

describe("findModelMeta", () => {
  test("厂商官方优先于 opencode 网关", () => {
    expect(findModelMeta(catalog, "glm-5.3")?.family).toBe("fam-zhipuai")
  })
  test("优先列表内按顺序命中(deepseek 在 zhipuai 之前)", () => {
    const both = {
      ...catalog,
      deepseek: { models: { "glm-5.3": makeMeta("deepseek") } },
    } as Catalog
    expect(findModelMeta(both, "glm-5.3")?.family).toBe("fam-deepseek")
  })
  test("无官方时厂商次之", () => {
    expect(findModelMeta(catalog, "deepseek-v4.1")?.family).toBe("fam-other")
  })
  test("非法数据跳过", () => {
    expect(findModelMeta(catalog, "bad-model")).toBeNull()
    expect(findModelMeta(catalog, "nope")).toBeNull()
  })
  test("配置追加的 provider 参与优先查找", () => {
    const withPref = {
      ...catalog,
      "my-provider": { models: { "deepseek-v4.1": makeMeta("mine") } },
    } as Catalog
    expect(mergePriority(["my-provider"])).toEqual([
      "deepseek",
      "zhipuai",
      "opencode-go",
      "opencode",
      "my-provider",
    ])
    expect(findModelMeta(withPref, "deepseek-v4.1", mergePriority(["my-provider"]))?.family).toBe("fam-mine")
  })
  test("优先列表都没有时回退目录顺序", () => {
    expect(findModelMeta(catalog, "deepseek-v4.1", ["nonexistent"])?.family).toBe("fam-other")
  })
  test("mergePriority 去重且忽略空值", () => {
    expect(mergePriority(["", "opencode", "  ", "x", "x"])).toEqual([
      "deepseek",
      "zhipuai",
      "opencode-go",
      "opencode",
      "x",
    ])
  })
})

describe("applyMeta", () => {
  const PKG_NEW = "@opencode/ai/providers/openai-compatible"
  const PKG_OLD = "@ai-sdk/openai-compatible"
  test("默认值全填充", () => {
    const m = freshModel()
    applyMeta(m, catalog.opencode.models!["glm-5.3"]!, PKG_NEW)
    expect(m.limit).toEqual({ context: 131072, output: 16384, input: 65536 })
    expect(m.cost).toEqual([{ input: 1, output: 2, cache: { read: 0.1, write: 0.5 } }])
    expect(m.capabilities).toEqual({ tools: false, input: ["text"], output: ["text"], temperature: true })
    expect((m as any).compatibility).toEqual({ reasoningField: "reasoning_content" })
    expect(m.family).toBe("fam-opencode")
    expect(m.time.released).toBe(Date.parse("2026-08-01"))
    expect(m.status).toBe("beta")
    expect(m.variants).toEqual([
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "high", settings: { reasoningEffort: "high" } },
      { id: "max", settings: { reasoningEffort: "max" } },
    ])
  })
  test("用户已设 limit 不覆盖", () => {
    const m = freshModel()
    m.limit = { context: 999, output: 111 }
    applyMeta(m, catalog.opencode.models!["glm-5.3"]!, undefined)
    expect(m.limit).toEqual({ context: 999, output: 111 })
  })
  test("非 openai-compatible 不生成 variants", () => {
    const m = freshModel()
    applyMeta(m, catalog.opencode.models!["glm-5.3"]!, "@opencode/ai/providers/anthropic")
    expect(m.variants).toEqual([])
  })
  test("1.x 包名形态 @ai-sdk/openai-compatible 同样生成 variants", () => {
    const m = freshModel()
    applyMeta(m, catalog.opencode.models!["glm-5.3"]!, PKG_OLD)
    expect(m.variants.length).toBe(3)
  })
  test("非枚举 status 不映射", () => {
    const m = freshModel()
    applyMeta(m, { ...catalog.opencode.models!["glm-5.3"]!, status: "weird" }, undefined)
    expect(m.status).toBe("active")
  })
  test("平台默认 low/medium/high 会被目录选项覆盖", () => {
    const m = freshModel()
    m.variants = [
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "medium", settings: { reasoningEffort: "medium" } },
      { id: "high", settings: { reasoningEffort: "high" } },
    ]
    applyMeta(m, catalog.opencode.models!["glm-5.3"]!, PKG_NEW)
    expect(m.variants).toEqual([
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "high", settings: { reasoningEffort: "high" } },
      { id: "max", settings: { reasoningEffort: "max" } },
    ])
  })
  test("用户自定义 variants 不被覆盖", () => {
    const m = freshModel()
    m.variants = [{ id: "custom", settings: { reasoningEffort: "custom" } }]
    applyMeta(m, catalog.opencode.models!["glm-5.3"]!, PKG_NEW)
    expect(m.variants).toEqual([{ id: "custom", settings: { reasoningEffort: "custom" } }])
  })
})

describe("默认值检测", () => {
  test("isDefaultLimit / isDefaultCapabilities", () => {
    expect(isDefaultLimit({ context: 200_000, output: 32_000 })).toBe(true)
    expect(isDefaultLimit({ context: 128_000, output: 32_000 })).toBe(false)
    expect(isDefaultCapabilities({ tools: true, input: ["text", "image"], output: ["text"] })).toBe(true)
    expect(isDefaultCapabilities({ tools: false, input: ["text", "image"], output: ["text"] })).toBe(false)
  })

  test("isPlatformDefaultVariants 只认 low/medium/high", () => {
    expect(
      isPlatformDefaultVariants([
        { id: "low", settings: { reasoningEffort: "low" } },
        { id: "medium", settings: { reasoningEffort: "medium" } },
        { id: "high", settings: { reasoningEffort: "high" } },
      ]),
    ).toBe(true)
    expect(
      isPlatformDefaultVariants([
        { id: "low", settings: { reasoningEffort: "low" } },
        { id: "high", settings: { reasoningEffort: "high" } },
        { id: "max", settings: { reasoningEffort: "max" } },
      ]),
    ).toBe(false)
    expect(isPlatformDefaultVariants([{ id: "custom", settings: { reasoningEffort: "custom" } }])).toBe(false)
  })
})


describe("mirrorMeta", () => {
  const source: any = {
    id: "deepseek-flash",
    modelID: "deepseek-flash",
    providerID: "deepseek",
    package: "@opencode/ai/providers/deepseek",
    settings: { baseURL: "https://api.deepseek.com" },
    name: "DeepSeek V4.1 Flash 1017",
    enabled: false,
    limit: { context: 1000000, output: 393216 },
    cost: [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }],
    capabilities: { tools: true, input: ["text", "image"], output: ["text"], temperature: true },
    compatibility: { reasoningField: "reasoning_content" },
    variants: [
      { id: "none", body: { thinking: { type: "disabled" } } },
      { id: "low", settings: { reasoningEffort: "low" }, body: { thinking: { type: "enabled" } } },
    ],
    family: "deepseek-flash",
    time: { released: 1792195200000 },
    status: "active",
  }

  test("只拷白名单元数据, 不碰身份/连接字段", () => {
    const target: any = {
      id: "deepseek-flash",
      modelID: "deepseek/deepseek-flash",
      providerID: "deepseek-litellm",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: "https://litellm.example/v1" },
      name: "DeepSeek Flash (LiteLLM)",
      enabled: true,
    }
    expect(mirrorMeta(target, source)).toBe(true)
    expect(target.limit).toEqual(source.limit)
    expect(target.capabilities).toEqual(source.capabilities)
    expect(target.compatibility).toEqual(source.compatibility)
    expect(target.variants).toEqual(source.variants)
    expect(target.time).toEqual(source.time)
    expect(target.id).toBe("deepseek-flash")
    expect(target.modelID).toBe("deepseek/deepseek-flash")
    expect(target.providerID).toBe("deepseek-litellm")
    expect(target.package).toBe("@opencode/ai/providers/openai-compatible")
    expect(target.name).toBe("DeepSeek Flash (LiteLLM)")
    expect(target.enabled).toBe(true)
  })

  test("深拷贝: 修改目标不影响源", () => {
    const target: any = {}
    mirrorMeta(target, source)
    target.variants[0].id = "changed"
    expect(source.variants[0].id).toBe("none")
  })

  test("源为空返回 false", () => {
    expect(mirrorMeta({}, undefined)).toBe(false)
    expect(mirrorMeta({}, null)).toBe(false)
  })
})
