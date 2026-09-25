# quota-retry (opencode 2.0)

配额 429 精确等待重试。从 1.x `plugins/quota-retry.ts` 移植，基于 opencode 2.0 插件 API。

## 安装与启用

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugin": ["/<本仓库路径>/packages/quota-retry"]
}
```

- 一个包 = 一个插件（2.0 加载契约：默认导出 `{ id, setup }`），删行即停用。
- 与 1.x 版的功能/配置项逐项对照见 [docs/v1-v2-parity.md](../../docs/v1-v2-parity.md)。

## 功能

- `session.retry` hook：捕获 provider 错误，识别配额类 429（`AccountQuotaExceeded` / `usage quota` / `使用上限` / code 1308），计算到配额重置时刻的等待时长，设置 `decision = { retry: true, delay }`。
- 等待时长不封顶（原生 15 分钟 `RETRY_AFTER_MAX` 上限不适用于 hook 设置的 delay，已实测 16 分钟）。
- 智谱配额 API（`open.bigmodel.cn/api/monitor/usage/quota/limit`）获取精确重置时刻，带 60s 缓存。
- 429 body 中提取重置时间（`resetExtract` 正则，无时区后缀按 +08:00 解析，与 1.x 一致）。
- **轮次续命（无限次数）**：原生 10 次耗尽后，从事件流捕获 `execution.failed`，revert 删掉（上轮内部标记 / 失败 assistant），注入 `text=""` 的 synthetic 通知行（`description = "quota-retry · 第 N 轮 · 内部标记(不发给模型)"`，前台可见、每轮覆写）。空 synthetic 经 inbox 驱动新执行 = 全新 10 次原生重试。无限轮。
- **出口净化**：`http.request` hook 剥掉空 synthetic 在出站请求里映射的尾部空 user 消息——第 2+ 轮请求与原始 turn 字节级一致（Docker 实测 45 次 429 全程同 hash、无空消息）。
- 用户接管：续命过程中用户发新消息自动停止续命让位。
- `quota_retry_status` 工具 + `/retry-setting` 命令（`ctx.session.synthetic` 零模型回复）。

## 与 1.x 的差异

| 1.x | 2.0 |
|---|---|
| 二进制补丁 `maxRetries=-1`（无限次数） | 轮次续命（见下） |
| hook 改 delay + 补丁改次数 | hook 改 delay + 轮次续命（每轮原生 10 次, 无限轮） |
| on-demand 降级链（虚模型跨 provider） | 未移植（2.0 模型注册机制不同，后续版本） |

**轮次续命说明**：opencode 2.0.15 出货二进制的核心重试逻辑（`packages/core/src/session/runner/retry.ts`）编译为 JSC bytecode，1.x 的明文锚点补丁路线失效（已实验证明）。替代方案 = 轮次续命：原生 10 次耗尽 → 删失败记录 + 空标记驱动新执行 → 全新 10 次。对模型的请求始终与原始 turn 一致（工具/思考历史完整保留、零重跑）；前台每次重试都是原生徽标（attempt + 倒计时），轮次边界是一行覆写刷新的通知行。

**部署约束（重要）**：轮次续命的 revert 没有插件 API（2.0.15 插件 session 域无 remove/revert），只能走本地 HTTP。要求 opencode 以固定端口 + 密码运行 serve，客户端连它：

```bash
OPENCODE_PASSWORD=xxx opencode serve --port 18082     # 服务端(本机)
opencode --server http://127.0.0.1:18082              # TUI/客户端
```

插件从 `OPENCODE_PASSWORD` 环境变量读同一密码（serve 进程内可见）。端口可用配置 `serverPort` 或环境变量 `RETRY_SERVER_PORT` 覆盖（默认 18082）。不满足此约束时轮内精确等待仍然工作，只有轮次续命不可用。

## 配置

`~/.config/opencode/quota-retry.jsonc`（全局）或 `<project>/.opencode/quota-retry.jsonc`（项目）：

```jsonc
{
  "providers": [
    {
      "id": "volces-ark",
      "quota": "body",                       // 匹配方式: body | zhipu
      "quotaMatch": "AccountQuotaExceeded",  // 可选, 自定义匹配
      "resetExtract": "reset at\\s+((?:\\d{4}-\\d{2}-\\d{2})\\s+\\d{2}:\\d{2}:\\d{2})",
      "fallbackWaitMs": 30000,
      "bufferMs": 10000
    }
  ],
  "quotaCacheMs": 60000,
  "maxRounds": -1,
  "serverPort": 18082
}
```

## 安装

```jsonc
// ~/.config/opencode/opencode.jsonc
{ "plugin": ["/path/to/opencode-buraunkan-kobo/packages/quota-retry"] }
```

## TUI 可见性

重试期间底部显示 `⚠ Retrying in NNNs · attempt N · <错误>`（来自 `session.retry.scheduled` 事件，delay 直接采用插件计算值，倒计时无上限）。

## 测试

- `bun test packages/quota-retry`（19 单测）
- Docker 集成：mock 429 场景验证 12-hit 重试链、delay 采纳、16 分钟封顶突破（见 `tmp/dockerbuild/`）
