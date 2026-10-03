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

This requires `OPENAI_API_KEY` and makes billable requests. It sends synthetic
context only, never workspace content or stored credentials. The default model is
`gpt-5.2`; the default is six turns per mode. Each response is capped at 512 output
tokens and a 60-second deadline. Hold model, effort, tier, and context constant when
comparing results. Small samples and shared server-side prompt caches can bias
results; rerun before drawing conclusions about tail latency.

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

A live test on 2026-09-29 returned `401 invalid_organization` for the available
key. Retrying with `gpt-5.2` instead of `gpt-6-astra` returned the same organization
access error, so end-to-end OpenAI speedups and model comparisons remain unmeasured.

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

HTTP/AI SDK remains the default. The native OpenAI WebSocket path is enabled with
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

This applies to direct OpenAI API authentication, not Codex OAuth. It retains
`store:false`. Unknown, altered, or expired continuation state falls back to full
history; changed tool definitions are resent. Responses are never retried for a
stale pointer after output or tool execution has started. First-fragment flushing
and parallel prompt preparation do not require these experimental options.
