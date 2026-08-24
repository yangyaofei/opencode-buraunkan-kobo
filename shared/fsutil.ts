// 原子写: tmp + rename。读方永远看到完整旧文件或完整新文件, 不会读到半写状态;
// 写失败清理残片(曾因 ENOSPC 留下半写文件占满磁盘)。

import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

export function atomicWrite(file: string, content: string | Buffer, mode?: number): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  try {
    writeFileSync(tmp, content)
    if (mode !== undefined) chmodSync(tmp, mode)
    renameSync(tmp, file)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {}
    throw e
  }
}
