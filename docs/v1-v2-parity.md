# V1 → V2 移植对照审计

逐功能、逐配置项对照 1.x（`plugins/`，opencode 1.18.x 插件 API）与 2.0（`packages/`，opencode 2.0.15 插件 API）两代实现：实现方式的变化、变好/变差/等价、以及未移植项与原因。用于核查**有没有漏掉的功能、改错的业务逻辑、理解歪的需求**。

结论先行：session-reaper 全量对齐；quota-retry 核心对齐（次数无限换实现方式，语义等价，有一处部署约束变化；apiKey 回退与 title 压制已补）；catalog-bridge **全量对齐**（初版"平台缺口"结论是误诊，修正补全范围后已实测工作）；自更新由 2.0 平台原生提供。剩余未移植：OPENCODE_SESSION_ID（G3，平台无字段）。on-demand 降级链（G2）已实现——挂载组改为用户 config 声明一行 stub（2.0 插件 provider.add 进不了 aisdk 通道，见 quota-retry README），链改写/死亡标记走 http hook，Docker 实测同轮 10 秒内自动降级付费通道。

---

## 1. quota-retry

### 1.1 功能对照

| # | 功能 | V1 实现 | V2 实现 | 对比结论 |
|---|---|---|---|---|
| 1 | 配额 429 识别 | `provider.options.fetch` 注入拦截，读响应 body 匹配 `quotaMatch` | `session.http.response` hook 抓 429 body + `session.retry` hook 用同一套正则判定 | **等价**。V2 更干净：不再改写 provider 配置、对宿主零侵入；非配额 429 同样透传走原生退避（语义一致） |
| 2 | 精确等待（配额重置时刻） | 往 429 响应注入 `retry-after-ms` 头交还，骗原生重试机制 | `decision = { retry: true, delay }` 直写重试决策 | **更好**。无 header 欺骗；delay 不封顶（原生 `RETRY_AFTER_MAX` 15 分钟只封 provider 头，hook 值不封，已实测 16 分钟+） |
| 3 | 智谱配额 API 精确重置 | apiKey 解析链：显式配置 > 本次请求 Authorization 头 > auth.json | 仅显式 `apiKey` | **缺口**：请求头回退可补（`http.request` hook 可见出站头）；auth.json 是 1.x 概念，2.0 等价物待查。见 §4-G1 |
| 4 | body 提取重置时刻 | `resetExtract` 正则，无时区后缀按 +08:00 | 同（`parseResetAtMs`，一比一移植+单测） | **等价** |
| 5 | 重试次数无限 | 二进制补丁：等长改写 `maxRetries` 常量（-1 = 无限），macOS 自动重签名，npm 升级后自动重打 | 轮次续命：原生 10 次耗尽 → 标记 synthetic 驱动新执行 = 全新 10 次，无限轮 | **语义等价，手段更换**。2.0 出货二进制核心重试逻辑编译为 JSC bytecode，V1 明文锚点补丁路线已实验证明失效。续命触发默认对齐 V1（可重试类型 + 429/5xx），可用 `continueOn` 收窄/放宽（V1 是"任何可重试错误"都无限）。代价见 §1.3 |
| 6 | 无头退避封顶 `backoffCapMs` | 补丁改常量（V1 起因：无 retry-after 头时指数退避无限翻倍，实测 38s→76s 一路加倍） | 未移植 | **无需移植**：2.0 原生 schedule 是 `exponential('2s') ∩ spaced('10s')`，单跳退避天然封顶 10s，"无限翻倍"在 2.0 不存在 |
| 7 | on-demand 虚模型降级链 | fetch 注入层逐跳改写 `body.model` 跨 provider 转发 + 换鉴权 + 挂载组自动创建 | 已实现 | **形态变更**：挂载组需在 opencode.jsonc 声明 stub（插件 provider.add 进不了 hook 全通的 aisdk 通道）；链改写走 `http.request` hook，死亡标记走 `http.response` hook。见 §4-G2 |
| 8 | `/retry-setting` 查询 | `command.execute.before` 本地接管 + reply 哨兵（ignored 消息） | `command.transform` 注册 + `session.synthetic` 零模型回复 | **等价**。V2 用原生命令机制更干净。V1 报告里的"补丁二进制实际值对照"部分在 V2 无对应物（无补丁，N/A），改为轮次语义说明 |
| 9 | `quota_retry_status` 工具 | registerTool | `tool.transform` | **等价**（新增当前会话轮次显示） |
| 10 | TUI 可见性 | 无专门处理（原生徽标 + 补丁后次数连续） | 原生徽标（attempt + 倒计时）每轮重置 + 每轮覆写的通知行"quota-retry · 第 N 轮" | **V2 更好**（V1 徽标只在前 5/10 次出现）；差别：V2 每轮 attempt 从头计（1.5 轮语义），V1 连续计数 |
| 11 | 插件自更新 | shared/sync 节流检查 + 删 wrapper 让 opencode 原生补装 | 未移植 | **缺口**，见 §4-G4 |
| 12 | （新）用户接管 | 无此概念（补丁常驻，用户发消息即新 step 天然接管） | 续命中检测到新用户输入自动停止续命让位 | V2 新增，语义正确（初始 prompt 的入队不算接管） |
| 13 | （新）出口净化 | 无此需求 | `http.request` hook 剥掉空 synthetic 映射的尾部空 user 消息 | V2 新增：第 2+ 轮对模型的请求与原始 turn 字节级一致（实测 45×429 全程同 hash） |

