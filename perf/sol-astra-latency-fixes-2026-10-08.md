# Sol and Astra Latency Fixes

Follow-up to [the initial investigation](sol-astra-latency-2026-10-08.md).
Measured locally on 2026-10-08 with Bun 1.3.14. These are small-sample observations,
not latency guarantees or a quality evaluation.

## OpenAI Access Correction

The saved OpenAI API key works. The initial benchmark incorrectly preferred a
different, stale `OPENAI_API_KEY` environment value. Production provider loading
already gives saved credentials precedence. Benchmark credential selection now
matches that behavior, and supports an explicit source override for diagnostics.
Both Sol and Astra returned successful first-party Ultrafast responses with the
requested model and `service_tier: "ultrafast"`.

## First-Party Measurements

Raw HTTP, three serial trials per model/tier, rotating order, `low` effort and
`store:false`. The code task generated 388 output tokens except one Sol Ultrafast
trial with 364. Tables use medians of individual samples.

| Model | Served tier | First text | Complete response | Visible output tokens/s |
| ----- | ----------- | ---------: | ----------------: | ----------------------: |
| Sol   | Standard    |     0.994s |            5.448s |                    71.2 |
| Sol   | Fast        |     0.786s |            4.268s |                    90.9 |
| Sol   | Ultrafast   |     0.636s |            2.366s |                   164.0 |
| Astra | Standard    |     1.428s |            6.851s |                    56.6 |
| Astra | Fast        |     0.845s |            3.877s |                   100.1 |
| Astra | Ultrafast   |     0.852s |            1.612s |                   240.7 |

OpenAI returned `fast` for requests using the documented `priority` alias. This
is a valid match, not a downgrade. Codex's earlier `ultrafast -> default` result
is different: that account's premium tier was not honored.

### Actual Source CLI

The updated source CLI generated a roughly 1,000-word report with `apply_patch`
and acknowledged it. Two trials per tier; all four workflows passed. A local
proxy validates and measures HTTP request bodies without retaining credentials.
The proxy intentionally selects the HTTP path, not automatic public-endpoint
WebSocket routing.

| OpenAI Sol tier | Report generation | Report saved | Full source CLI |
| --------------- | ----------------: | -----------: | --------------: |
| Standard        |           24.792s |      26.236s |         28.409s |
| Ultrafast       |            5.680s |       6.923s |          7.906s |

Ultrafast reduced full CLI elapsed time by about **72%**, and report-generation
time by about **77%**. This compares tiers on the same updated harness; it does
not attribute the entire improvement to local code changes.

### Native Transport and Continuation

The real native adapter was measured against first-party OpenAI, with equal
synthetic conversation histories and confirmed Ultrafast service. Cold requests
are excluded from these warm first-text medians.

| Model                     | AI SDK HTTP | Native HTTP | Native WebSocket | WebSocket + verified continuation |
| ------------------------- | ----------: | ----------: | ---------------: | --------------------------------: |
| Sol, five warm samples    |      0.862s |      0.799s |           0.692s |                        **0.583s** |
| Astra, three warm samples |      0.885s |      0.768s |           0.742s |                        **0.646s** |

In these short acknowledgement sequences, verified continuation reduced median
first-text latency relative to AI SDK HTTP by about **32% for Sol** and **27%
for Astra**. All measured requests used one attempt; no hidden fallback request
was required. Warm continuation bodies were **359 bytes**, versus roughly
14.4-14.5 KB for full history. Cold WebSockets can be slower than cold HTTP.
These results do not establish tail latency or long-tool-chain speedups.

### Explicit Cache Boundaries

A separate Sol Ultrafast test used a 4,131-token input with a changing suffix in
one user message. The first explicit request wrote 4,114 tokens. Each of the next
three reused **4,114 tokens**, with zero new cache-write tokens. Four implicit
control requests reported zero cached tokens because their only eligible
message-ending boundary included the changing suffix.

This confirms that the explicit marker reaches the API and preserves the useful
prefix. The separate runs are not a controlled latency A/B; network variability
was substantial. Ordinary append-only conversations can already benefit from
implicit caching without explicit markers.

## Implemented Changes

- Patched all used OpenAI SDK versions to recognize exact Sol/Astra IDs and
  snapshots for reasoning and Priority. Selected effort and tier now survive
  serialization; actual returned model metadata is preserved.
- Direct public-OpenAI Ultrafast requests automatically use native WebSocket and
  verified continuation. Explicit HTTP opts out. Custom endpoints/fetch hooks
  are not silently bypassed. Only a pre-send socket-opening failure can fall
  back once to full-history HTTP; failures after sending/output cannot replay.
