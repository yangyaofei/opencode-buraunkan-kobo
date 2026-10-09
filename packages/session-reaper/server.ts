// session-reaper 2.0 — 插件入口(命令注册 + 分派 + 会话删除兜底)。

import {
  USAGE,
  appendLog,
  effectiveRule,
  loadConfig,
  loadRegistry,
  parseArgs,
  planReap,
  registryFileOf,
  saveConfig,
  saveRegistry,
  statusReport,
  ageText,
  type Entry,
} from "./reaper"

type Ctx = {
  location: { directory: string }
  session: {
    synthetic: (input: { sessionID: string; text: string; description?: string }) => Promise<unknown>
    prompt: (input: {
      sessionID: string
      text: string
      files?: unknown
      agents?: unknown
      skills?: unknown
      delivery?: string
    }) => Promise<unknown>
    // opencode >= 2.0.24 起插件 session 域暴露了 remove(整会话删除, 递归删子会话)。
    remove?: (input: { sessionID: string }) => Promise<unknown>
  }
  command: { transform: (cb: (editor: { add: (def: any) => void }) => void) => Promise<unknown> }
}

// 会话删除优先用插件原生 API ctx.session.remove(opencode >= 2.0.24): 进程内直调,
// 任何部署方式都可用。旧版本(无 remove)回退到子进程 CLI —— `opencode session delete`
// 连后台服务(与用户手动删除同一链路), 配置 deleteServer 时改连指定服务端。
// "not found" 视为已清理(幂等); 其余失败返回 false 保留在桶中下次重试。
async function deleteSession(
  ctx: Ctx,
  sessionID: string,
  deleteServer?: string,
): Promise<boolean> {
  const remove = ctx.session?.remove
  if (typeof remove === "function") {
    try {
      await remove({ sessionID })
      return true
    } catch (err: any) {
      const msg = String(err?.message ?? err)
      if (/not found|notfound|404/i.test(msg)) return true
      console.error(`[session-reaper] ctx.session.remove ${sessionID} failed: ${msg.slice(0, 200)}`)
      return false
    }
  }
  return await deleteSessionViaCli(sessionID, 20_000, deleteServer)
}

async function deleteSessionViaCli(
  sessionID: string,
  timeoutMs = 20_000,
  deleteServer?: string,
): Promise<boolean> {
  const { spawn } = await import("node:child_process")
  const bin = process.execPath
  const args = ["session", "delete"]
  if (deleteServer) args.push("--server", deleteServer)
  args.push(sessionID)
  return await new Promise<boolean>((resolve) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    child.stdout.on("data", () => {})
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve(false)
    }, timeoutMs)
    child.on("error", () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve(true)
      if (/not found|notfound|404/i.test(stderr)) return resolve(true)
      console.error(`[session-reaper] delete ${sessionID} failed (exit=${code}): ${stderr.trim().slice(0, 200)}`)
      resolve(false)
    })
  })
}

async function reapPipeline(
  ctx: Ctx,
  cfg: ReturnType<typeof loadConfig>,
  reg: Record<string, Entry[]>,
  pipeline: string,
): Promise<{ expired: Entry[]; overflow: Entry[]; reaped: Entry[]; failed: Entry[]; survivors: Entry[] }> {
  const rule = effectiveRule(cfg, pipeline)
  const { expired, overflow, survivors } = planReap(reg, pipeline, rule)
  const reaped: Entry[] = []
  const failed: Entry[] = []
  for (const e of [...expired, ...overflow]) {
    if (await deleteSession(ctx, e.id, cfg.deleteServer)) reaped.push(e)
    else failed.push(e)
  }
  return { expired, overflow, reaped, failed, survivors }
}