### 1.2 配置项对照（`quota-retry.jsonc`）

| V1 字段 | V2 字段 | 说明 |
|---|---|---|
| `providers[].id` / `idPattern` / `quota` / `quotaUrl` / `quotaMatch` / `resetExtract` / `fallbackWaitMs` / `bufferMs` / `apiKey` | 同名同义 | 逐项一致，默认值一致（`fallbackWaitMs` 30000、`bufferMs` 10000、`quotaCacheMs` 60000、内置智谱+火山正则） |
| `quotaCacheMs` | 同 | 一致 |
| `patch.enabled/maxRetries/backoffCapMs/restore` | —（无补丁） | N/A：2.0 bytecode 补丁不可行；次数无限由轮次续命承担（等效 `maxRetries: -1`），退避封顶由原生 schedule 承担 |
| — | `maxRounds`（新增，-1 无限） | 轮次上限。默认 -1 = 无限，等价 V1 `patch.maxRetries: -1` 的行为 |
| — | `continueOn`（新增） | 续命触发策略：`types`/`statuses`/`match` 命中即续命，`denyTypes` 一票否决。默认 = 可重试类型 + 429/5xx（对齐 V1"任何可重试错误"语义）；例如让 503 `provider.internal`（exo-free 场景）或某些 400 也续命 |
| — | — | serverPort 已移除：续命改为纯插件 API（synthetic 驱动），零进程外依赖 |
| `onDemandModels[]` | `onDemandModels[]`（链跳 `baseURL` 必填，链首跳值可省） | §4-G2 |

### 1.3 轮次续命的代价（相对 V1 补丁方案，如实列出）

1. **失败现场不删除（唯一实质代价）**：revert 没有 2.0 插件 API（session 域无 remove/revert），续命不删上轮失败记录 → 每轮累积一条失败 assistant + 一条标记（10 轮 ≈ 多 20 条记录，界面噪音）。已提上游 issue #51599。V1 无此问题（同一执行内连续重试，无轮次概念）。不影响模型上下文：标记在出口被剥除、失败 assistant 无内容不入请求（Docker 实测 45×429 全程同 hash）。
2. **轮次边界约 0.3-0.5s 空档**：失败落地 → 标记注入 → 新执行启动。机制固有（执行真结束+新执行真启动），V1 无空档（同一执行内连续重试）。
3. **每轮边界多一个 title 重生成请求**（synthetic 驱动新执行触发，约 1 次 msgs=2 小请求）。已用 title hook 压制（续命期间跳过 title 重生成，G6）。
4. **attempt 每轮从 1 重计**（V1 补丁后连续计数）。用户已确认此语义可接受（"我要看到第二轮的 attempt 2"）。
5. **续命触发是显式策略**（`continueOn`）：默认 = 可重试类型（quota/rate-limit/internal/transport/invalid-output/unknown）+ 429/5xx，`denyTypes` 排除 auth/content-filter/invalid-request/unsupported-operation/no-route；可用 `types`/`statuses`/`match` 覆盖。V1 补丁是"任何原生可重试错误"都无限重试 —— 默认已对齐该语义。

---

## 2. session-reaper

### 2.1 功能对照

