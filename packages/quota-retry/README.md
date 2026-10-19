# quota-retry (opencode 2.0)

配额 429 精确等待重试。从 1.x `plugins/quota-retry.ts` 移植，基于 opencode 2.0 插件 API。

## 安装与启用

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [
    // 从 git 装(机器上用这个): "git+https://github.com/yangyaofei/opencode-buraunkan-kobo.git#master::path:packages/quota-retry",
    "/<本仓库路径>/packages/quota-retry"]
}
```

- 一个包 = 一个插件（2.0 加载契约：默认导出 `{ id, effect }`，effect 形态），删行即停用。
- 与 1.x 版的功能/配置项逐项对照见 [docs/v1-v2-parity.md](../../docs/v1-v2-parity.md)。

## 功能

- **响应驱动判定（对齐 1.x）**：`http.response` hook 捕获原始响应（状态码 ∈ `statuses`，默认 `[429]`），正文命中 `quotaMatch`（`AccountQuotaExceeded` / `usage quota` / `使用上限` / code 1308）即判定"配额耗尽"；`session.retry` hook 据此计算到配额重置时刻的等待时长并设置 `decision = { retry: true, delay }`。**第一次 429 就接管**（1.x 直接看响应本体；2.0 此前只看 opencode 归纳出的错误文案，会晚一轮）。非配额 429（并发限流等）与其它状态码一律放行，交回 opencode 原生退避——与 1.x 行为一致。
- 等待时长不封顶（原生 15 分钟 `RETRY_AFTER_MAX` 上限不适用于 hook 设置的 delay，已实测 16 分钟）。
- 智谱配额 API（`open.bigmodel.cn/api/monitor/usage/quota/limit`）获取精确重置时刻，带 60s 缓存。
- 429 body 中提取重置时间（`resetExtract` 正则，无时区后缀按 +08:00 解析，与 1.x 一致）。
- **轮次续命（无限次数）**：原生 10 次耗尽后，从事件流捕获 `execution.failed`，注入一条 synthetic 通知行驱动新执行（= 全新 10 次原生重试，无限轮）。标记的 `text = "EL-PSY-CONGROO-quota-retry-round-" + 随机 token`（出口按"前缀 + 随机 token"形状精确剥除），`description = "quota-retry round · 第 N 轮"` 前台可见（长前缀不出现在界面），消息 `id` 由插件自指定（`msg_quota-retry_rN_xxx`）。不删失败现场——revert 无插件 API，已提上游 issue。
- **续命触发可配置**（`continueOn`）：默认对齐 1.x `maxRetries=-1` 的语义——opencode 原生会重试的那一类错误（`provider.quota` / `provider.rate-limit` / `provider.internal` / `provider.transport` / `provider.invalid-output` / `provider.unknown`）以及 429 + 全部 5xx；`denyTypes`（默认 auth / content-filter / invalid-request / unsupported-operation / no-route）一票否决；可用 `types` / `statuses` / `match` 正则覆盖默认（例如让某些 400 也续命）。
- **出口净化**：`http.request` hook 剥掉"标记"映射出的 user 消息——**按标记文本判定（任意位置都剥），不按"空"判定**（空 user 可能是用户真的发了空串）。标记的完整形状 = 前缀 + 纯随机 token（小写字母/数字，≥6 位），只剥完整形状，用户消息哪怕以同样前缀开头、后面还有文字也不会被误删。轮次前缀 `EL-PSY-CONGROO-quota-retry-round-`，心跳前缀 `EL-PSY-CONGROO-quota-retry-heartbeat-`；已部署版本发过的旧前缀（`quota-retry-round-` / `quota-retry-heartbeat-`）继续兼容。第 2+ 轮请求与原始 turn 字节级一致（Docker 实测 45 次 429 全程同 hash、无残留标记消息）；标记后面出现真实内容（等待结束模型继续）时同样被剥掉，不会进入模型请求。
- **运行日志（默认关闭，排查时开）**：配置 `logFile: true` 打开（默认路径 `~/.cache/opencode/buraunkan/quota-retry.log`，512KB 上限自动截断），或给自定义路径；缺省 / `false` = 关闭。只记关键决策：判定命中与算出的等待、心跳发送/失败、加载/卸载与错误 —— 用于事后定位"等待为什么没撑住"这类问题。
- 用户接管：续命过程中用户发新消息自动停止续命让位。
- `quota_retry_status` 工具 + `/retry-setting` 命令（`ctx.session.synthetic` 零模型回复）。

## 与 1.x 的差异

| 1.x | 2.0 |
|---|---|
| 二进制补丁 `maxRetries=-1`（无限次数） | 轮次续命（见下） |
| hook 改 delay + 补丁改次数 | hook 改 delay + 轮次续命（每轮原生 10 次, 无限轮） |
| on-demand 降级链 | 已移除（2.0 无模型路由能力，见 issue #2） |

## 轮次续命

**轮次续命说明**：opencode 2.0 出货二进制的核心重试逻辑（`packages/core/src/session/runner/retry.ts`）编译为 JSC bytecode，1.x 的明文锚点补丁路线失效（已实验证明）。替代方案 = 轮次续命：原生 10 次耗尽 → 标记 synthetic 驱动新执行 → 全新 10 次。前台每次重试都是原生徽标（attempt + 倒计时），轮次边界是一行通知行；发给模型的请求由出口净化保持干净（标记文本按前缀被剥除）。

**已知代价（纯插件 API 的取舍）**：revert 没有插件 API（插件 session 域无 revert，已提上游 issue；本仓库 issue #3 跟踪），续命不删失败现场——每轮累积一条失败 assistant 和一条轮次标记（10 轮 ≈ 消息列表多 20 条记录，界面噪音）；不影响功能，工具/思考历史完整保留。发给模型的请求不受影响（标记被剥除，失败 assistant 无内容不入请求）。

**零进程外依赖**：全部走插件 API（`ctx.session`/`ctx.event`），无端口/密码/HTTP 约束，任何部署方式（serve / service / TUI / 托管）行为一致。

## 配置

`~/.config/opencode/quota-retry.jsonc`（全局）或 `<project>/.opencode/quota-retry.jsonc`（项目）：

```jsonc
{
  "providers": [
    {
      "id": "volces-ark",
      "quota": "body",                       // 匹配方式: body | zhipu
      "statuses": [429],                     // 可选, 配额入口状态码(默认 [429]; 可加 5xx/其它 4xx)
      "quotaMatch": "AccountQuotaExceeded",  // 可选, 自定义匹配
      "resetExtract": "reset at\\s+((?:\\d{4}-\\d{2}-\\d{2})\\s+\\d{2}:\\d{2}:\\d{2})",
      "fallbackWaitMs": 30000,
      "bufferMs": 10000
    }
  ],
  "quotaCacheMs": 60000,
  "logFile": true,            // 可选; 默认关闭。true = 默认路径, 字符串 = 自定义路径
  "maxRounds": -1,
  "heartbeatMs": 2700000,     // 长等待心跳间隔(默认 45 分钟; 0 = 关闭)
  // 续命触发策略(可选; 缺省 = 可重试类型 + 429/5xx)
  "continueOn": {
    "types": ["provider.quota", "provider.rate-limit", "provider.internal", "provider.transport"],
    "statuses": [429, 500, 502, 503, 504],
    "denyTypes": ["provider.auth", "provider.content-filter"],
    "match": "rate limited|endpoint is unavailable"   // 某些 400/自定义文案也续命
  }
}
```

- `continueOn.types` / `statuses` / `match` 任一命中即续命；`denyTypes` 优先（默认含 auth/content-filter/invalid-request/unsupported-operation/no-route）。要在默认 deny 的类型上续命，需显式把它从 `denyTypes` 移除（如 `"denyTypes": []`）。
- `continueOn.statuses` 缺省 = 429 与全部 5xx。
- `heartbeatMs`（默认 2700000 = 45 分钟）：**长等待心跳**。opencode 的 location 不活动回收在 60 分钟内没有 durable 会话事件时会以 `reason: "inactivity"` 打断正在等待的执行（`packages/core/src/location-activity.ts`：TTL 写死 60 分钟、只被"带 location 的 durable 会话事件"刷新、无配置口），而"等待配额重置"期间不产生任何事件，所以超过 60 分钟的等待会被掐断（实测：等待开始后 61 分钟 `location services evicted` + `outcome=interrupted`）。心跳 = 等待期间每 45 分钟落一条 durable 标记（`session.synthetic`，`resume: false` → 只入队不唤醒，**不打断睡眠**），让 TTL 持续被刷新；标记文本用独立前缀 `EL-PSY-CONGROO-quota-retry-heartbeat-`（与轮次标记一样按"前缀 + 随机 token"形状在出口剥除，任意位置），**不进入模型请求**；界面只显示 `quota-retry heartbeat · 内部标记(不发给模型)` 这行标签，长前缀不出现在界面。等待本身仍是一次到重置点（不切段）。代价：每次心跳在会话里多一条标记行。设 `0` 关闭。
  - **实现方式（effect 形态的原因）**：心跳是**插件自己的定时 fiber**——每个长等待 `Effect.forkScoped` 一个 `Effect.sleep` 循环，等待结束（`step.started` / `interrupted` / `succeeded` / `execution.failed`）即中断，插件卸载时随 Scope 自动清理。定时能力来自 opencode 宿主提供的 Effect 运行时（与内置插件 `provider/digitalocean.ts` 的周期循环同一原语），**不依赖任何宿主周期事件**。

## 安装

```jsonc
// ~/.config/opencode/opencode.jsonc
{ "plugins": ["/path/to/opencode-buraunkan-kobo/packages/quota-retry"] }
```

## TUI 可见性

重试期间底部显示 `⚠ Retrying in NNNs · attempt N · <错误>`（来自 `session.retry.scheduled` 事件，delay 直接采用插件计算值，倒计时无上限）。

## 测试

- `bun test ./packages/quota-retry`（37 单测）
- Docker 集成：mock 429 场景验证 12-hit 重试链、delay 采纳、16 分钟封顶突破（见 `tmp/dockerbuild/`）
