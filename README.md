# Buraunkan Kobo

ブラウン管工房 — an **opencode 2.0** plugin workshop. Several independent plugins live in one repo; each is enabled on its own and can be removed by deleting one line.

> The 1.x implementation (binary patch, install aliases) is preserved on the [`legacy`](https://github.com/yangyaofei/opencode-buraunkan-kobo/tree/legacy) branch. Everything on the default branch targets opencode 2.0.

## Plugins

| Package | What it does |
|---|---|
| [`packages/quota-retry`](packages/quota-retry) | Quota-aware retry. Recognises quota 429s, waits exactly until the quota resets (no cap), and keeps retrying past opencode's native 10-attempt cap in unlimited rounds. |
| [`packages/session-reaper`](packages/session-reaper) | Session registry + pipeline reaping (`keepDays` / `maxSessions`), reports back through a synthetic message, deletes through the native session API. |
| [`packages/catalog-bridge`](packages/catalog-bridge) | Fills in model metadata (limits, cost, capabilities, variants) for custom providers from [models.dev](https://models.dev). |

## Messages: visible to the user, never sent to the model

opencode has **no display-only message type**: a `synthetic` message is mapped to a `user` message on the way to the provider, and `resume` only decides whether it *wakes* the runner. So every message a plugin shows to the user follows the same two-part rule:

1. **`resume`** — `true` only when the message is real input (it drives the next round, or runs a task); `false` for pure notifications, so no model turn is started.
2. **`context` hook by id** — each plugin drops its own messages (by message-id prefix) while the request is built, so they are never sent — neither on that request nor on any later one. `resume: false` alone does **not** hide a message from the model; it only avoids waking it.

| Plugin | Message | When | `id` | `resume` | In model requests |
|---|---|---|---|---|---|
| quota-retry | round marker | native 10 attempts spent → next round | `msg_quota-retry-round-<N>-<ts>` | **true** (it is the driver) | stripped |
| quota-retry | wait heartbeat | during a long wait, every `heartbeatMs` | `msg_quota-retry-heartbeat-<ts>` | **false** (only refreshes the location TTL) | stripped |
| quota-retry | `/retry-setting` reply | user runs the command | `msg_quota-retry-status-<ts>` | **false** | stripped |
| quota-retry | `quota-retry-status` tool output | the model calls the tool | (tool result) | — | kept (the model asked for it) |
| session-reaper | command reply (`status` / `set` / `reap`) | user runs the command | `msg_session-reaper-reply-<ts>` | **false** | stripped |
| session-reaper | `run` forwarded prompt | `/session-reaper run …` | (user message) | **true** (real task input) | kept |
| catalog-bridge | — | — | — | — | — |

`text` carries the payload (quota-retry markers use `EL-PSY-CONGROO-quota-retry-…` + a random token); `description` is the one-line label the UI renders (a message without one is never shown as a notice). quota-retry's older ids (`msg_quota-retry_*`, `msg_quota-retry-heartbeat-*`, …) share the same id prefix and are stripped as well.

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
