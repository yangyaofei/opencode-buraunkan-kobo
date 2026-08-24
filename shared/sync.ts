// 自更新(借鉴 opencode-acp startAutoUpdate + quota-retry git 通道):
//
// 机制: git 安装的插件 opencode 只装一次(缓存 ~/.cache/opencode/packages/),
// 之后不再拉取。本模块在节流窗口内用一次 git ls-remote 比对远端 HEAD:
//   - 本 wrapper 已装 commit != 远端 HEAD → 删除自己的 wrapper →
//     下次启动 opencode 原生补装最新版(这就是"用 opencode 自己的机制")。
//   - config 行钉死了 commit(#40位sha) → 永不自动更新(acp isAutoUpdatableSpec 模式)。
//
// 节流 + 去重: 三个插件共享一份状态文件(cache/opencode/buraunkan-kobo/sync.json),
// 窗口(默认 24h)内只有第一个加载的插件做网络检查, 其余直接复用 head;
// 网络失败不推进 lastCheck, 下次启动重试。
//
// 配置 ~/.config/opencode/buraunkan-kobo.jsonc:
//   { "sync": { "enabled": true, "throttleHours": 24, "repo": "yangyaofei/opencode-buraunkan-kobo" } }
//
// 闭包边界(不改什么):
//   - 只删自己的 wrapper, 不碰别的插件
//   - ls-remote 10s 超时, 异步执行不阻塞启动
//   - 删除失败静默, 下次启动再试
//   - 本地 file:// 开发(无 node_modules 包装层) → 自动 no-op

import { execFile } from "node:child_process"
import { readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadJsonc } from "./jsonc"
import { atomicWrite } from "./fsutil"
import { cacheDir, configDir } from "./paths"

export const PACKAGE_NAME = "opencode-buraunkan-kobo"
export const DEFAULT_REPO = "yangyaofei/opencode-buraunkan-kobo"
const DEFAULT_THROTTLE_MS = 24 * 3600_000

type SyncConfig = { enabled?: boolean; throttleHours?: number; repo?: string }
type KoboConfig = { sync?: SyncConfig }
type SyncState = { lastCheck: number; head?: string }

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

function koboConfigFile(): string {
  return path.join(configDir(), "opencode", "buraunkan-kobo.jsonc")
}

function stateFile(): string {
  return path.join(cacheDir(), "opencode", "buraunkan-kobo", "sync.json")
}

// 从模块路径逐级向上找 package.json name 匹配的目录(acp findPackageDir 模式;
// 不依赖文件在包内的位置, plugins/ 子目录同样工作)
export function findPackageDir(name: string): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (readJson(path.join(dir, "package.json"))?.name === name) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

// wrapper = npm 管理的安装目录(含 package.json + node_modules)。
// 包目录的直接父目录必须是 node_modules, 且 wrapper 依赖里声明了本包
// (dep key = 安装别名 = 包目录名)
export function findWrapperDir(packageDir: string): string | undefined {
  const parent = path.dirname(packageDir)
  if (path.basename(parent) !== "node_modules") return undefined
  const wrapper = path.dirname(parent)
  const alias = path.basename(packageDir)
  return readJson(path.join(wrapper, "package.json"))?.dependencies?.[alias] !== undefined ? wrapper : undefined
}

// wrapper 依赖声明里的 spec(形如 "github:owner/repo#ref"):
// 钉死 40 位 commit → undefined(永不自动更新); #branch → 分支名; 无 # → master
function wrapperRef(wrapper: string, alias: string): string | undefined {
  const dep = readJson(path.join(wrapper, "package.json"))?.dependencies?.[alias]
  if (typeof dep !== "string") return undefined
  const m = dep.match(/#([^#]+)$/)
  if (m) return /^[0-9a-f]{40}$/.test(m[1]) ? undefined : m[1]
  return "master"
}

// 当前已安装 commit: wrapper package-lock.json 的 resolved 字段里的 sha
function currentCommit(wrapper: string): string | undefined {
  const lock = readJson(path.join(wrapper, "package-lock.json"))
  for (const entry of Object.values(lock?.packages ?? {})) {
    const resolved = (entry as { resolved?: unknown })?.resolved
    if (typeof resolved === "string") {
      const m = resolved.match(/#([0-9a-f]{40})$/)
      if (m) return m[1]
    }
  }
  return undefined
}

function lsRemoteHead(repo: string, ref: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-remote", `https://github.com/${repo}.git`, `refs/heads/${ref}`],
      { timeout: 10_000 },
      (err, stdout) => {
        if (err) return resolve(undefined)
        resolve(stdout.split(/\s+/)[0] || undefined)
      },
    )
  })
}

// 入口: 每个插件加载时调用一次(fire-and-forget)。notify 会在删除发生后延迟 5s
// 被调用(此刻仍在 bootstrap 期, 立即发的 toast 会丢失)
export async function maybeSync(notify: (title: string, message: string) => void): Promise<void> {
  const cfg = (loadJsonc<KoboConfig>(koboConfigFile(), PACKAGE_NAME) ?? {}).sync ?? {}
  if (cfg.enabled === false) return

  const packageDir = findPackageDir(PACKAGE_NAME)
  if (!packageDir) return
  const wrapper = findWrapperDir(packageDir)
  if (!wrapper) return
  const alias = path.basename(packageDir)
  const ref = wrapperRef(wrapper, alias)
  if (!ref) return // 钉死 commit, 不自动更新

  // 节流 + 去重: 窗口内直接复用共享状态里的 head
  const file = stateFile()
  const state = readJson(file) as SyncState | undefined
  const throttleMs = cfg.throttleHours !== undefined ? Math.max(0, cfg.throttleHours) * 3600_000 : DEFAULT_THROTTLE_MS
  let head = state?.head
  if (!head || Date.now() - state.lastCheck >= throttleMs) {
    const fetched = await lsRemoteHead(cfg.repo ?? DEFAULT_REPO, ref)
    if (!fetched) return // 网络失败: 不推进 lastCheck, 下次启动重试
    head = fetched
    atomicWrite(file, JSON.stringify({ lastCheck: Date.now(), head }, null, 2))
  }

  const cur = currentCommit(wrapper)
  if (!cur || cur === head) return
  try {
    rmSync(wrapper, { recursive: true, force: true })
  } catch {
    return // 删除失败: 静默, 下次启动再试
  }
  // toast 必须延迟(bootstrap 期 TUI 未挂载完成, 立即发会丢失)
  setTimeout(() => {
    notify(`${alias} 已同步`, "检测到新版本, 旧副本已删除, 重启 opencode 生效")
  }, 5000)
}
