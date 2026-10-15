// catalog-bridge 2.0 — 插件入口。
//
// 机制(修正版): ctx.model.transform + editor.models.update, 只补"不在 models.dev
// 目录里的 provider"(= 用户自定义 provider, 与 1.x 语义一致)。内置 provider 的
// 元数据由官方 models.dev 通道自带, 不碰——它们的模型对象在重放中来自冻结的
// 目录快照, 写入会抛错并禁用插件(实验结论, 见 README)。
//
// 顺序(官方 config/plugin/provider.ts 注释): 外部 model transform 在官方
// "late registration" config 覆盖之前跑 → 用户在 opencode.jsonc 手写的字段
// 之后由官方应用, 天然不覆盖(V1 的"不覆盖手写值"由平台保证)。

import {
  applyMeta,
  findModelMeta,
  loadCatalogSync,
  refreshCatalog,
  type Catalog,
  type CatalogModel,
} from "./catalog"

type Ctx = {
  model: {
    transform: (cb: (editor: ModelEditor) => void) => Promise<unknown>
    reload: () => Promise<unknown>
  }
}

type ModelEditor = {
  list: (providerID?: string) => any[]
  update: (providerID: string, modelID: string, update: (model: any) => void) => void
  provider: {
    list: () => Array<{ provider: { id: string; canonical?: string; package?: string } }>
    get: (providerID: string) => { provider: { id: string; canonical?: string; package?: string } } | undefined
  }
}

function isCatalogProvider(catalog: Catalog, id: string, canonical?: string): boolean {
  return catalog[id] !== undefined || (canonical !== undefined && catalog[canonical] !== undefined)
}

export default {
  id: "catalog-bridge",
  setup: async (ctx: Ctx) => {
    let memory: Catalog = loadCatalogSync() ?? {}

    const patchAll = (editor: ModelEditor): number => {
      let patched = 0
      try {
        for (const def of editor.provider.list()) {
          const providerID = def.provider.id
          // 只补自定义 provider: 目录里已有的(按 id 或 canonical)跳过
          if (isCatalogProvider(memory, providerID, def.provider.canonical)) continue
          const pkg = def.provider.package
          for (const model of editor.list(providerID)) {
            const meta = findModelMeta(memory, model.id)
            if (!meta) continue
            const before = JSON.stringify(model)
            editor.update(providerID, model.id, (draft) => applyMeta(draft, meta as CatalogModel, pkg))
            patched += JSON.stringify(model) !== before ? 1 : 0
          }
        }
      } catch (err) {
        console.error("[catalog-bridge] patch error:", err)
      }
      return patched
    }

    await ctx.model.transform((editor) => {
      const n = patchAll(editor)
      if (n > 0) console.log(`[catalog-bridge] 补全 ${n} 个自定义 provider 模型的元数据`)
    })

    // 异步刷新 catalog(TTL 过期), 成功后触发重放应用新数据
    void (async () => {
      const fresh = await refreshCatalog()
      if (fresh) {
        memory = fresh
        await ctx.model.reload()
      }
    })()

    return () => {}
  },
}
