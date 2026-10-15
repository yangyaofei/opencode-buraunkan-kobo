# Buraunkan Kobo（ブラウン管工房）

**opencode 2.0** 的插件工房：多个互相独立的插件放在同一个仓库里，各自启用、删掉一行即停用。

> 1.x 的实现（二进制补丁、安装别名那一套）保留在 [`legacy`](https://github.com/yangyaofei/opencode-buraunkan-kobo/tree/legacy) 分支。默认分支上的内容全部面向 opencode 2.0。

## 插件

| 包 | 作用 |
|---|---|
| [`packages/quota-retry`](packages/quota-retry) | 配额感知重试。识别配额类 429，精确等待到配额重置（等待不封顶），并在 opencode 原生 10 次上限耗尽后**无限轮次**继续重试。 |
| [`packages/session-reaper`](packages/session-reaper) | 会话登记 + 按流水线收割（`keepDays` / `maxSessions`），用 synthetic 消息回执，走原生会话 API 删除。 |
| [`packages/catalog-bridge`](packages/catalog-bridge) | 为自定义 provider 的模型补全元数据（上下文/输出上限、价格、能力、变体），数据来自 [models.dev](https://models.dev)。 |

## 安装

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [
    "git+https://github.com/yangyaofei/opencode-buraunkan-kobo.git#master::path:packages/quota-retry",
    "git+https://github.com/yangyaofei/opencode-buraunkan-kobo.git#master::path:packages/session-reaper",
    "git+https://github.com/yangyaofei/opencode-buraunkan-kobo.git#master::path:packages/catalog-bridge"
  ]
}
```

本地路径写法相同（`"/本仓库路径/packages/quota-retry"`），开发时就是这么用的。

- **一个包 = 一个插件**。2.0 的加载契约是默认导出 `{ id, setup }`；删掉那一行即停用。
- `session-reaper` 的删除需要 opencode ≥ 2.0.24（走原生 `session.remove`；更低版本会报错而不是删除）。
- 每个包自己的 README 里有各自的配置说明；1.x ↔ 2.0 的逐项对照见 [docs/v1-v2-parity.md](docs/v1-v2-parity.md)。

### 更新与钉版本

- 上面的写法用的是**分支**（`#master`）。opencode 会**检测**分支上的新提交——`opencode plugin check`（TUI 插件面板亦可，检测结果缓存 24 小时）会把它标成 `outdated`——但**不会自动替换**：正常启动走的是"复用已安装副本"（`install=false`）。要真正拉取新版本，执行 **`opencode plugin update`**（或 TUI 插件面板里的更新动作；对应 `plugin.update` API）。
- 想**钉死**版本：把 `#master` 换成完整的 commit sha（`#<40 位 sha>`）。带 sha 的规格在 opencode 里是"不可变"的（`Npm.check` 直接返回 false），不会被判定为有更新。
- 本地路径安装（`"/path/to/repo/packages/quota-retry"`）是**就地读取**：改文件后重启即生效，不需要更新动作。


## 目录

```
packages/
  quota-retry/       opencode 2.0 插件（server.ts / core.ts / config.ts / 测试 / README）
  session-reaper/    opencode 2.0 插件（server.ts / reaper.ts / 测试 / README）
  catalog-bridge/    opencode 2.0 插件（server.ts / catalog.ts / 测试 / README）
docs/
  v1-v2-parity.md    1.x → 2.0 的功能逐项对照与已知缺口
```

## 开发

```bash
bun test ./packages/quota-retry ./packages/session-reaper ./packages/catalog-bridge
```

三个 opencode 插件共 61 个单测。除 Bun 与 `node:` 内置模块外不依赖任何东西——宿主 API 由 opencode 在加载时注入。

## License

MIT
