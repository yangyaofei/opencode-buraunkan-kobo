// 自门控: 一个仓库承载多个插件, 每个安装别名(如 quota-retry@git+...)只激活
// 自己的那个导出。git 别名安装时 opencode 把整包放进
//   ~/.cache/opencode/packages/<别名>@git+https:/.../node_modules/<别名>/
// 同一模块的所有函数导出都会被加载, 门控靠"路径里的别名"识别身份:
//   - 别名 == 自己的名字 → 激活
//   - 别名 != 自己的名字 → 返回空 hooks(该副本是给别的插件装的)
//   - 无别名段(本地 file:// 开发 / plugins 目录) → 全部激活

import path from "node:path"
import { fileURLToPath } from "node:url"

export function installedAlias(): string | undefined {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const m = dir.match(/packages[/\\]([^/@\\]+)@git\+/)
    return m ? decodeURIComponent(m[1]) : undefined
  } catch {
    return undefined
  }
}

export function gateActive(alias: string): boolean {
  const installed = installedAlias()
  if (!installed) return true
  return installed === alias
}
