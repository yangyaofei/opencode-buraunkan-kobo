# Buraunkan Kobo

[English](README.md) | [中文](README.zh.md)

Buraunkan Kobo（布朗管工房）是未来道具研究所（Mirai Gadget
Kenkyujo）的一楼——让未来道具 8 号机「电话微波炉（暂定）」（Mirai Gadget
8-goki "Denwa Renji (Kari)"）真正运转的 Lifter。

## 插件（未来道具）

1. **quota-retry** —— 拦截配额耗尽的 429，注入精确的 `retry-after-ms`，让
   opencode 在限额重置后再重试，而不是原生退避约 70 秒后放弃；可选二进制补丁
   把硬编码的重试上限变为可配置。
2. **session-reaper** —— pipeline session 治理。`/session-reaper run` 声明
   会话身份并逐字透传 prompt，下次运行时自动清理超期 session（级联删除全部
   subagent 子会话）。
3. **catalog-bridge** —— 自定义 provider 的模型自动从 models.dev 复用元数据
   （limit / cost / reasoning / variants 等）；逐字段补缺失，不覆盖已手写的值。

## 安装

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugin": [
    "catalog-bridge@git+https://github.com/yangyaofei/opencode-buraunkan-kobo.git",
    "quota-retry@git+https://github.com/yangyaofei/opencode-buraunkan-kobo.git",
    "session-reaper@git+https://github.com/yangyaofei/opencode-buraunkan-kobo.git"
  ]
}
```

`@` 前的别名就是插件的身份与开关：删一行即停用；行尾可钉 `#commit` / `#branch`。
三个别名各自独立安装（各自缓存副本），是三个独立插件，可分别启用/停用/钉版本。

## quota-retry

### 解决的问题

opencode 1.18.12 起把重试次数上限固定为 5。coding plan 配额耗尽后，5 次重试只
覆盖约 70 秒，会话直接中断——但错误信息里已经写明配额几小时后才重置。

### 工作原理

opencode 按响应头决定等待时间：`retry-after-ms` > `retry-after` > 指数退避。
本插件拦截配置中 provider 的 429 响应，用判定正则 `quotaMatch` 读响应内容：

- 配额耗尽（如智谱「已达到 5 小时的使用上限」、火山「exceeded the monthly
  usage quota」）→ 计算「距限额重置还剩多久」，写入 `retry-after-ms` 后交还。
  第一次原生重试就落在限额重置之后。
- 没匹配上（如并发限流「Requests are too frequent」）→ 不注入，原样交还，
  opencode 原生指数退避。

重置时刻来源（provider 的 `quota` 字段）：`"zhipu"` 用智谱配额查询接口（精确），
失败回退 `resetExtract` 提取；`"body"` 只用 `resetExtract`（火山用这个）。

### 配置

全局 `~/.config/opencode/quota-retry.jsonc`，项目 `.opencode/quota-retry.jsonc`
优先。一个 provider 一条：