| # | 功能 | V1 | V2 | 对比结论 |
|---|---|---|---|---|
| 1 | `run`：清理超期 → 登记当前 → 逐字透传 prompt | `command.execute.before` 改写 `output.parts` | `command.transform` 的 execute 完全接管后 `ctx.session.prompt` 透传（files/agents/skills/delivery 全保留） | **等价**（V2 用原生 command API，无 parts 手术） |
| 2 | `status` / `set` / `reap` 零模型路径 | reply 哨兵（ignored 消息 + 抛异常截断） | `session.synthetic` 零模型回复 | **等价**。V2 已知平台行为：同一会话连续多条 synthetic 时后续条目滞留 inbox、下次 agent 运行时显示（不丢，README 已记录） |
| 3 | 删除顺序：keepDays 过期 → maxSessions 溢出（最老先删） | 进程内逐条 | `planReap` 纯函数（单测覆盖 4 场景） | **等价** |
| 4 | maxSessions 语义 = 保留历史条数（本次 run 不参与裁剪，桶内 N+1） | ✓ | ✓（register 在 reap 后，语义一致） | **等价**（易错点已核对） |
| 5 | 删除失败留桶重试 / 404 幂等 | DELETE `/session/:id` 进程内 fetch | 优先 `ctx.session.remove({sessionID})`（opencode ≥ 2.0.24 插件 session 域已暴露 remove）；旧版本回退 `spawn(opencode session delete)` 子进程（stderr 404/not found 视为已删） | **等价且更优**：新版本进程内直调、无子进程、任何部署方式可用（Docker 实测 15/15 为子进程路径） |
| 6 | 级联删除 subagent 子会话 | DELETE 端点内建 | 同（`session.remove` 递归删子会话，CLI 调它） | **等价** |
| 7 | registry 损坏自愈 | rename `.corrupt-*` 重建 | 同 | **等价** |
| 8 | 行为日志 log.jsonl（logKeep 条） | ✓ | ✓（字段结构一致：ts/event/pipeline/registered/expired/overflow/reaped/failed/bucket/change） | **等价** |
| 9 | `OPENCODE_SESSION_ID` 注入（shell.env） | hook 注入环境变量（供会话内脚本感知 session 身份；V1 源码只写不读，属对外便利） | 未移植 | **平台缺口**：2.0 `shell.create.before` 事件无 sessionID，无法关联。README 已记录。若上游补 sessionID 可恢复 |
| 10 | 自更新 | shared/sync | 未移植 | 同 §4-G4 |

### 2.2 配置项对照（`session-reaper.jsonc`）

| V1 | V2 | 说明 |
|---|---|---|
| `defaultKeepDays` / `defaultMaxSessions` / `pipelines.{name}.keepDays/maxSessions` / `logKeep` / `registryPath` | 同名同义 | 一致；未配置 default 时只登记不清理（安全默认）一致 |
| — | `deleteServer`（新增） | 可选：**仅旧版本回退路径**（无 `ctx.session.remove` 时）指定删除时连接的 serve 地址；缺省走后台服务发现。opencode ≥ 2.0.24 走原生 `remove`，此项不需要 |

---

## 3. catalog-bridge

### 3.1 功能对照

| # | 功能 | V1 | V2 | 对比结论 |
|---|---|---|---|---|
| 1 | 元数据逐字段补缺（不覆盖手写值） | config hook 遍历 `cfg.provider[*].models` | `model.transform` + `provider.transform` | 语义等价，但见 #6 平台缺口 |
| 2 | 数据源 | opencode 自身的 models.dev 缓存文件（`~/.cache/opencode/models.json`） | 自拉 `https://models.dev/api.json` + 自有缓存（TTL 24h）+ V1 legacy 文件兜底 | **更好**：2.0 把缓存挪进了内部 DB（opencode.db），文件缓存不复存在，自拉是唯一路径 |
| 3 | 字段映射 | limit / cost / reasoning / tool_call / attachment / temperature / family / release_date / interleaved / modalities / status / experimental / variants / options.reasoningEffort | limit / cost(含 cache 读写) / capabilities.tools(=tool_call) / capabilities.input+output(=modalities) / family / time.released(=release_date) / status(含 legacy→deprecated 映射) / variants(reasoningEffort) | **字段面等价**（2.0 Model.Info 砍掉了 reasoning/attachment/temperature/interleaved/experimental 独立字段——分别并入 capabilities/variants 或不存在，属平台演进非缺失） |
| 4 | 默认 reasoningEffort（values 最后一个非 null） | `defaultEffort` 写入模型 options | 未实现 | 2.0 Model.Info 无 options 字段，默认值概念由 variants 承载且 2.0 对 openai-compatible 原生生成 variants；此逻辑暂无落点，标记 N/A 待上游字段回归 |
| 5 | 未收录模型跳过不报错 / 校验有效性（`limit.context>0 && output<context`） | ✓ | ✓（`isValid` 同款） | **等价** |
| 6 | **对 config 自定义 provider 生效** | ✓（config hook 直接改） | ✓（`model.transform` + `models.update`，只补非 catalog provider） | **等价（已实测）**。初版失败是移植范围错误（遍历全部 provider 触发冻结目录模型），修正为只补自定义 provider（= 1.x 原语义）后全字段补全、provider 世界完好。冻结机制与教训见包 README |

### 3.2 配置

无独立配置文件（两代一致，靠 opencode.jsonc 的 provider 定义 + models.dev 目录）。

