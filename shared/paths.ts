// XDG 感知的标准目录，与 opencode 自身行为一致（opencode 用 xdg-basedir，所有平台默认 ~/.cache）

import { homedir } from "node:os"
import path from "node:path"

export function configDir(): string {
  return process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config")
}

export function dataDir(): string {
  return process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share")
}

export function stateDir(): string {
  return process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state")
}

export function cacheDir(): string {
  return process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache")
}
