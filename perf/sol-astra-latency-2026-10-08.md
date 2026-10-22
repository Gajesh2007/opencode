# Sol and Astra Latency Investigation

Follow-up: [implemented fixes and first-party OpenAI measurements](sol-astra-latency-fixes-2026-10-08.md).
The initial OpenAI access failure below was caused by this benchmark preferring
a stale environment key over the valid saved key, not by missing saved access.

Measured on 2026-10-08 from the local macOS/Bun 1.3.14 client. Production
configuration, credentials, and runtime behavior were not changed. Existing
uncommitted changes were preserved.

## Recommendation

The fastest verified configuration is currently **Bedrock Responses + Sol
Ultrafast + low reasoning**. It improved the installed harness's approximately
1,000-word report workflow from about 25.6 seconds to 6.8 seconds, around 73%
less elapsed time. This is a small-sample observation, not an SLA or a coding
quality evaluation.

Sol Ultrafast now works on both Bedrock Runtime and Mantle. This supersedes the
2026-10-06 observation in [the earlier Sol report](bedrock-sol61-report.md) that
Runtime rejected the tier. Service availability changes: inspect returned tiers,
not just UI labels or catalog entries.

Direct OpenAI could not be ranked: the configured key returns HTTP 401
`invalid_organization`. Codex accepts both models, but the tested OAuth account
received `default` even when the raw request explicitly specified `priority` or
`ultrafast`. This remained true with Codex routing hints. Sending `fast` directly
returned HTTP 400. This does not establish that other Codex accounts lack access.

## Raw API Results

Each path received three serial requests, with rotating order, identical synthetic
instructions, `reasoning.effort: low`, and `store: false`. Every completed code
response reported **388 output tokens, zero reasoning tokens, 57 input tokens,
and zero cached tokens**. These are raw HTTP Responses API timings, not full
session-service timings. Trial one includes cold connection effects.

| Path                             | Median first text | Median complete response | Visible tokens/s |
| -------------------------------- | ----------------: | -----------------------: | ---------------: |
| Codex Sol, default               |            1.817s |                   8.912s |             43.5 |
| Bedrock Runtime Sol, default     |            1.197s |                   5.393s |             71.9 |
| Bedrock Runtime Sol, Ultrafast   |        **0.739s** |               **1.376s** |        **281.9** |
| Bedrock Mantle Sol, default      |            1.232s |                   5.806s |             66.8 |
| Bedrock Mantle Sol, Ultrafast    |        **0.562s** |               **1.496s** |        **259.3** |
| Codex Astra, default             |            1.472s |                   9.074s |             42.8 |
| Bedrock Runtime Astra, default   |            0.950s |                   4.717s |             82.3 |
| Bedrock Runtime Astra, Ultrafast |            0.805s |                   2.413s |            160.8 |
| Bedrock Mantle Astra, default    |            0.888s |                   3.789s |            102.4 |

Runtime used `us-east-1` with `us.openai.<model>`. Mantle used `us-east-1`
for Sol and `us-west-2` for Astra, with `openai.<model>`. Entry regions do not
identify the physical inference region. This is not a controlled regional
comparison, and three samples do not establish a stable Runtime/Mantle winner.

All 27 code-generation requests completed and returned the requested model and
tier. Throughput is `(output_tokens - reasoning_tokens) / total_seconds`, not
the misleading delivery rate after the first chunk. Output shape was requested,
not independently compiled or quality-graded.

Relative to its own Runtime Standard baseline, Sol Ultrafast reduced median total
time by about **74.5%**; Astra Ultrafast reduced it by about **48.8%**. Sol Runtime
Ultrafast was about **6.5x faster** than Codex Sol default on this particular task.
That last comparison changes both backend and tier; it is not a transport gain.

Mantle Astra rejected Ultrafast. Both Runtime models and Mantle Sol accepted it,
and the completed Responses objects explicitly returned `service_tier: ultrafast`.

## Full Harness Check

Used installed OpenCode **1.18.34-ultrafast.20261008.1** and the existing isolated
report driver. Each workflow receives a sanitized repository brief, writes one
Markdown report through `apply_patch`, then acknowledges with `REPORT_SAVED`.
Configuration, database, filesystem output, and credentials are isolated from the
production session. Two trials per tier, rotated order, no retries.