```jsonc
{
  "providers": [
    {
      "id": "zhipuai-coding-plan",   // opencode 里的 providerID
      "quota": "zhipu",              // 重置时间来源: zhipu | body
      "fallbackWaitMs": 30000,       // 拿不到重置时间时每次重试等多久(毫秒)
      "bufferMs": 10000              // 在计算出的等待上额外加的缓冲(毫秒)
    },
    {
      "id": "volces-ark",
      "quota": "body",
      // 判定 429 是不是配额耗尽(不匹配则透传, 走 opencode 原生重试)
      "quotaMatch": "AccountQuotaExceeded|exceeded the .*usage quota",
      // 从 429 正文提取重置时刻, 捕获组 1 = 完整时间串
      "resetExtract": "reset at\\s+((?:\\d{4}-\\d{2}-\\d{2})\\s+\\d{2}:\\d{2}:\\d{2})",
      "fallbackWaitMs": 30000,
      "bufferMs": 10000
    }
  ],
  "quotaCacheMs": 60000              // 配额查询结果缓存时长(毫秒)
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | opencode 的 providerID，如 `zhipuai-coding-plan`、`volces-ark` |
| `quota` | 是 | 重置时刻来源：`zhipu`（配额查询接口，失败回退 `resetExtract`）或 `body`（只用 `resetExtract`） |
| `quotaMatch` | 否 | 判定 429 是不是配额耗尽的正则；不匹配的 429 不注入，走原生重试 |
| `resetExtract` | 否 | 从 429 正文提取重置时刻的正则，捕获组 1 = 完整时间串；无时区后缀按 +08:00 |
| `quotaUrl` | 否 | 配额查询接口地址，默认智谱官方地址 |
| `apiKey` | 否 | 配额查询用的 key；不填则取本次请求头 Authorization，再读 auth.json |
| `fallbackWaitMs` | 否 | 确认配额耗尽但拿不到精确时间时的等待（默认 30000） |
| `bufferMs` | 否 | 附加缓冲（默认 10000）；重置时刻附近服务端可能未生效，多等几秒 |
| `quotaCacheMs` | 否 | 全局；配额查询缓存（默认 60000） |

两组正则有内置默认值，不配也支持智谱和火山。改配置后重启 opencode 生效。

### on-demand 虚模型（可选）

存量模型完全不动。可以额外注册一个"调度"模型：按 chain 顺序依次尝试真实模型，
配额耗尽 429 自动降级到下一个——适合"现在就要跑完"的场景（付费 API 顶上）；
而能接受等配额的夜间任务继续选原模型，触发方式不变：

```jsonc
{
  "providers": [ /* 原有配置, 不变 */ ],
  "onDemandModels": [
    {
      "model": "glm-5.3-flash-on-demand",        // 虚模型 ID, TUI 里出现
      "provider": "zhipuai-coding-plan",          // 挂载的 provider
      "name": "GLM 5.3 Flash (按需降级)",
      "chain": [
        { "model": "glm-5.3-flash" },             // 先用订阅额度(同 provider)
        { "provider": "zhipuai", "model": "glm-5.3-flash" }  // 配额尽→付费 API
      ]
    }
  ]
}
```

行为：

- 选中虚模型时，按 chain 逐跳改写 `body.model` 转发；第一个非 429 响应即返回。
- 跨 provider 跳转重定向到目标 provider 的 baseURL，并换 Authorization key
  （config `options.apiKey` 优先，其次 auth.json）。
- 非配额 429（并发限流）不烧链，原样交还 opencode 原生重试。
- 整链耗尽 → 返回裸 429（不注入等待）；配合二进制补丁，原生重试每 ~30s
  重扫整链，哪个模型先恢复配额就用哪个。
- 不在链里的模型行为与之前完全一致（配额 429 → 注入 `retry-after-ms` 等重置）。
- TUI 元数据（limit 等）从 chain 首目标的 models.dev catalog 条目复制。

### 二进制补丁（可选）

上游把重试策略硬编码（`maxRetries` = 5 封顶、退避、退避封顶，由
[PR #41939](https://github.com/anomalyco/opencode/pull/41939) 引入，无任何配置项）；
[PR #44517](https://github.com/anomalyco/opencode/pull/44517) 通过增加 `maxRetry`
等配置项解决此问题，合并后二进制补丁即失效，插件只剩配额 429 的等待时间注入功能。
上面的注入方案解决配额场景的「等多久」，但两件事够不到：

- **次数上限**：持续故障下 5 次 × 30s ≈ 2.5 分钟就放弃
- **退避无封顶**：响应无 retry-after 头时（并发限流、网络错误），指数退避
  无限翻倍，实测 38.4s/76.2s 一路加倍

本插件可在启动时等长改写 opencode 二进制里的这些常量（opt-in）：

```jsonc
{
  "providers": [ /* 同上 */ ],
  "patch": {
    "enabled": true,
    "maxRetries": -1,        // -1 无限 | 1-99 指定次数
    "backoffCapMs": 30000    // 可选: 无头退避封顶(10s-16.6min)
  }
}
```

- 下次启动生效；备份 `.retry-bak` 始终保持出厂态；`{"patch": {"enabled": false,
  "restore": true}}` 还原出厂二进制
- 组合约束（等长替换的位预算）：`backoffCapMs` ≥ 100000 时 `maxRetries` 仅支持
  -1 或 1-9；无效配置入口校验拒绝，toast 提示且不碰二进制
- 覆盖所有平台变体二进制；npm 升级覆盖后自动重打；macOS 自动
  `codesign -f -s -` 重签名
- 状态缓存 `~/.cache/opencode/quota-retry-patch-state.json`（size + mtime +
  已应用目标），稳态启动零开销

### 查询当前生效状态

opencode 里输入 `/retry-setting`：输出实际使用的配置文件路径、providers 与
patch 配置、每份二进制重试参数的**实际值**与配置期望逐项对照。只读、不调模型
（`command.execute.before` 本地接管，报告以 ignored 消息写入会话）。同时注册为
`quota_retry_status` 工具，会话里直接问也行。

## session-reaper

scheduled pipeline（OpenChamber schedule / `opencode run`）每次运行留下 1 个主
session + 数十个 subagent 子会话，无人治理时 opencode.db 无限膨胀（实测 3 个月
12GB）。本插件把「登记 + 清理」内化到 opencode 进程内。

```
/session-reaper run --pipeline <name> <原始prompt>   执行任务 + 治理
/session-reaper status                               查看各 pipeline 桶状态与超期项
/session-reaper set --pipeline <name> [--keep-days N] [--max-sessions M] [--remove]
                                                      配置 upsert(不带修改参数=查看)
