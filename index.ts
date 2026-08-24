// ブラウン管工房 — 未来ガジェット研究所の1階。
// 一个仓库承载多个 opencode 插件, 按安装别名各自激活(见 shared/gate.ts)。
//
// 本文件只导出插件函数——opencode 把模块的每个函数导出都当作独立插件加载,
// 任何非函数导出都会导致整个模块加载失败(测试钩子挂函数属性, 不用具名导出)。

export { catalogBridge } from "./plugins/catalog-bridge"
export { quotaRetry } from "./plugins/quota-retry"
export { sessionReaper } from "./plugins/session-reaper"
