# Parallel Tool Benchmark

Run from `packages/opencode`. The default is **offline**. No live evaluation has
been authorized or run as part of adding this harness.

```sh
bun test test/session/parallel-tool-benchmark.test.ts --timeout 120000
bun script/bench-parallel-tools.ts --mode offline --output ./parallel-offline.jsonl
```

The harness runs the real CLI and Read/Grep/ApplyPatch tools in fresh synthetic
repositories with fresh homes, databases, and provider state. A loopback Responses
API proxy supplies deterministic responses offline. In live mode, only that proxy
has the upstream API key and can contact the fixed official provider endpoint.
Every CLI child and its descendants run under a macOS Seatbelt profile permitting
only outbound TCP to the local proxy's port; the proxy binds only `127.0.0.1`.
Other ports, remote hosts, inbound listeners, UDP, and direct DNS service lookup
are denied. The harness fails closed if `sandbox-exec` is
missing, unusable, or the platform is not supported; there is no unsandboxed fallback.
Fresh homes and tool permissions isolate user configuration, skills, and data.
Shell, network tools, subagents, plugins, external directory permissions, warming,
continuation, and automatic compaction are off.
`rg` must already be installed; the harness refuses to arrange a download.
The config directory's plugin dependency is linked from the local checkout and
its lock metadata is provisioned before launch, so config loading does not need
an npm install. npm is also forced offline. `OPENCODE_TEST_MANAGED_CONFIG_DIR`
always names a new empty scratch directory; inherited overrides are ignored.
Seatbelt denies reads of macOS managed preferences and the system managed config
directory, including preferences that would otherwise override inline config.

## What Is Compared

The principal baseline preserves the pre-change parallel option: omit
`parallelToolCalls` (or use `true`). Both default offline arms batch independent
reads. These are **scripted plumbing checks**, not evidence that a model improved.
Live responses are not scripted. `false` is accepted only with `"ablation":"serial"`;
that deliberately serializes the scripted reads and is not the principal baseline.

Every trial uses identical fixture content across arms, with deterministic codes
derived from the trial number. Model/case order rotates between trials. Arm order
alternates within pairs to reduce systematic ordering effects. Each sample is a
cold CLI process; model caches and provider load are not controlled.
The manifest fingerprints the harness and relevant tool/runtime source files.
Those hashes identify the working tree, but do not freeze it: use a quiescent
checkout while collecting matched live samples.

| Fixture             | Acceptance                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `known-files`       | Four specified independent files, four correct codes, no edits                                     |
| `discovery`         | Find a marker, obtain adjacent references via Grep context or Read, then read the referenced files |
| `dependent-reads`   | Read a pointer, then its target in a later model turn                                              |
| `conflicting-edits` | Read, edit, verify, edit, verify; overlapping or merged edits fail                                 |

Correct final JSON alone is insufficient. Required evidence must actually be
returned by tools, protected files must be unchanged, and dependency/overlap
controls must pass. Repeated reads of the same evidence do not earn credit;
verification of changed content is distinct necessary evidence. ReadMany is one
tool call but its per-file read width and evidence are scored individually.

## Prompt And Tools

An optional `--arms /path/to/arms.json` accepts:

```json
{
  "baseline": {
    "promptFile": "/path/to/pre-change-gpt.txt",
    "readMany": false,
    "grepContext": false
  },
  "candidate": {
    "promptFile": "/path/to/candidate-gpt.txt",
    "readMany": true,
    "grepContext": true,
    "parallelToolCalls": true
  }
}
```

`prompt` may supply a full prompt string instead of `promptFile`. Candidate prompt
defaults to the current `src/session/prompt/gpt.txt`; live runs require an explicit
baseline snapshot. Capture the pre-change prompt externally; never overwrite
source to run an arm. The proxy replaces the exact current built-in GPT prefix in
memory, preserving environment/task instructions. A missing or duplicated prefix
fails closed before forwarding. Results retain prompt hashes, never prompt text,
raw configuration, tool output, raw errors, headers, keys, or absolute paths.

Both arms otherwise use the same checkout, provider, model, tier, effort, caps,
and native/AI SDK runtime. `parallelToolCalls` is set as an agent provider option;
the proxy verifies it, tier, and effort before sending any upstream request.
`grepContext` exposes the real Grep `context` parameter in that arm's schema. It
defaults to false for explicit arms; the default offline candidate enables it.
The discovery case allows context to replace a full-file read without accepting
speculative reads of the referenced files. `flexibleContextStages` distinguishes
these optional read stages from the required `necessaryReadStages` count.
This compares prompt/tool availability/options, not two source-code revisions.
To run a separate serial ablation, explicitly set both `"parallelToolCalls":false`
and `"ablation":"serial"`. The label is retained in the manifest and samples so
those results cannot be mistaken for the pre-change baseline.
Select `BENCH_RUNTIME=native` (default) for native tool dispatch, or `ai-sdk` for
the existing SDK path. HTTP is deliberate: WebSockets would bypass the metering
proxy. The harness does not claim WebSocket or production end-to-end latency.

Enable `readMany` after the real `read_many` tool is registered. Its expected
interface is `files: [{filePath, offset?, limit?}]` and standard per-file `<path>`
Read output blocks and `metadata.results` per-file statuses. An unavailable or
incompatible schema fails before a live request. No substitute bulk-read
implementation is installed by this harness.