---

## 4. 缺口清单（按优先级）

| # | 缺口 | 影响 | 状态/计划 |
|---|---|---|---|
| G1 | zhipu apiKey 回退链（Authorization 头 > auth.json） | 智谱用户不配 apiKey 时拿不到精确重置时刻 | **已实现**：`http.request` hook 抓出站 Authorization 头作回退（1.x 的 auth.json 是 1.x 概念，2.0 凭据在 DB；请求头回退覆盖同一用户值） |
| G2 | on-demand 虚模型降级链 | 已解决 | aisdk hook 是死通道（promise 插件注册的 language hook 从不触发，实测）；现行方案 = config stub 挂载组 + http.request/response hook 链改写，Docker 实测通过（含同轮降级、非配额不烧链、整链耗尽交轮次续命） |
| G3 | OPENCODE_SESSION_ID 注入 | 会话内 shell 脚本无法感知 session 身份（便利功能，非核心链路） | 平台缺口（shell 事件无 sessionID），README 已记录；上游补字段即恢复 |
| G4 | 插件自更新（shared/sync） | 1.x 需要自建节流检查+重装触发 | **无需移植**：2.0 有原生 PluginUpdate 服务（`check`/`update`，24h 节流，npm 后端，`packages/core/src/plugin/update.ts`） |
| G5 | catalog-bridge 对 config 型 provider | 自定义 provider 元数据补全不可用（V1 主要场景） | 平台缺口；候选：config 补全器（启动前改写 opencode.jsonc，官方加载器自己消费——绕开冻结，但改用户配置文件需谨慎，待用户决策）或提上游 issue |
| G6 | title 重生成压制 | 每轮边界多一个 title 请求 | **已实现**：续命期间 `title` hook 返回现有标题（无标题则置空）跳过重生成；Docker 实测每会话 title 请求 3→1 |
| G7 | 消息级删除/回滚（续命删失败现场） | 每轮累积一条失败 assistant + 一条标记（界面噪音） | **平台缺口（调研结论）**：删单条消息的唯一核心机制是 revert（`RevertEvent.Committed` 投影里 `delete(SessionMessageTable) where seq >= boundary`），而插件 session 域**至今（2.0.24）仍未暴露 revert**（只新增了整会话 `remove` 与 `compact`）。替代机制逐一排除：`move` = 会话搬迁到别的目录；`fork` = 复制出新会话（HTTP 有、插件无）；`synthetic` 复用同一 id → `SyntheticConflictError`（不是 upsert）；`ctx.rpc.call` 需要宿主注册的 RPC 定义（宿主未注册可用于会话变更的定义）。可选路径：①上游 #51599（把 revert 桥接给插件，最干净）；②进程外 HTTP revert（需 serve 端口+密码，与"零进程外依赖"冲突）；③直写 opencode.db（绕过契约，WAL/状态缓存风险，不推荐）；④OpenChamber 侧把连续相同失败卡聚合（只改观感，不删记录）。 |

## 5. 业务逻辑偏差核查记录

逐条核对 V1 README 声明的行为与 V2 实现/实测：

- ✅ quotaMatch 不匹配的 429 透传走原生重试（V2 retry hook 直接 return，原生接管）
- ✅ maxSessions"保留历史条数，桶内 N+1"语义（V2 register 在 reap 后）
- ✅ 未配置 default 只登记不清理
- ✅ 删除失败留桶下次重试、404 幂等
- ✅ resetExtract 无时区按 +08:00（单测覆盖含"带 Z 也按 +08:00"的 V1 怪癖）
- ✅ 配置项目优先生效顺序（项目 `.opencode/` > 全局 `~/.config/opencode/`）
- ✅ 改配置重启生效（两代一致，无热加载）
- ⚠️ V1"重置时刻附近服务端可能未生效多等几秒"→ bufferMs 默认 10000 一致；V2 演示配置用了小 buffer 只是测试加速，文档默认值与 V1 相同

## 6. 安装方式对照

| | V1 | V2 |
|---|---|---|
| 形态 | 单仓三别名 git 安装（`quota-retry@git+https://...`），共享 `index.ts` 入口 + gate 自门控 | 每包独立（`packages/<name>`，`{id, setup}` 默认导出），一个包 = 一个插件，天然隔离无需 gate |
| 配置 | `"plugin": ["quota-retry@git+https://github.com/yangyaofei/opencode-buraunkan-kobo.git", ...]` | 本地路径：`"plugin": ["/<repo>/packages/quota-retry"]`；发布后可 `"plugin": ["@buraunkan/quota-retry"]` |
| 开关 | 删行即停用 / 钉 commit | 同（每行一个包） |

各包 README 有安装节与部署约束说明。
