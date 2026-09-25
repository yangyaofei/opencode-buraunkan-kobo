# catalog-bridge (opencode 2.0)

自定义 provider 的模型自动从 models.dev 复用元数据。从 1.x `plugins/catalog-bridge.ts` 移植，基于 opencode 2.0 插件 API。

## 安装与启用

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugin": ["/<本仓库路径>/packages/catalog-bridge"]
}
```

- 一个包 = 一个插件（2.0 加载契约：默认导出 `{ id, setup }`），删行即停用。
- 与 1.x 版的功能/配置项逐项对照见 [docs/v1-v2-parity.md](../../docs/v1-v2-parity.md)。

## 机制（已验证工作）

`ctx.model.transform` + `editor.models.update`，**只补不在 models.dev 目录里的 provider**（= 用户自定义 provider，与 1.x 语义完全一致）。内置 provider 的元数据由官方 models.dev 通道自带，不碰。

- 数据源：自拉 `https://models.dev/api.json` + 自有缓存（TTL 24h，`~/.cache/opencode/buraunkan/models-dev.json`）+ 1.x 旧缓存文件（`~/.cache/opencode/models.json`）兜底。2.0 把官方缓存挪进了 opencode.db，文件复用不可行，自拉是唯一路径。
- 顺序保证：官方 `opencode.config.provider` 的模型覆盖 transform 注册在**外部插件之后**（源码注释 "late registration position, after external model transforms"）——用户在 opencode.jsonc 手写的字段天然后到、不被覆盖。
- 核心约定同 1.x：**模型外层 key 对齐 models.dev 里的模型名**（如 `glm-5.3`）。
- Docker 实测：limit / cost(含 cache 读写) / capabilities(=tool_call+modalities) / family / status / time.released / variants(reasoningEffort) 全部补上，provider 世界完好。

## 重要教训（为什么第一版失败）

第一版遍历了**全部 provider** 并用 `provider.add` 覆盖——三个问题：

1. models.dev 目录模型的源对象在重放中来自**冻结快照**（`provider.ts:389` immer `freeze(…, true)`；`index()` 对 add 的模型即时深冻），`structuredClone` 在出货二进制的 JSC 里**保留冻结**，update 回调内赋值抛 `Attempted to assign to readonly property`。
2. `provider.add` 覆盖会在下一轮重放引爆官方播种器的 `Object.assign(structuredClone(frozen))`（`[Immer] This object has been frozen...`），该插件被静默禁用后 provider 列表从 230+ 塌缩到 2（两轮稳定复现）。
3. 由此误诊"外部插件看不到 config provider"——实际上**只补自定义 provider 就完全可行**（它们的模型经由 `models.update` 的 unfrozen 草稿路径创建）。1.x 本来就只遍历用户 config 里的 provider，是移植时把范围放大导致了失败。
