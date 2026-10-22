# Anthropic Opus 5.5 Latency

Measured on 2026-10-21 (macOS arm64, Bun 1.3.14) against the direct Anthropic
API with `claude-opus-5-5` in fast mode. Earlier reports covered OpenAI; this one
covers the default AI SDK path for Anthropic. Small samples, not guarantees.

## Where the time went

5 days of local `session_timing` rows (4,775 `anthropic/claude-opus-5-5-fast`
steps, variant `max`):

| Phase                             |   p50 |     p90 |
| --------------------------------- | ----: | ------: |
| Step start to request (local)     | 189ms |   229ms |
| Last tool end to step end (local) | 385ms |   586ms |
| Request start to first reasoning  | 2.28s |   4.08s |
| `read` / `edit` tool execution    | 5-6ms | 12-17ms |

Local turnaround was ~574ms per tool round trip, about 100x the tools it
wrapped. The log timeline attributed nearly all of it to git snapshots: one
`track()` at step creation, then `track()` plus `patch()` (a second full
`add()` scan) at step-finish, with the forked session-diff summary holding the
same snapshot lock while the next step waited.

Prompt caching read 96% of 1.8B prompt tokens (average prompt ~338k), but the
3.7% of steps with large cache writes were expensive: writes of 60k+ tokens had
first-reasoning p50 3.85s and p90 18.7s, versus 2.07s and 3.88s warm.

| Main-session steps                  | Steps | Large rewrites | Tokens rewritten |
| ----------------------------------- | ----: | -------------: | ---------------: |
| In loop, >5 min between step starts |    49 |       46 (94%) |            22.4M |
| New turn after a 5-60 min pause     |    36 |       35 (97%) |            13.4M |
| New turn within 5 min               |   195 |        18 (9%) |             7.0M |
| In loop, <1 min                     | 1,696 |        17 (1%) |             1.9M |

The conversation tail used the 5-minute TTL, which runs from each request's
start: long tools, subagent waits, and short pauses expired it.

## Implemented

- **Snapshot carry.** A step-finish tree becomes the next step's start snapshot
  within one loop (under 1s old, no tool settled after it). Non-model branches
  and new turns take a fresh snapshot.
- **Tree-diff patches.** `Snapshot.patch(from, to)` compares two trees instead of
  re-staging the worktree; identical trees return without git.
- **No-op summaries skipped.** Steps that change no files no longer recompute
  the session diff (two `diffFull` calls holding the snapshot lock).
- **Background step-finish capture.** After a `tool-calls` step with every tool
  settled, the step-finish snapshot runs concurrently with the next model
  request. Non-read-only tools wait on `ready` until it exists, so nothing can
  mutate the worktree first. Final steps and native steps with deferred tools
  still capture inline.
- **1h conversation-tail cache** for primary direct-Anthropic sessions
  (`provider.anthropic.options.promptCacheTtl`, default `1h`; `5m` opts out).
  Subagents and auxiliary calls keep 5m, matching Claude Code's main/other split.
  Estimated against the 5-day sample at fast-mode rates: ~$345 of rewrites
  avoided versus ~$145 of extra write cost, before the latency gain.
- **`thinkingDisplay`** provider option (`summarized` | `omitted`), applied after
  effort variants. Opt-in; default unchanged.
- **Anthropic connection warming.** The existing typing-triggered warm request
  now opens a socket to the exact Messages endpoint with an unauthenticated
  `HEAD`; Bun 1.3.14's `fetch.preconnect` throws `Invalid port` for default
  ports. Plugin fetches, non-HTTPS, and credentialed URLs are skipped.
- **Served speed** (`usage.speed`) is recorded as the timing `returnedTier`.
  Pricing is unchanged.

## Results

Offline harness, real CLI against a scripted Messages server, hardlinked clone
of this repository (5,312 files), simulated 1s time to first token, same
working tree with the old behavior restored by a temporary toggle:

| Tool per step | Before p50 / p90 | After p50 / p90 |
| ------------- | ---------------: | --------------: |
| `read`        |      288 / 314ms |       18 / 27ms |
| `write`       |    414 / 1,171ms |       21 / 31ms |

The floor with snapshots disabled is ~23ms. With an instant model (no TTFT to
overlap) the carry and tree diff alone gave `read` 295 to 116ms and `write` 417
to 271ms; the background capture needs model latency to hide behind.

