# OpenAI Latency Benchmarks

Run these commands from `packages/opencode`, not the repository root.

## Transport And Payloads

```sh
BENCH_LOCAL=1 BENCH_TURNS=20 bun run bench:openai
```

This starts a loopback HTTP/WebSocket Responses endpoint and compares:

- AI SDK HTTP with full history.
- Native HTTP with full history.
- Native WebSocket with full history.
- Native WebSocket with verified incremental continuation.

Each mode gets the same synthetic conversation. Execution order rotates between
turns. JSON lines report time to first text, completion time, outgoing JSON bytes,
request count (including fallbacks), and whether a continuation pointer was sent.
Summaries separate the first request from warm requests. Native measurements run
through the application's real native adapter, including continuation validation.
The AI SDK comparison uses `streamText` directly, not the full session service.

Loopback measures local overhead and payload reduction, not OpenAI inference,
internet latency, TLS handshakes, or a complete agent/tool workload. In particular,
it does not establish that WebSockets are faster than HTTP in production.

To run against the real OpenAI endpoint:

```sh
BENCH_MODEL=gpt-6-astra BENCH_TURNS=6 bun run bench:openai
```

This uses the saved OpenAI API key, falling back to `OPENAI_API_KEY`, and makes
billable requests. Credentials are used for authentication and never logged.
It sends synthetic context only, never workspace content. The default model is
`gpt-5.2`; the default is six turns per mode. Each response is capped at 512 output
tokens and a 60-second deadline. Hold model, effort, tier, and context constant when
comparing results. Small samples and shared server-side prompt caches can bias
results; rerun before drawing conclusions about tail latency.

Set `BENCH_TIER=ultrafast` to measure that tier with confirmation from each
response. `BENCH_AUTO=1` additionally exercises automatic transport selection;
`BENCH_OUTPUT` stores the synthetic measurements in a new JSON file. The driver
accepts the documented `priority` to `fast` response alias.

`BENCH_PRECONNECT=1` adds a preconnected WebSocket case and reports the separate
`preconnectMs` cost. `BENCH_COLD=1` uses distinct connection-affinity keys for
each turn to compare repeated cold connections. `BENCH_PAUSE_MS=35000` tests
retention over a real idle gap; `BENCH_LOCAL=1 BENCH_HANDSHAKE_MS=120` provides a
controlled synthetic handshake delay. Preconnection moves work before the
submit timer; it is not free or faster model decoding.

## Provider Request Preparation

```sh
env -u OPENCODE_CONFIG -u OPENCODE_YOLO OPENCODE_BENCHMARK=1 bun test test/provider/request-latency.test.ts --timeout 30000
```

This exercises `Provider.getLanguage()` and its real fetch wrapper against a local
HTTP server, using a 606,208-byte synthetic context. Each case runs five warmups and
100 measured requests. It checks the wire content and item-ID handling with and
without `store`. Reported times include SDK preparation, local HTTP, and stream
consumption, but exclude the assertions. Run without concurrent builds/tests for
more stable measurements.

## Streaming And Connection Regressions

```sh
env -u OPENCODE_CONFIG -u OPENCODE_YOLO bun test test/session/processor-effect.test.ts --timeout 30000
env -u OPENCODE_CONFIG -u OPENCODE_YOLO bun test test/session/llm-continuation.test.ts --timeout 30000
```

The processor tests inject a real 120 ms HTTP-stream pause after small text,
reasoning, and tool-input fragments. They measure publication after the processor
receives each fragment, not terminal paint time. They also check ordered flushing
on completion and cancellation. The 16 ms flush interval is a scheduling target,
not a hard deadline when the event loop is blocked.

For per-case timing output, add `OPENCODE_TEST_DELTA_LATENCY=1` and select
`--test-name-pattern 'bounds delayed'`. Clear inherited configuration overrides
when running application tests, as shown above, so a developer's real providers
cannot leak into the local fixtures.

From `packages/llm`, run:

```sh
bun test test/websocket-pool.test.ts test/provider/openai-responses.test.ts --timeout 30000
```

## Initial Results

Measured on macOS arm64 with Bun 1.3.14. These are local observations, not promised
production improvements:

