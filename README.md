# Buraunkan Kobo

ブラウン管工房 — an **opencode 2.0** plugin workshop. Several independent plugins live in one repo; each is enabled on its own and can be removed by deleting one line.

> The 1.x implementation (binary patch, install aliases) is preserved on the [`legacy`](https://github.com/yangyaofei/opencode-buraunkan-kobo/tree/legacy) branch. Everything on the default branch targets opencode 2.0.

## Plugins

| Package | What it does |
|---|---|
| [`packages/quota-retry`](packages/quota-retry) | Quota-aware retry. Recognises quota 429s, waits exactly until the quota resets (no cap), and keeps retrying past opencode's native 10-attempt cap in unlimited rounds. |
| [`packages/session-reaper`](packages/session-reaper) | Session registry + pipeline reaping (`keepDays` / `maxSessions`), reports back through a synthetic message, deletes through the native session API. |
| [`packages/catalog-bridge`](packages/catalog-bridge) | Fills in model metadata (limits, cost, capabilities, variants) for custom providers from [models.dev](https://models.dev). |

## Install

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

A local path works the same way (`"/path/to/repo/packages/quota-retry"`), which is what development uses.

- One package = one plugin. The 2.0 loading contract is a default export of `{ id, setup }`; deleting the line disables the plugin.
- `session-reaper` deletion needs opencode ≥ 2.0.24 (it calls the native `session.remove`; on older versions it reports an error instead of deleting).
- Each package has its own README with its configuration; the item-by-item 1.x ↔ 2.0 mapping lives in [docs/v1-v2-parity.md](docs/v1-v2-parity.md).

### Updating and pinning

- The snippet above uses a **branch** (`#master`). opencode **detects** new commits on it — `opencode plugin check` (also in the TUI plugin panel; the result is cached for 24 hours) marks the plugin `outdated` — but it does **not replace it by itself**: a normal start reuses the already-installed copy (`install=false`). To actually pull the new revision, run **`opencode plugin update`** (or the update action in the TUI plugin panel; the `plugin.update` API behind it).
- To **pin** a version, replace `#master` with a full commit sha (`#<40-char sha>`). A sha spec is immutable to opencode (`Npm.check` returns false), so it is never reported as outdated.
- A local-path install (`"/path/to/repo/packages/quota-retry"`) is read **in place**: edit the files and restart; no update action needed.


## Layout

```
packages/
  quota-retry/       opencode 2.0 plugin (server.ts, core.ts, config.ts, tests, README)
  session-reaper/    opencode 2.0 plugin (server.ts, reaper.ts, tests, README)
  catalog-bridge/    opencode 2.0 plugin (server.ts, catalog.ts, tests, README)
docs/
  v1-v2-parity.md    1.x → 2.0 feature-by-feature comparison and known gaps
```

## Development

```bash
bun test ./packages/quota-retry ./packages/session-reaper ./packages/catalog-bridge
```

61 unit tests across the three opencode plugins. They need no dependencies beyond Bun and `node:` builtins — the host API is injected by opencode at load time.

## License

MIT
