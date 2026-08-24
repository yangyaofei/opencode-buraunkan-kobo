# Buraunkan Kobo

[English](README.md) | [中文](README.zh.md)

Buraunkan Kobo is the ground floor of the Future Gadget
Laboratory (Mirai Gadget Kenkyujo) — the Lifter that makes Mirai Gadget
8-goki "Denwa Renji (Kari)" truly operate.

## Plugins (Future Gadgets)

1. **quota-retry** — intercepts quota-exhausted 429s and injects an exact
   `retry-after-ms`, so opencode retries after the quota resets instead of
   giving up after ~70s of native backoff. Optional binary patch makes the
   hardcoded retry limits configurable.
2. **session-reaper** — pipeline session governance: `/session-reaper run`
   claims the session for a pipeline, passes the prompt through verbatim,
   and reaps expired sessions (cascading to all subagent children) on the
   next run.
3. **catalog-bridge** — auto-fills model metadata (limit / cost / reasoning /
   variants) for custom providers from the models.dev catalog; only missing
   fields are filled, user-written values are never overwritten.

## Installation

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

The alias before `@` is the plugin's identity and switch: remove a line to
disable that plugin; pin a version with `#commit` / `#branch` at the end.
Each alias installs its own independent cached copy — the plugins are
separate and can be enabled/disabled/pinned individually.

## quota-retry

### The problem

Since 1.18.12 opencode hardcodes the retry limit at 5. When a coding-plan
quota is exhausted, 5 retries cover only ~70 seconds and the session aborts
— even though the error body already says the quota resets hours later.

### How it works

opencode picks the wait time from response headers first:
`retry-after-ms` > `retry-after` > exponential backoff. For each configured
provider this plugin intercepts 429 responses and applies the `quotaMatch`
regex to the body:

- Quota exhausted (e.g. Zhipu "已达到 5 小时的使用上限", Volces "exceeded the
  monthly usage quota") → compute the time until reset, write it into
  `retry-after-ms`, hand the response back. The first native retry then
  lands after the reset.
- No match (e.g. rate limiting "Requests are too frequent") → pass through
  untouched, opencode's native backoff applies.

Reset-time source (per provider, `quota` field): `"zhipu"` uses the Zhipu
quota API (exact), falling back to `resetExtract` body parsing; `"body"`
uses `resetExtract` only (Volces).

### Configuration

`~/.config/opencode/quota-retry.jsonc` (a project `.opencode/quota-retry.jsonc`
takes precedence). One entry per provider:

```jsonc
{
  "providers": [
    {
      "id": "zhipuai-coding-plan",   // providerID in opencode
      "quota": "zhipu",              // reset-time source: zhipu | body
      "fallbackWaitMs": 30000,       // wait per retry when no reset time found
      "bufferMs": 10000              // extra buffer on top of the computed wait
    },
    {
      "id": "volces-ark",
      "quota": "body",
      // decide whether this 429 is quota exhaustion (no match → passthrough)
      "quotaMatch": "AccountQuotaExceeded|exceeded the .*usage quota",
      // extract the reset time from the 429 body; capture group 1 = full time string
      "resetExtract": "reset at\\s+((?:\\d{4}-\\d{2}-\\d{2})\\s+\\d{2}:\\d{2}:\\d{2})",
      "fallbackWaitMs": 30000,
      "bufferMs": 10000
    }
  ],
  "quotaCacheMs": 60000              // quota-query result cache (ms)
}
```

| Field | Required | Description |
|---|---|---|
| `id` | yes | opencode providerID, e.g. `zhipuai-coding-plan`, `volces-ark` |
| `quota` | yes | reset-time source: `zhipu` (quota API, falls back to `resetExtract`) or `body` (`resetExtract` only) |
| `quotaMatch` | no | regex deciding whether the 429 is quota exhaustion; non-matching 429s are passed through |
| `resetExtract` | no | regex extracting the reset time from the body; capture group 1 = full time string; `+08:00` assumed when no zone suffix |
| `quotaUrl` | no | quota API endpoint; defaults to the Zhipu official one |
| `apiKey` | no | key for the quota query; defaults to the request's Authorization header, then opencode's auth.json |
| `fallbackWaitMs` | no | wait when quota exhaustion is confirmed but no exact reset time (default 30000) |
| `bufferMs` | no | extra buffer (default 10000); the server may lag near the reset moment |
| `quotaCacheMs` | no | global; quota query cache (default 60000) |

Both regexes have built-in defaults covering Zhipu and Volces. Restart
opencode after changing the config.

### Binary patch (optional)

Upstream hardcodes the retry policy — `maxRetries` capped at 5, backoff,
backoff cap — introduced by [#41939](https://github.com/anomalyco/opencode/pull/41939)
with no config options. [#44517](https://github.com/anomalyco/opencode/pull/44517)
fixes this by adding config options such as `maxRetry`; once it lands, the
binary patch becomes unnecessary and only the quota 429 wait-time injection
remains useful.
The header-injection above solves "how long to wait" for quota 429s, but two
things stay out of reach:

- **Retry count**: any retryable error aborts after 5 attempts (~2.5 min with
  30s waits) under persistent failures.
- **Uncapped backoff**: when headers carry no retry-after (rate limiting,
  network errors), the exponential backoff doubles without a cap.

This plugin can equal-length rewrite those constants inside the opencode
binary at startup (opt-in):

```jsonc
{
  "providers": [ /* same as above */ ],
  "patch": {
    "enabled": true,
    "maxRetries": -1,        // -1 unlimited | 1-99 a specific count
    "backoffCapMs": 30000    // optional: cap the header-less backoff (10s-16.6min)
  }
}
```

- Takes effect on next launch; backup `.retry-bak` is always pristine;
  `{"patch": {"enabled": false, "restore": true}}` restores the factory binary.
- Combination constraint (equal-length byte budget): with `backoffCapMs`
  ≥ 100000, `maxRetries` only supports -1 or 1-9. Invalid configs are
  rejected at startup with a toast and nothing is touched.
- Covers all platform binary variants; re-applies automatically after an
  npm upgrade; re-signs with `codesign -f -s -` on macOS.
- A status cache (`~/.cache/opencode/quota-retry-patch-state.json`, size +
  mtime + applied targets) makes steady-state startup zero-cost.

### Checking the live state

Run `/retry-setting` inside opencode: prints the config file in use, the
providers and patch config, and for every opencode binary the **actual**
retry parameters (unlimited / count / backoff cap) versus the expected
values. Read-only, no model call (handled locally via `command.execute.before`,
written into the session as an ignored message). Also exposed as the
`quota_retry_status` tool.

## session-reaper

Scheduled pipelines (OpenChamber schedule / `opencode run`) leave behind one
main session plus dozens of subagent children per run — ungoverned,
opencode.db grows without bound (12GB observed over 3 months). This plugin
internalizes "register + reap" into the opencode process.

```
/session-reaper run --pipeline <name> <original prompt>   execute + govern
/session-reaper status                                    bucket status per pipeline
/session-reaper set --pipeline <name> [--keep-days N] [--max-sessions M] [--remove]
                                                          config upsert (no args = view)
/session-reaper reap --pipeline <name>                    reap this pipeline now
```

- `run`: reaps expired entries → registers the current sessionID → **the
  agent receives the original prompt verbatim** (the hook rewrites
  output.parts, stripping action and flags).
- `status` / `set` / `reap`: zero-model path (handled locally, written into
  the session, no tokens spent).
- Deletion order: keepDays-expired entries first, then oldest beyond
  `maxSessions`; failures stay in the bucket and retry next time.

Configuration (`~/.config/opencode/session-reaper.jsonc`):

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

Unlisted pipelines fall back to `default*`; with no default either, sessions
are registered but never reaped (safe default). Deletion goes through
`DELETE /session/:id` and cascades to all subagent children; 404 counts as
already clean. After a `set` the file is rewritten as plain JSON (comments
are owned by the program).

Example (OpenChamber schedule prompt field or TUI):

```
/session-reaper run --pipeline twitter-daily 生成今天的推特日报
```

## catalog-bridge

opencode matches models.dev catalog metadata by **providerID** — a custom
provider name means every model's metadata comes up empty (limit shows 0 in
the TUI). This plugin fills the missing fields from the catalog after config
resolution.

Core convention: **the outer model key must match the models.dev model name**
(e.g. `glm-5.2`). If your endpoint uses a different real API name, set `id`
inside the model entry:

```jsonc
{
  "provider": {
    "my-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://your-endpoint/v1", "apiKey": "sk-xxx" },
      "models": {
        "glm-5.2": { "id": "vibe-bot/glm-5.2", "name": "GLM 5.2 (my gateway)" }
      }
    }
  }
}
```

Filled fields: `limit`, `cost`, `reasoning`, `tool_call`, `attachment`,
`temperature`, `family`, `release_date`, `interleaved`, `modalities`,
`status`, `experimental`, `variants`, `options.reasoningEffort` — all
field-by-field; user-written values are never overwritten. Requires the
models.dev cache (`~/.cache/opencode/models.json`, fetched automatically on
first online run); unlisted models are simply skipped.

## Self-update

opencode installs git plugins once and never re-pulls. The plugins here
share one throttled check (`~/.cache/opencode/buraunkan-kobo/sync.json`,
default 24h): the first plugin to load inside a window compares the remote
HEAD via `git ls-remote`; on a new commit it deletes its own wrapper and
opencode natively reinstalls on next launch (**restart twice** after
publishing). Installs pinned to a commit sha never auto-update.

```jsonc
// ~/.config/opencode/buraunkan-kobo.jsonc
{
  "sync": { "enabled": true, "throttleHours": 24, "repo": "yangyaofei/opencode-buraunkan-kobo" }
}
```

## Layout

```
index.ts        exports plugin functions only (non-function exports break module loading)
plugins/*.ts    one file per plugin
shared/         gate (alias self-gating) / jsonc / paths / fsutil / reply / sync
```