export default {
  id: "session-reaper",
  setup: async (ctx: Ctx) => {
    const projectDir = ctx.location?.directory ?? process.cwd()

    const reply = async (sessionID: string, text: string) => {
      // 注意: 同一 session 首条之后 runner 可能不再主动消费 inbox(2.0.15 平台行为),
      // 后续回复滞留 /api/session/:id/inbox, 该 session 下次 agent loop 运行时显示
      // —— 见 README "已知限制"
      await ctx.session.synthetic({ sessionID, text })
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "session-reaper",
        description: "pipeline session 治理：run(执行+登记) / status(状态) / set(配置) / reap(清理)",
        execute: async (input: any) => {
          const sessionID = String(input?.sessionID ?? "")
          if (!sessionID) return
          const parsed = parseArgs(String(input?.prompt?.text ?? ""))
          const cfg = loadConfig(projectDir)
          const registryFile = registryFileOf(cfg)

          // ---- 无 action / 未知 action: 用法提示(零模型) ----
          if (!parsed.action || !["run", "status", "set", "reap"].includes(parsed.action)) {
            await reply(sessionID, parsed.action ? `[session-reaper] 未知 action: ${parsed.action}\n\n${USAGE}` : USAGE)
            return
          }

          // ---- run: reap + register + prompt 逐字透传 ----
          if (parsed.action === "run") {
            if (!parsed.pipeline) {
              await reply(sessionID, `[session-reaper] run 需要 --pipeline <name>\n\n${USAGE}`)
              return
            }
            if (!parsed.prompt) {
              await reply(sessionID, `[session-reaper] run 需要在 flags 之后附带原始 prompt\n\n${USAGE}`)
              return
            }
            const reg = loadRegistry(registryFile)
            const { expired, overflow, reaped, failed, survivors } = await reapPipeline(ctx, cfg, reg, parsed.pipeline)
            for (const e of reaped) console.log(`[session-reaper] reaped ${parsed.pipeline} ${e.id}`)
            const now = Date.now()
            const kept = [...survivors, ...failed]
              .filter((e) => e.id !== sessionID)
              .sort((a, b) => a.created - b.created)
            kept.push({ id: sessionID, created: now })
            reg[parsed.pipeline] = kept
            saveRegistry(registryFile, reg)
            appendLog(cfg, registryFile, {
              ts: now,
              event: "run",
              pipeline: parsed.pipeline,
              sessionID,
              registered: sessionID,
              expired: expired.length,
              overflow: overflow.length,
              reaped: reaped.map((e) => e.id),
              failed: failed.map((e) => e.id),
              bucket: kept.length,
            })
            console.log(`[session-reaper] registered ${parsed.pipeline} ${sessionID} (bucket=${kept.length})`)
            // agent 看到的 prompt 与原始完全一致: 剥掉 action/flags, 剩余原样
            await ctx.session.prompt({
              sessionID,
              text: parsed.prompt,
              files: input?.prompt?.files,
              agents: input?.prompt?.agents,
              skills: input?.prompt?.skills,
              delivery: input?.delivery,
            })
            return
          }

          // ---- status: 桶状态报告(零模型) ----
          if (parsed.action === "status") {
            await reply(sessionID, statusReport(cfg, loadRegistry(registryFile), registryFile))
            return
          }

          // ---- set: 配置 upsert / 查看 / 删除(零模型) ----
          if (parsed.action === "set") {
            if (!parsed.pipeline) {
              await reply(sessionID, `[session-reaper] set 需要 --pipeline <name>\n\n${USAGE}`)
              return
            }
            const name = parsed.pipeline
            if (parsed.remove) {
              if (cfg.pipelines?.[name] !== undefined) {
                delete cfg.pipelines[name]
                saveConfig(cfg)
                appendLog(cfg, registryFile, { ts: Date.now(), event: "set", pipeline: name, sessionID, change: "remove" })
                await reply(sessionID, `[session-reaper] 已删除 ${name} 的显式配置(回落 default*)`)
                return
              }
              await reply(sessionID, `[session-reaper] ${name} 无显式配置，无需删除`)
              return
            }
            const bad: string[] = []
            if (parsed.keepDays !== undefined && (!Number.isInteger(parsed.keepDays) || parsed.keepDays < 0))
              bad.push("--keep-days 需为非负整数")
            if (parsed.maxSessions !== undefined && (!Number.isInteger(parsed.maxSessions) || parsed.maxSessions < 0))
              bad.push("--max-sessions 需为非负整数")
            if (bad.length) {
              await reply(sessionID, `[session-reaper] 参数错误: ${bad.join("; ")}`)
              return
            }
            if (parsed.keepDays !== undefined || parsed.maxSessions !== undefined) {
              cfg.pipelines = cfg.pipelines ?? {}
              const cur = cfg.pipelines[name] ?? {}
              cfg.pipelines[name] = {
                ...cur,
                ...(parsed.keepDays !== undefined ? { keepDays: parsed.keepDays } : {}),
                ...(parsed.maxSessions !== undefined ? { maxSessions: parsed.maxSessions } : {}),
              }
              saveConfig(cfg)
              appendLog(cfg, registryFile, {
                ts: Date.now(),
                event: "set",
                pipeline: name,
                sessionID,
                change: {
                  ...(parsed.keepDays !== undefined ? { keepDays: parsed.keepDays } : {}),
                  ...(parsed.maxSessions !== undefined ? { maxSessions: parsed.maxSessions } : {}),
                },
              })
              await reply(
                sessionID,
                `[session-reaper] ${name} 配置已更新: keepDays=${cfg.pipelines[name].keepDays ?? "(未设)"} maxSessions=${cfg.pipelines[name].maxSessions ?? "(未设)"}`,
              )
              return
            }
            // 无修改参数 = 查看当前生效配置
            const rule = effectiveRule(loadConfig(projectDir), name)
            await reply(
              sessionID,
              `[session-reaper] ${name}: keepDays=${rule.keepDays ?? "不清理"} maxSessions=${rule.maxSessions ?? "不限"} (${rule.explicit ? "显式配置" : "default 兜底"})\n改变行为: /session-reaper set --pipeline ${name} --keep-days N --max-sessions M`,
            )
            return
          }

          // ---- reap: 立即清理并报告(零模型) ----
          if (parsed.action === "reap") {
            if (!parsed.pipeline) {
              await reply(sessionID, `[session-reaper] reap 需要 --pipeline <name>\n\n${USAGE}`)
              return
            }
            const reg = loadRegistry(registryFile)
            const { expired, overflow, reaped, failed, survivors } = await reapPipeline(ctx, cfg, reg, parsed.pipeline)
            reg[parsed.pipeline] = [...survivors, ...failed]
            saveRegistry(registryFile, reg)
            appendLog(cfg, registryFile, {
              ts: Date.now(),
              event: "reap",
              pipeline: parsed.pipeline,
              sessionID,
              expired: expired.length,
              overflow: overflow.length,
              reaped: reaped.map((e) => e.id),
              failed: failed.map((e) => e.id),
              bucket: survivors.length + failed.length,
            })
            const lines = [
              `[session-reaper] reap ${parsed.pipeline}: 删除 ${reaped.length}, 失败 ${failed.length}, 存活 ${survivors.length}`,
            ]
            for (const e of reaped) lines.push(`  已删除 ${e.id} (${ageText(e.created, Date.now())})`)
            for (const e of failed) lines.push(`  删除失败(保留重试) ${e.id}`)
            await reply(sessionID, lines.join("\n"))
            return
          }
        },
      })
    })
  },
}