## Live Authorization

Only the supervising user/parent should execute live runs after reviewing costs.
Live execution requires **all** of the following: `--mode live`,
`BENCH_ALLOW_LIVE=1`, an explicit baseline snapshot, `BENCH_MAX_CALLS`,
`BENCH_MAX_USD`, and positive input/output USD-per-million ceilings. There are no
automatic retries in the proxy. Any retries attempted by the app consume the
same shared budget; a provider error stops the run rather than launching another
billable recovery attempt.

The provider is `BENCH_PROVIDER=openai` (default) or `amazon-bedrock`, both using
their Responses endpoint. Bedrock uses the US inference-profile model IDs at
`bedrock-runtime.us-east-1.amazonaws.com`; no arbitrary upstream URL is accepted.
The app-facing adapter is OpenAI Responses for either endpoint. OAuth/Codex and
SigV4 are not supported because their refresh/signing paths would weaken the
single-proxy cost boundary. API keys resolve from the app's saved auth store
first, then `OPENAI_API_KEY` or `AWS_BEARER_TOKEN_BEDROCK`. Set
`BENCH_AUTH_SOURCE=env` or `stored` to require one source. Keys are not copied to
temporary files or child environments.

| Variable                       | Default / Limit                                             |
| ------------------------------ | ----------------------------------------------------------- |
| `BENCH_MODELS`                 | `gpt-6.1-sol,gpt-6-astra`; only these two IDs accepted      |
| `BENCH_TIER`                   | `default`; also `priority`, `ultrafast`                     |
| `BENCH_EFFORT`                 | `low`; also `medium`, `high`, `xhigh`                       |
| `BENCH_RUNS`                   | 1; 1-5                                                      |
| `BENCH_MAX_CALLS`              | 128 offline; explicit live value required; hard maximum 128 |
| `BENCH_MAX_CALLS_PER_SAMPLE`   | 8; hard maximum 12, including a final answer request        |
| `BENCH_OUTPUT_TOKENS`          | 768 per request, including reasoning; 64-2048               |
| `BENCH_INPUT_TOKENS`           | 65536; conservative UTF-8 request bytes + 1024; 1024-131072 |
| `BENCH_WALLTIME_MS`            | 900000 for the run; hard maximum 3600000                    |
| `BENCH_SAMPLE_MS`              | 120000; hard maximum 180000                                 |
| `BENCH_MAX_USD`                | Explicit live value required; hard maximum 20               |
| `BENCH_INPUT_USD_PER_MILLION`  | Explicit positive live price ceiling required               |
| `BENCH_OUTPUT_USD_PER_MILLION` | Explicit positive live price ceiling required               |

`--only known-files,discovery` limits cases. Start with one model, one pair, and a
small explicit budget. Use the **larger** applicable price across selected models
and tiers for each ceiling. Inspect the offline output and arm snapshots first.
No executable live command with guessed prices is provided here.

Each forwarded attempt reserves its entire conservative input estimate plus the
maximum output cost **before** network dispatch. Reservations are not refunded
on missing usage, cancellation, or provider failure. Each request has an output
limit on the wire. The proxy counts all forwarded calls, kills timed-out clients,
aborts in-flight requests, limits response/log bytes, and refuses redirects.
An upstream body error or premature disconnect cancels its reader, stops the
shared run immediately, and never forwards another retry. Exceptions are replaced
with fixed error codes, not logged or forwarded verbatim.
Budget exhaustion can leave an incomplete pair; such samples are retained, and
the summary explicitly reports completed pairs and planned/actual sample counts.

These are **estimated spend** limits, not a provider-enforced dollar cap.
Tokenization, uncatalogued tier surcharges, provider minimums, cancellation
accounting, and taxes can differ. Missing usage stays unknown, never zero-priced.
Use provider-side spending controls as well when a strict financial cap matters.

## Results

`--output` must name a new file in an existing directory. Results are append-only
JSONL, created with exclusive creation and owner-only permissions; an existing
file is never overwritten. The first record is a manifest; each sample is
flushed separately, followed by a summary. Temporary repositories/homes are
removed even on failed samples. Without `--output`, results go to a new directory
under the OS temporary directory; programmatic `run()` returns its path.

Sample records include correctness, valid unique necessary read stages and file
counts, redundant/incomplete/unnecessary/error reads, tool errors, dependency
violations, conflicting edits, tool-call and file-read batch widths, model request
count, time to the correct final answer (null on failure), wall time, tool
durations, requested/served models and tiers, usage, cost reservations, and usage
estimates with explicit unknowns. A served-model mismatch or missing/mismatched
tier makes a sample invalid; `priority`/`fast` is the sole tier alias accepted.
Emitted calls, locally invoked calls, terminal results, unadvertised tools, and
calls with unknown invocation status are reported separately. Tool timing retains
status and consistently hashed call IDs for correlation, along with top-level and
per-file truncation metadata. A missing invocation timing is unknown, not proof of
non-execution. Requested and observed runtime, runtime mismatch, and fallback
reason fingerprints are retained; an unverified/mismatched runtime invalidates
the sample. No raw fallback reason or tool payload is written.

Do not compare latency only among whichever runs happened to succeed without
also reporting failures, incomplete pairs, routing mismatches, and budget stops.
Offline timing is a harness check, not a live performance measurement.
