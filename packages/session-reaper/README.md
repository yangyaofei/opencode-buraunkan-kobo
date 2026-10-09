# session-reaper (opencode 2.0)

会话收割器。从 1.x `plugins/session-reaper.ts` 移植，基于 opencode 2.0 插件 API。

## 安装与启用

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugin": ["/<本仓库路径>/packages/session-reaper"]
}
```

- 一个包 = 一个插件（2.0 加载契约：默认导出 `{ id, setup }`），删行即停用。
- 与 1.x 版的功能/配置项逐项对照见 [docs/v1-v2-parity.md](../../docs/v1-v2-parity.md)。

## 功能

`/session-reaper` 命令四个子动作：

- `run --pipeline <name> <prompt>`：收割超期/溢出会话 → 当前会话登记进桶 → 将剩余 prompt 重新发给模型（`ctx.session.prompt`）。
- `status`：查看各桶登记状态与生效配置。
- `set --pipeline <name> [--keep-days N] [--max-sessions M] [--remove]`：设置/查看/删除 pipeline 显式配置（落盘 `~/.config/opencode/session-reaper.jsonc`）。
- `reap`：只执行收割，不登记不 re-drive。

registry 落 `~/.local/state/opencode/session-reaper/registry.json`（XDG_STATE_HOME 可覆盖），行为日志 `log.jsonl`（保留最近 100 条）。

## 与 1.x 的差异

- **会话删除**：用插件原生 `ctx.session.remove({ sessionID })`（opencode ≥ 2.0.24 起插件 session 域暴露 remove），进程内直调、递归删子会话，任何部署方式都可用，无子进程、无密码/端口依赖。**要求 opencode ≥ 2.0.24**（更低版本删除会失败并保留会话，其他功能不受影响）。删除失败（404/`not found`）视为已删（幂等），其他失败保留会话待下次收割。
- **环境注入**：1.x 通过 `shell.env` hook 注入 `OPENCODE_SESSION_ID`；2.0 的 shell hook 无 sessionID 维度，已放弃（辅助功能）。
- **零模型回复**：1.x 用 `noReply` + ignored parts + 哨兵异常 hack；2.0 用官方 `ctx.session.synthetic`。

## 已知限制（2.0.15 平台行为）

同一 session 中，首条 synthetic 之后 runner 可能不再主动消费 inbox——后续命令回复滞留在 `/api/session/:id/inbox`，该 session 下次 agent loop 运行（如下一条用户消息）时才显示。回复不会丢失，仅显示延迟。

## 配置

`~/.config/opencode/session-reaper.jsonc`（全局）或 `<project>/.opencode/session-reaper.jsonc`（项目）：

```jsonc
{
  "defaultKeepDays": 30,     // 默认保留天数（桶内未显式配置时）
  "pipelines": {
    "my-pipeline": { "keepDays": 7, "maxSessions": 5 }
  }
}
```

## 安装

```jsonc
{ "plugin": ["/path/to/opencode-buraunkan-kobo/packages/session-reaper"] }
```

## 测试

- `bun test packages/session-reaper`（30 单测：parseArgs/effectiveRule/planReap/statusReport/parseJsonc）
- Docker 集成 15/15：命令分派、set 落盘、run re-drive、删除（404 幂等）、registry/log 校验