| Measurement                                                      | Before                                              | After                                    |
| ---------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------- |
| First fragment publication during a 120 ms provider pause        | 121-125 ms                                          | Below 1 ms in the targeted runs          |
| Subsequent small fragment publication during that pause          | 121-125 ms                                          | Approximately one 16 ms timer interval   |
| Warm request JSON, 20-turn synthetic conversation                | 15,630 bytes average, full-history native WebSocket | 339 bytes average, verified continuation |
| 606 KB context, no item IDs, `store:false` median round trip     | 4.49-4.77 ms                                        | 2.87-3.48 ms                             |
| Original connection pool against the initial 10 regression cases | 4 pass, 6 fail                                      | 10 pass, 0 fail                          |

The HTTP timing ranges are from separate runs, with noisy tail timings; the
serialization change does not help requests that actually need IDs removed.
Cold processor runs also recorded 92-100 ms delayed-flush outliers; warm full-suite
runs were around 16-18 ms. Immediate first-fragment publication stayed below 1 ms
in those runs. These are observations, not hard scheduling guarantees.
The socket pool additionally has a 64-idle-connection default cap and keeps active
leases out of capacity eviction.

Idle retention is now five minutes, with a 55-minute maximum reuse age and scoped
shutdown. The TUI can preconnect an existing session after a 400ms typing pause,
with a server-side cooldown; no draft text is sent. See the
[local warming report](../../../perf/local-warming-2026-10-08.md) for live results
and the limitation on paid Ultrafast prefix prewarming.

A live test on 2026-09-29 returned `401 invalid_organization` for the available
key. Retrying with `gpt-5.2` instead of `gpt-6-astra` returned the same organization
access error, so end-to-end OpenAI speedups and model comparisons remain unmeasured.

That historical access result is superseded by the
[2026-10-08 follow-up](../../../perf/sol-astra-latency-fixes-2026-10-08.md).
A stale environment key had masked valid saved credentials in the benchmark.

Native direct-OpenAI requests also skip constructing an unused AI SDK model.
A sampled first-use initialization took 75.9 ms before that change; the same test
now observes zero AI SDK model loads. This is eliminated setup work, not a claim
of 75.9 ms lower end-to-end latency: setup can overlap other preparation. Unsupported
native requests still load the AI SDK exactly once, and the default AI SDK path
is unchanged. To inspect those calls through the actual session LLM service:

```sh
env -u OPENCODE_CONFIG -u OPENCODE_YOLO -u OPENCODE_YOLO_FOREVER OPENCODE_BENCHMARK=1 bun test test/session/llm.test.ts --test-name-pattern 'native runtime when opted|native OpenAI is unsupported' --timeout 30000
```

## Opt-In Continuation

HTTP/AI SDK remains the default outside eligible, explicitly selected direct
OpenAI Ultrafast requests. Those requests now automatically use native WebSocket
and verified continuation on the trusted public endpoint. `transport: "http"`
opts out. Custom endpoints and fetch overrides are not automatically migrated.
Only a failed socket opening before sending can fall back to full-history HTTP.

Other native OpenAI WebSocket requests are enabled with
`OPENCODE_EXPERIMENTAL_NATIVE_LLM=true` and these provider options:

```json
{
  "provider": {
    "openai": {
      "options": {
        "transport": "websocket",
        "responsesContinuation": true
      }
    }
  }
}
```

The same opt-in options are supported under `provider.openai-codex.options` for
Codex OAuth, using plugin-owned credential refresh and authenticated handshakes.
Codex is never automatically moved to native by its service tier. It retains
`store:false`. Unknown, altered, or expired continuation state falls back to full
history; changed tool definitions are resent. Responses are never retried for a
stale pointer after output or tool execution has started. First-fragment flushing
and parallel prompt preparation do not require these experimental options.

## Explicit Cache Boundaries

For supported Responses models, `promptCacheOptions: { "mode": "explicit",
"ttl": "30m" }` in model options marks the last leading system message as a
reusable prefix. Default implicit caching is unchanged. SDK/native text parts
can also carry `providerOptions.openai.promptCacheBreakpoint: { "mode": "explicit" }`.
Unsafe interleaved system ordering uses the SDK path rather than hoisting content
across cache boundaries. A breakpoint on assistant output is rejected.

Standalone Responses requests support cache `prewarm`, but conversational requests
reject `prewarm: true` before inference: a prewarm is not an assistant response and
must not trigger empty-response retries.