| Tier / trial  | Report generation | Report saved | CLI elapsed | Workflow result                                  |
| ------------- | ----------------: | -----------: | ----------: | ------------------------------------------------ |
| Standard / 1  |           22.888s |      23.978s |     25.653s | Passed                                           |
| Standard / 2  |           23.727s |      24.580s |     25.594s | Report saved; exact acknowledgement check failed |
| Ultrafast / 1 |            5.156s |       6.011s |      6.785s | Passed                                           |
| Ultrafast / 2 |            5.245s |       6.102s |      6.889s | Passed                                           |

The median Ultrafast CLI time was 6.837s. Standard elapsed times were both about
25.6s, but **only one Standard workflow passed all checks**. Do not hide that
failure in success-only aggregate statistics or infer comparative reliability
from four workflows.

All four report-generation requests completed and wrote reports with 967-1012
words. Median per-request visible throughput was about 66.1 tokens/s Standard
versus 285.6 Ultrafast, **4.3x higher**. Report lengths and reasoning token counts
vary slightly, so normalized throughput complements wall-clock comparisons.

## Transport Findings

Codex's authenticated WebSocket Responses endpoint works with both models and
the current credentials. The harness currently forces Codex onto HTTP in
`packages/opencode/src/session/llm/native-runtime.ts:160-175`, and limits verified
continuation to direct OpenAI at lines 114-120.

Three additional code requests per Codex model reused one WebSocket per model,
without history continuation. Sol's median was 9.217s and Astra's 8.940s. Those
numbers do **not** show a convincing end-to-end speedup over HTTP. The runs were
separate and included one cold connection each; they are capability evidence,
not a definitive transport ranking. Enabling WebSockets alone does not make the
model decode faster.

The existing local native benchmark also passed all 24 requests. Warm first-text
medians were 1.27ms AI SDK HTTP, 1.95ms native HTTP, 1.50ms native WebSocket, and
1.33ms native WebSocket continuation. Verified continuation reduced average
request JSON from 14,535 bytes to 339 bytes. This measures local preparation and
payload reduction, not remote inference speed. It does not justify a claim that
rewriting the HTTP adapter will remove seconds from a request.

## Harness Opportunities

1. **Fix wire-level GPT-6 capability handling first.** Installed
   `@ai-sdk/openai@3.0.53` recognizes older reasoning models but not these GPT-6
   IDs. It drops `reasoningEffort` unless `forceReasoning: true` is supplied and
   strips Priority because its model capability predicate excludes GPT-6.
   Bedrock defaults already force reasoning; direct OpenAI/Codex defaults do not.
   Confirmed with in-memory streaming and non-streaming request captures. Extend
   capability handling and add wire assertions, rather than just asserting the
   intermediate provider-options object. Relevant files are the installed SDK's
   `openai-language-model-capabilities.ts`, `openai-responses-language-model.ts`,
   and `packages/opencode/src/provider/transform.ts`.
2. **Expose requested versus served tier.** The Codex probes demonstrate why a
   successful HTTP response is not proof that Ultrafast was used. Record selected
   tier, returned tier/model, first content time, completion time, cache usage,
   reasoning tokens, and retry count. Do not classify fallback responses as fast
   tier measurements.
3. **For direct OpenAI, restore access then test the existing native path.** Both
   `OPENCODE_EXPERIMENTAL_NATIVE_LLM=true` and provider options
   `transport: "websocket", responsesContinuation: true` are required. Keep
   `store:false`; the existing continuation adapter validates ownership and
   history before sending incremental input.
4. **Implement Codex WebSocket authentication and continuation at the adapter
   boundary.** Do not just remove the current HTTP guard: socket handshakes must
   get fresh OAuth credentials, the actual endpoint, and account headers. State
   must be invalidated after an account/token ownership change. Follow the
   official client's turn-scoped routing state, reconnect, and fallback behavior.
   The source supports `generate:false` prewarming. The application also restricts
   Codex Ultrafast to Sol, although current official documentation includes Astra.
5. **Add modern cache controls as an opt-in experiment.** Neither the installed
   AI SDK nor native request schemas forward `prompt_cache_options`, explicit
   `prompt_cache_breakpoint`, or `configuration_update`. Keep stable instructions,
   tools, and history prefixes; measure cache reads/writes before adding complexity.
   Explicit-only caching with stripped breakpoints can disable caching entirely.
   Cache prewarming and WebSocket `generate:false` warmup are distinct operations.

