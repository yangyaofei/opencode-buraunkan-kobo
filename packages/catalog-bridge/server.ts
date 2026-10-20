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
  mergePriority,
  mirrorMeta,
  refreshCatalog,
  type Catalog,
  type CatalogModel,
} from "./catalog"
import { loadConfig } from "./config"

type Ctx = {
  location?: { directory?: string }
  event: { subscribe: () => AsyncIterable<any> }
  model: {
    transform: (cb: (editor: ModelEditor) => void) => Promise<{ dispose: () => Promise<void> }>
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
    const cfg = loadConfig(ctx.location?.directory)
    const priority = mergePriority(cfg.preferredProviders)
    if (cfg.preferredProviders?.length) {
      console.log(`[catalog-bridge] 优先 provider: ${priority.join(" > ")}`)
    }

    // 按优先级找"平台已播种好的源 model 记录"(如 deepseek/deepseek-flash)。
    // 只读注册表, 不要求该 provider 被配置/可用, 也不发任何请求。
    const findSource = (editor: ModelEditor, modelID: string): any => {
      for (const pid of priority) {
        const found = editor.list(pid).find((m) => String(m.id) === modelID)
        if (found) return found
      }
      return undefined
    }

    const patchAll = (editor: ModelEditor): number => {
      let patched = 0
      try {
        for (const def of editor.provider.list()) {
          const providerID = def.provider.id
          // 只补自定义 provider: 目录里已有的(按 id 或 canonical)跳过
          if (isCatalogProvider(memory, providerID, def.provider.canonical)) continue
          const pkg = def.provider.package
          for (const model of editor.list(providerID)) {
            const source = findSource(editor, String(model.id))
            const meta = source ? null : findModelMeta(memory, model.id, priority)
            if (!source && !meta) continue
            const before = JSON.stringify(model)
            editor.update(providerID, model.id, (draft) => {
              if (source) mirrorMeta(draft, source)
              else applyMeta(draft, meta as CatalogModel, pkg)
            })
            patched += JSON.stringify(model) !== before ? 1 : 0
          }
        }
      } catch (err) {
        console.error("[catalog-bridge] patch error:", err)
      }
      return patched
    }

    let registration: { dispose: () => Promise<void> } | undefined
    const register = async () => {
      registration = await ctx.model.transform((editor) => {
        const n = patchAll(editor)
        if (n > 0) console.log(`[catalog-bridge] 补全 ${n} 个自定义 provider 模型的元数据`)
      })
    }
    await register()

    // 启动后补几次重注册: config provider 的晚注册 transform 可能在我们的 setup 之后才注册,
    // 几次之后顺序就稳定了(之后靠 provider.updated 维持)。
    const reRegister = async () => {
      try {
        await registration?.dispose()
      } catch {}
      await register()
    }
    const timers = [250, 1200, 4000].map((ms) => setTimeout(() => void reRegister().catch(() => {}), ms))

    // 平台的 config provider 插件会在外部 transform 之后"晚注册"自己的 transform,
    // 并把 variants 重算成默认值。provider 更新后重新注册, 让我们排在它之后。
    void (async () => {
      let last = 0
      try {
        for await (const ev of ctx.event.subscribe()) {
          if (String((ev as any)?.type ?? "") !== "provider.updated") continue
          const now = Date.now()
          if (now - last < 1000) continue
          last = now
          await reRegister()
        }
      } catch {}
    })()

    // 异步刷新 catalog(TTL 过期), 成功后触发重放应用新数据
    void (async () => {
      const fresh = await refreshCatalog()
      if (fresh) {
        memory = fresh
        await ctx.model.reload()
      }
    })()

    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  },
}