- Added opt-in Codex WebSocket authentication and continuation using fresh OAuth
  credentials and account-scoped ownership. Codex remains opt-in because account
  tier availability and backend behavior differ from first-party API access.
- Added typed cache options and explicit text/system boundaries to SDK and native
  lowering. Explicit-mode session configuration marks the leading system prefix;
  default implicit behavior remains unchanged. Unsafe interleaved-system cache
  ordering falls back rather than moving content across the intended boundary.
- Standalone API prewarm is supported. Conversational `prewarm:true` is rejected
  before sending a paid request, avoiding repeated hollow-response retries.
- Fixed WebSocket provider-error termination, nullable error fields, and cache
  validation before continuation trimming.
- Persisted requested tier, served tier, and actual wire model independently.
  TUI and transcript identify downgrades and unknown service tiers, and clear old
  confirmations before a new attempt can fail during preparation.
- Reduced unnecessary full-payload parsing in the provider fetch wrapper when
  no item IDs need removal. Escaped keys retain the conservative parsing path.
- Added conditional OAuth refresh persistence and environment-backed credential
  handling, with locking and account-switch regression tests.

No global model selection or credentials were changed. Existing unrelated work
in the checkout was preserved. SDK types were regenerated for the new optional
response metadata and conditional-auth endpoint contract.

## Verification and Build

- 709 application regression tests passed across 22 targeted files.
- 89 native Responses/cache/WebSocket tests passed.
- Application and native package typechecks passed.
- Independent review verified the final conditional-auth fixes: persisted
  per-provider revisions and tombstones prevent stale or cross-provider refreshes
  from restoring an old account; the lock is shared even with different state
  directories. Five subprocess cases exercise those conditions.
- Built `1.18.34-latency.20261008.2` for macOS arm64 and passed its version smoke
  test. This local CLI build omits the embedded web UI, not TUI support.
- The new binary completed an additional real OpenAI Sol Ultrafast report
  workflow in 7.605s, including file writing and acknowledgement.

The binary is at
`packages/opencode/dist/opencode-darwin-arm64/bin/opencode`. No global executable
was replaced; restart with this build to use the changes in an interactive
session. The current running process cannot hot-reload these source changes.

## Scope and Safety

OpenAI documents Ultrafast at **6x Standard token pricing**. Fast and Codex
subscription usage have different multipliers. Actual cost depends on returned
usage and the provider's current pricing; no benchmark throughput figure is a
billing statement.

`configuration_update` is intentionally not synthesized. It requires ordered,
persisted effort changes and has restrictions around mode and compaction. Fixed
effort requests do not need it. Blindly injecting it would risk changing history
semantics to obtain an unmeasured cache benefit.

## Reproduce

Run from `packages/opencode`; these live commands incur charges:

```sh
BENCH_AUTH_SOURCE=stored BENCH_RUNS=3 BENCH_OUTPUT_TOKENS=1024 \
  BENCH_PATHS=openai-gpt-6.1-sol-default,openai-gpt-6.1-sol-priority,openai-gpt-6.1-sol-ultrafast \
  bun run script/bench-provider-latency.ts

BENCH_MODEL=gpt-6.1-sol BENCH_TIER=ultrafast BENCH_TURNS=6 bun run bench:openai

BENCH_PROBE=1 BENCH_CACHE=explicit BENCH_RUNS=4 \
  BENCH_PATHS=openai-gpt-6.1-sol-ultrafast bun run script/bench-provider-latency.ts
```

For the source CLI report test, provide a fresh existing output directory and a
sanitized brief:

```sh
BENCH_PROVIDER=openai BENCH_SOURCE=1 BENCH_MODEL=gpt-6.1-sol \
  BENCH_TIERS=default,ultrafast BENCH_RUNS=2 \
  BENCH_PATHS=openai-default,openai-ultrafast \
  BENCH_DIR=/path/to/fresh-directory BENCH_CONTEXT=/path/to/sanitized-brief.md \
  bun run script/bench-bedrock-report.ts
```

Raw measurements remain under
`/var/folders/hv/5779vnmn5c564l3tdknlf4x80000gp/T/opencode/`:

- `openai-tier-code-20261008.json`
- `openai-sol-native-ultrafast-20261008.json`
- `openai-astra-native-ultrafast-20261008.json`
- `openai-sol-auto-ultrafast-20261008.json` (live automatic-path smoke)
- `openai-cache-explicit-20261008.json`
- `openai-cache-implicit-20261008.json`
- `openai-source-harness-20261008/results.json` and four generated reports
- `openai-compiled-harness-20261008/results.json` and the compiled-CLI report