Lowest supported reasoning effort is **low**, not `none` or `minimal`. Lowering
effort is a quality/latency tradeoff; these tests do not justify lowering it for
every task. Cache hits reduce prefill, not newly generated output. Avoid changing
top-level effort mid-session if cache-preserving configuration updates can be
supported correctly; respect their documented compatibility restrictions.

## Cost and Scope

OpenAI documents Ultrafast at **6x Standard token pricing**; this is not a free
optimization. AWS's fetched Sol model card lists Standard pricing but does not
yet document Sol Ultrafast pricing. Applying a 6x multiplier to its short-context
US rates would imply $13.20/M input and $66/M output, versus $2.20/M and $11/M
Standard, before cache write/read accounting. That is an estimate, not verified
AWS billing. Confirm actual rates before sustained use. Codex subscription usage
multipliers also differ from API prices.

There is no verified direct OpenAI latency number, no long-context cache A/B, no
concurrency or p95 study, and no reasoning-quality evaluation here. The 40%
long-tool-chain improvement mentioned by OpenAI for WebSocket continuation is a
vendor observation, not a result measured on this checkout and not additive to
the tier speedup.

## Reproduce

Run from `packages/opencode`. The new driver sends synthetic content only, uses
fixed official endpoints, never logs credentials or raw server error messages,
disables retries, and refuses to overwrite an existing output file. It reads
literal API keys from global config/environment/stored auth; unresolved config
credential references are rejected and expired Codex credentials are not used.

```sh
BENCH_INSPECT=1 bun run script/bench-provider-latency.ts
BENCH_PROBE=1 BENCH_RUNS=1 bun run script/bench-provider-latency.ts
BENCH_RUNS=3 BENCH_OUTPUT_TOKENS=1024 \
  BENCH_PATHS=bedrock-gpt-6.1-sol-default,bedrock-gpt-6.1-sol-ultrafast \
  BENCH_OUTPUT=/path/to/existing/temp-directory/new-results.json \
  bun run script/bench-provider-latency.ts
BENCH_RUNS=3 BENCH_TRANSPORT=websocket BENCH_CODEX_ROUTING=1 \
  BENCH_PATHS=codex-gpt-6.1-sol-default,codex-gpt-6-astra-default \
  bun run script/bench-provider-latency.ts
```

The report driver now accepts `BENCH_TIERS=default,ultrafast`; its historical
defaults remain unchanged. Use a fresh existing `BENCH_DIR`:

```sh
BENCH_MODEL=gpt-6.1-sol BENCH_TIERS=default,ultrafast BENCH_RUNS=2 \
  BENCH_PATHS=runtime-us-east-1-us-default,runtime-us-east-1-us-ultrafast \
  BENCH_DIR=/path/to/fresh-existing-directory \
  BENCH_CONTEXT=/path/to/sanitized-brief.md \
  bun run script/bench-bedrock-report.ts
```

Raw artifacts remain under
`/var/folders/hv/5779vnmn5c564l3tdknlf4x80000gp/T/opencode/`:

- `provider-latency-probes-20261008.json`
- `provider-latency-code-20261008.json`
- `provider-latency-fast-probes-20261008.json`
- `provider-latency-codex-ws-probes-20261008.json`
- `provider-latency-codex-ws-code-20261008.json`
- `provider-latency-routing-probes-20261008.json`
- `sol-ultrafast-harness-20261008/results.json` and the generated reports

## Sources

- [OpenAI Ultrafast mode](https://developers.openai.com/api/docs/guides/ultrafast-mode)
- [OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)
- [OpenAI WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [GPT-6.1 Sol model card](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [Codex speed and plan eligibility](https://developers.openai.com/codex/agent-configuration/speed)
- [Official Codex client transport implementation](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs)
- [AWS Sol model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html)
- [AWS Responses API](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-responses-api.html)
- [AWS latency-optimized inference](https://docs.aws.amazon.com/bedrock/latest/userguide/latency-optimized-inference.html), a separate model-specific feature, not a generic GPT-6 speed switch

Official pages were fetched directly because Exa search credits were exhausted.
