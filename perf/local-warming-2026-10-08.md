# Local Connection and Context Warming

All implementation and experiments ran on the existing machine. No VMs,
proxies, network settings, selected models, service tiers, or credentials were
provisioned or changed. These measurements supplement the earlier
[latency fixes](sol-astra-latency-fixes-2026-10-08.md).

## Implemented

- WebSocket idle retention increased from 30 seconds to **300 seconds**.
  Maximum reuse age remains 55 minutes; the pool still caps retained idle
  sockets at 64 and never evicts active leases to satisfy idle capacity.
- The pool supports connection-only preconnection, exact-key in-flight
  deduplication, cancellation, and scoped shutdown. It sends no model payload.
- Native transport preconnection uses the same endpoint/authentication
  compilation as real requests. HTTP preconnection only uses the actual default
  fetch's capability; custom transports are not silently bypassed.
- Existing-session TUI drafts trigger an IDs-only warm request after a 400ms
  pause, with a 60-second cooldown. Shell commands, slash commands, busy,
  hidden, disabled, disconnected, and unsettled selections are skipped.
- Draft text, attachments, editor selections, and conversation history are not
  included in the warm request. Submission never waits for warming.
- A certified built-in instruction prefix receives its own cache boundary on
  the eligible Ultrafast path. `contextWarming: false` disables this behavior.
  Prefix/schema snapshots are bounded and contain no user messages or tool
  execution closures.
- Explicit standard-tier native prefix warming is bounded, retry-free, and
  cancellable. **Paid Ultrafast prewarming is disabled** based on the live
  capability results below, rather than repeatedly sending rejected requests.

The worker-backed TUI now carries request cancellation across its internal RPC
boundary. Cancelling a debounce alone was insufficient after a request had
started; opaque request IDs and worker-side abort controllers now stop the
actual server operation. Session abort/deletion and instance shutdown also
cancel warming, without allowing an old cancellation to affect a newer job.

The home screen has no real session ID until submission, so exact
session-affinity preconnection is limited to existing sessions. The persistent
TUI worker and cached provider initialization are retained; there is no new
process-per-prompt behavior.

## Preconnection Measurements

Five serial rounds used fresh connection-affinity keys, the same Sol model,
Ultrafast tier, low reasoning, and synthetic conversation. Each mode received
the same history, and order rotated. All calls completed with the requested
service tier and one request each.

| Measurement               | Cold native WebSocket | Preconnected native WebSocket |
| ------------------------- | --------------------: | ----------------------------: |
| Median send-to-first-text |                 864ms |                         615ms |
| Median send-to-completion |                 897ms |                         707ms |

Preconnection itself took **110-223ms**, median approximately 193ms, outside the
send timer. The approximately **29% lower first-text wait** is therefore a shift
of connection work into idle/typing time, not faster inference. Including that
upfront work did not establish a lower total operation time.

A controlled local test injected a 120ms handshake delay. First text arrived
around 130-137ms without preconnection versus 2.4ms after preconnection. This
validates placement of the work, not production network speed.

## Idle Retention

A live two-turn test waited **35 seconds** between turns. Verified continuation
still succeeded with a **359-byte** outgoing request, beyond the old 30-second
idle limit. Unit tests cover the five-minute timer without spending five minutes
asleep, plus maximum-age expiry, idle capacity, active leases, and cancellation.
Providers and networks can still close a connection earlier than our retention
limit; full-context recovery remains necessary.

## Paid Prewarming: Provider Limitation

Live Sol probes found:

| Request                                                           | Result                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------- |
| Ultrafast HTTP `prompt_cache_options.prewarm: true`, streaming    | HTTP 400, unsupported value                                |
| Ultrafast HTTP `prompt_cache_options.prewarm: true`, nonstreaming | HTTP 400, unsupported value                                |
| Standard HTTP prewarm                                             | Success, no output tokens                                  |
| Standard prewarm followed by Ultrafast generation                 | Zero cached reads in all three trials                      |
| Ultrafast WebSocket `generate:false`                              | Accepted request-state warmup, but no cache write reported |

The WebSocket request-state probe's subsequent generated turn still wrote the
full prefix rather than reporting cached reads. It is not evidence of warmed
model prefill. No speculative state-warm mechanism was added on that basis.

Same-tier Standard tests did reuse **2,769 of 2,788 input tokens** after
prewarming. Generation-only first-text medians were approximately 1,268ms cold
and 1,021ms warmed, with substantial variability. The warmup itself cost
709-994ms. Including it made the total slower unless that work could be moved
off the user's critical path. This is why supported paid warming is selective,
not run synchronously before every generation.

Limits for the supported path: one job per session, two globally, 32 retained
snapshots, 15-minute freshness, 60-second attempt cooldown, a 10-second deadline,
and no automatic retries. Prefix/tool snapshots must fit the byte and approximate
token bounds; oversized or untrusted snapshots are skipped without truncation.
Only a captured native Standard request with explicit `contextWarming: true`
can schedule paid warming. Unsupported tiers do not retain expensive snapshots.

## Verification and Build

- 397 application regression tests passed across 18 targeted files.
- Complete native package suite: 305 passed, 28 intentionally skipped.
- Application and native package typechecks passed.
- Tests cover exact header/socket reuse, zero-idle-capacity handoff, maximum age,
  cancellation during opening and paid work, actual worker/RPC cancellation,
  schema-only snapshots, matching tool choice, and unsupported-tier suppression.
- Built and version-smoke-tested local macOS arm64 CLI
  `1.18.34-warm.20261008.3` at
  `packages/opencode/dist/opencode-darwin-arm64/bin/opencode`.

The build includes TUI support and omits the embedded web UI. No global binary
was replaced. Restart with this build to use the new pool and TUI behavior.

## Reproduce

From `packages/opencode`; live requests are billable:

```sh
BENCH_MODEL=gpt-6.1-sol BENCH_TIER=ultrafast BENCH_TURNS=5 \
  BENCH_PRECONNECT=1 BENCH_COLD=1 bun run bench:openai

BENCH_MODEL=gpt-6.1-sol BENCH_TIER=ultrafast BENCH_TURNS=2 \
  BENCH_PRECONNECT=1 BENCH_PAUSE_MS=35000 bun run bench:openai

BENCH_MODEL=gpt-6.1-sol BENCH_TIER=default BENCH_PREWARM_TIER=default \
  BENCH_TRIALS=3 bun run script/bench-context-warm.ts
```

`BENCH_LOCAL=1` runs the context benchmark against a synthetic endpoint.
`BENCH_LOCAL_FAULT=prewarm-output` and `http-503` verify rejection/no-retry paths.
`BENCH_OUTPUT` writes metrics to a new file without prompts or credentials.

Raw artifacts remain in the approved local temporary directory:

- `openai-cold-preconnect-20261008.json`
- `openai-preconnect-idle-20261008.json`
- `openai-standard-prewarm-20261008.json`
- `openai-cross-tier-prewarm-20261008.json`
- `openai-prefix-prewarm-valid-20261008.json` (retained rejected Ultrafast attempt)