/session-reaper reap --pipeline <name>               立即清理该 pipeline
```

- `run`：清理超期项 → 登记当前 sessionID → **agent 收到逐字原样的 prompt**
  （hook 改写 output.parts，剥掉 action 与 flags）
- `status` / `set` / `reap`：零模型路径（本地处理写入会话，不耗 token）
- 删除顺序：先删 keepDays 过期的，再删超出 maxSessions 的最老项；删除失败留桶
  里下次重试

配置（`~/.config/opencode/session-reaper.jsonc`）：

```jsonc
{
  "defaultKeepDays": 30,
  "defaultMaxSessions": 10,
  "pipelines": {
    "twitter-daily": { "keepDays": 10, "maxSessions": 10 },
    "work-weekly": { "keepDays": 30, "maxSessions": 5 }
  }
}
```

未配置的 pipeline 用 `default*`；default 也未设 → 只登记不清理（安全默认）。
删除走 `DELETE /session/:id`，级联删除全部 subagent 子会话；404 视为已清理。
`set` 后文件被程序重写为纯 JSON（注释归程序管）。

### 行为日志

每次 `run` / `reap` / `set` 追加一条 JSONL 到 registry 同目录的 `log.jsonl`
（默认 `~/.local/state/opencode/session-reaper/log.jsonl`），保留最近
`logKeep` 条（默认 100，设 0 关闭）：

```jsonc
{"ts":1735036800000,"event":"run","pipeline":"twitter-daily","sessionID":"ses_c","registered":"ses_c","expired":1,"overflow":0,"reaped":["ses_a"],"failed":[],"bucket":2}
{"ts":1735036900000,"event":"reap","pipeline":"twitter-daily","sessionID":"ses_d","expired":0,"overflow":1,"reaped":["ses_b"],"failed":[],"bucket":1}
{"ts":1735037000000,"event":"set","pipeline":"twitter-daily","sessionID":"ses_d","change":{"maxSessions":2}}
```

字段：`registered` 本次新增的 sessionID、`expired`/`overflow` 过期与超出数量、
`reaped` 删除成功的 ID 列表、`failed` 删除失败（留桶重试）的 ID 列表、
`bucket` 操作后的桶内总数。

调用示例（OpenChamber schedule 的 prompt 字段或 TUI）：

```
/session-reaper run --pipeline twitter-daily 生成今天的推特日报
```

## catalog-bridge

opencode 按 **providerID** 匹配 models.dev 元数据——自定义 provider 名下所有
模型的元数据全空（TUI 里 limit 显示 0）。本插件在 config 解析后逐字段补缺失。

核心约定：**模型外层 key 必须对齐 models.dev 里的模型名**（如 `glm-5.2`）。
endpoint 真实 API 名不同时，条目内用 `id` 指定：

```jsonc
{
  "provider": {
    "my-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://your-endpoint/v1", "apiKey": "sk-xxx" },
      "models": {
        "glm-5.2": { "id": "vibe-bot/glm-5.2", "name": "GLM 5.2 (我的网关)" }
      }
    }
  }
}
```

补全字段：`limit`、`cost`、`reasoning`、`tool_call`、`attachment`、
`temperature`、`family`、`release_date`、`interleaved`、`modalities`、`status`、
`experimental`、`variants`、`options.reasoningEffort`——全部逐字段，不覆盖已
手写的值。依赖 models.dev 缓存（`~/.cache/opencode/models.json`，首次联网自动
拉取）；未收录的模型跳过不报错。

## 自更新

opencode 对 git 插件只装一次、不再拉取。本仓库插件共享一份节流检查
（`~/.cache/opencode/buraunkan-kobo/sync.json`，默认 24h）：窗口内第一个加载的
插件用 `git ls-remote` 比对远端 HEAD；有新提交则删除自己的 wrapper，下次启动
opencode 原生补装最新版（**发布后需重启两次**）。钉 commit sha 的安装不自动更新。

```jsonc
// ~/.config/opencode/buraunkan-kobo.jsonc
{
  "sync": { "enabled": true, "throttleHours": 24, "repo": "yangyaofei/opencode-buraunkan-kobo" }
}
```

## 目录

```
index.ts        只导出插件函数(非函数导出会导致模块加载失败)
plugins/*.ts    各插件实现
shared/         gate(别名自门控) / jsonc / paths / fsutil / reply / sync
```
