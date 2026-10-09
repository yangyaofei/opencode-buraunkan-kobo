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
- **轮次续命（无限次数）**：原生 10 次耗尽后，从事件流捕获 `execution.failed`，注入一条 synthetic 通知行驱动新执行（= 全新 10 次原生重试，无限轮）。标记的 `text = "quota-retry-round-" + 随机 token`（出口按前缀精确剥除），`description = "quota-retry · 第 N 轮"` 前台可见，消息 `id` 由插件自指定（`msg_quota-retry_rN_xxx`）。不删失败现场——revert 无插件 API，已提上游 issue。
- **续命触发可配置**（`continueOn`）：默认对齐 1.x `maxRetries=-1` 的语义——opencode 原生会重试的那一类错误（`provider.quota` / `provider.rate-limit` / `provider.internal` / `provider.transport` / `provider.invalid-output` / `provider.unknown`）以及 429 + 全部 5xx；`denyTypes`（默认 auth / content-filter / invalid-request / unsupported-operation / no-route）一票否决；可用 `types` / `statuses` / `match` 正则覆盖默认（例如让某些 400 也续命）。
- **出口净化**：`http.request` hook 剥掉尾部"轮次标记"映射出的 user 消息——**按标记文本前缀判定，不按"空"判定**（空 user 可能是用户真的发了空串）。第 2+ 轮请求与原始 turn 字节级一致（Docker 实测 45 次 429 全程同 hash、无残留标记消息）。
- 用户接管：续命过程中用户发新消息自动停止续命让位。
- `quota_retry_status` 工具 + `/retry-setting` 命令（`ctx.session.synthetic` 零模型回复）。

## 与 1.x 的差异

| 1.x | 2.0 |
|---|---|
| 二进制补丁 `maxRetries=-1`（无限次数） | 轮次续命（见下） |
| hook 改 delay + 补丁改次数 | hook 改 delay + 轮次续命（每轮原生 10 次, 无限轮） |
| on-demand 降级链：挂载组自动创建 | on-demand 降级链：挂载组需在 opencode.jsonc 声明一行 stub（见下） |

## on-demand 降级链（虚模型跨 provider fallback）

配额耗尽自动切备用通道（如付费 API），语义与 1.x 一致：配额型 429 标记当前跳死亡到重置时刻，下一次请求（含同轮原生重试）自动改写到下一个活跳（改 URL / `body.model` / Authorization），非配额 429 不烧链，整链耗尽交轮次续命重扫。

配置两处：

```jsonc
// 1) ~/.config/opencode/opencode.jsonc — 挂载组 stub(必须, 指向链首跳)
{
  "plugin": ["/<仓库>/packages/quota-retry"],
  "provider": {
    "fallback-providers": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://链首跳/v1", "apiKey": "sk-xxx" },
      "models": { "glm-5.3-flash": {} }
    }
  }
}
```

```jsonc
// 2) ~/.config/opencode/quota-retry.jsonc — 链定义
{
  "onDemandModels": [{
    "model": "glm-5.3-flash", "provider": "fallback-providers",
    "chain": [
      { "provider": "volces-ark", "model": "glm-5.3-flash", "baseURL": "https://ark.cn-beijing.volces.com/api/coding/v3", "apiKey": "..." },
      { "provider": "volces-ark-agent-plan", "model": "glm-5.3-flash", "baseURL": "https://ark.cn-beijing.volces.com/api/plan/v3", "apiKey": "..." }
    ]
  }]
}
```

**为什么挂载组必须手工声明**（2.0 平台约束，实测钉死）：

- 插件 `provider.add` 只支持 native 包契约（`@opencode/ai/providers/*` 的 `model(modelID, settings)` 导出）；写 `@ai-sdk/openai-compatible` 直接报 `provider.no-route: Provider package @ai-sdk/openai-compatible does not export model(modelID, settings)`。
- native 包（`@opencode/ai/providers/openai-compatible`）走新版 Route executor：**插件 http/retry hook 不接入该传输层**，且 2.0.15 有未解缺陷——429 响应处理抛 `error{type:"unknown", message:"Invalid Date"}`，分类/重试/hook 全部失效（config 声明的 native 包同病，还会先发一批内置健康探针请求）。
- 社区 SDK 通道（`npm: @ai-sdk/openai-compatible`，hook 全通）**只能由 config 声明进入**。因此挂载组 = 用户 config 一行 stub，插件负责运行时链改写。

**实现要点**：`http.request` hook 链改写 + `http.response` hook 配额死亡标记（`parseResetAtMs` 无匹配返回 `NaN` 而非 `null`，`??` 兜不住，须 `Number.isFinite` 显式判——此 bug 曾让死亡标记静默失效）；http hook 在请求管线内运行，回调内未捕获异常会杀死该请求并把 429 变形为 unclassified 错误，所有分支必须自捕获。

**轮次续命说明**：opencode 2.0.15 出货二进制的核心重试逻辑（`packages/core/src/session/runner/retry.ts`）编译为 JSC bytecode，1.x 的明文锚点补丁路线失效（已实验证明）。替代方案 = 轮次续命：原生 10 次耗尽 → 标记 synthetic 驱动新执行 → 全新 10 次。前台每次重试都是原生徽标（attempt + 倒计时），轮次边界是一行通知行；发给模型的请求由出口净化保持干净（标记文本按前缀被剥除）。

**已知代价（纯插件 API 的取舍）**：revert 没有插件 API（2.0.15 插件 session 域无 remove/revert，已提上游 issue），续命不删失败现场——每轮累积一条失败 assistant 和一条轮次标记（10 轮 ≈ 消息列表多 20 条记录，界面噪音）；不影响功能，工具/思考历史完整保留。发给模型的请求不受影响（标记被剥除，失败 assistant 无内容不入请求）。

**零进程外依赖**：全部走插件 API（`ctx.session`/`ctx.event`），无端口/密码/HTTP 约束，任何部署方式（serve / service / TUI / 托管）行为一致。

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

## 安装

```jsonc
// ~/.config/opencode/opencode.jsonc
{ "plugin": ["/path/to/opencode-buraunkan-kobo/packages/quota-retry"] }
```

## TUI 可见性

重试期间底部显示 `⚠ Retrying in NNNs · attempt N · <错误>`（来自 `session.retry.scheduled` 事件，delay 直接采用插件计算值，倒计时无上限）。

## 测试

- `bun test ./packages/quota-retry`（37 单测）
- Docker 集成：mock 429 场景验证 12-hit 重试链、delay 采纳、16 分钟封顶突破（见 `tmp/dockerbuild/`）