Live fast-mode A/B, max effort, a reasoning-heavy edit (5-6 samples per arm,
alternating, all served `speed: "fast"`):

| Display      | First output | Thinking tokens |            Thinking throughput |
| ------------ | -----------: | --------------: | -----------------------------: |
| `summarized` |        38.5s |           10.5k | ~270 tok/s (3.62-3.74ms/token) |
| `omitted`    |        28.5s |            8.4k | ~297 tok/s (3.32-3.52ms/token) |

Summaries cost ~9% of thinking throughput and never deliver the answer sooner;
the token-count gap is likely sampling noise. At medium effort the same model
usually skipped thinking on a simple edit, so no difference was observable.

Network, fresh process per sample against `api.anthropic.com`: cold POST median
183ms versus 107-110ms after a warm request (7 samples each). An idle pooled
socket was reused after 30, 90 and 200s but not 320s, when the next request took
105ms, so warming matters after the same ~5 minute pauses that expire caches.

## Follow-up: credentials, Bun 1.4, new sessions

- **Credential cache.** `Auth.get` ran on every model request under a
  cross-process mkdir lock that backs off from 100ms when contended. It now
  serves the parsed file while its identity (inode, size, mtime, birthtime) and
  `OPENCODE_AUTH_CONTENT` are unchanged and the file is more than 2s old;
  writers still replace it atomically under the lock. Sequential p50 0.78ms to
  0.03ms; 8 concurrent callers max 610ms to 0.2ms.
- **Bun 1.4.2** (tested, not adopted). `fetch.preconnect` still throws `Invalid
port`. Forced HTTP/2 to `api.anthropic.com` was no faster warm (104 vs
  100ms) and slower for four cold concurrent requests (214 vs 169ms max). Local
  step overhead fell 5-12% at zero TTFT. The core suites passed except one new
  failure: ripgrep exiting early while the grep tool writes captured stdin now
  surfaces `EPIPE`.
- **New sessions already share the prompt cache.** Anthropic keys it by
  content, not session. The one new main session started within an hour of
  another in the same project read 51.8k prefix tokens and wrote none; same-type
  subagents share too (`general`: median 46k read, 1.1k written). The nine misses
  had no same-project activity within the hour. Prewarming would not help much:
  cached and uncached 25-70k first steps differed by ~55ms (1.89s vs 1.95s).

## Not changed

- **Prune** rewrites old tool outputs at loop exit and likely causes most
  new-turn misses within the TTL (7.0M tokens above). It also delays overflow
  compaction, and warm-cache TTFT barely depends on context size (2.07s at 338k
  vs 1.90s at 40k), so changing it is a context-policy decision.
- **Always sending the fast-mode beta header** would keep the cache across
  `/tier fast` toggles (the header is in the cache key; `speed` is not), and
  automatic standard-speed fallback on fast-mode 429s would follow from it.
  Rate-limit retries already honor `retry-after`.
- **HTTP/2** brought no gain on Bun 1.4.2 (above); home-screen warming needs a
  session-independent endpoint.

## Verification

- Typecheck passed. Session, provider, snapshot and config suites: 1,762 passed;
  the one failure (recorded Codex subscription cassette) and two tool-schema
  snapshot failures predate this work.
- New tests: tree patches match staged patches and revert identically; a tool
  loop carries trees and records exactly one patch per write step; mutating
  tools wait for the carried snapshot while read-only tools do not (verified to
  fail with the barrier removed); 1h tail only for primary direct-Anthropic
  requests and never in the provider body; `thinkingDisplay` beats variants;
  warm endpoint resolution.
- Live spend: about $4.15 (the max-effort A/B generated ~99k thinking tokens).

## Reproduce

From `packages/opencode`:

```sh
BENCH_REPO=$(git rev-parse --show-toplevel) BENCH_TTFT_MS=1000 BENCH_TOOL=write \
  bun run script/bench-anthropic-overhead.ts
BENCH_SNAPSHOT=0 bun run script/bench-anthropic-overhead.ts      # harness floor
BENCH_DUMP=/tmp/request.json bun run script/bench-anthropic-overhead.ts  # wire body
```

To opt out or in:

```jsonc
{ "provider": { "anthropic": { "options": { "promptCacheTtl": "5m", "thinkingDisplay": "omitted" } } } }
```
