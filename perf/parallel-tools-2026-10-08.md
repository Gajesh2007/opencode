# Parallel Tool Improvements

Implemented and evaluated on October 8, 2026 local time (the live records are
dated October 9 UTC). This report separates correctness checks from the small
live experiment. It does not claim a general model-quality or latency gain.

## Changes

- Replaced the GPT prompt's unavailable-wrapper requirement with instructions
  to emit useful independent calls together, discover unknown paths first,
  avoid redundant retrieval, and order dependent edits and checks.
- Added native Responses `parallelToolCalls` forwarding for HTTP and WebSocket,
  preserving omission, `true`, and `false`. No global force-on policy was added.
- Added `read_many`: 1-16 known text files/ranges, at most eight concurrent reads,
  200 lines per item by default, and a 50 KiB aggregate output limit. It reuses
  read permissions and instruction handling. Item errors do not discard sibling
  results; images/PDFs direct the caller to `read` instead.
- Added optional `grep.context` (0-10 neighboring lines), with bounded contextual
  output and explicit truncation. Omitted/zero context preserves normal grep.
- Added opt-in eager native dispatch for trusted, explicitly marked read-only
  tools. Complete validated calls can execute while later calls are generated.
  Unknown tools and mutations remain deferred; follow-up requests still wait for
  all results. Custom tools are not trusted merely because their name is `read`.
- Bound eager tool bridge fibers to cancellation and wait for cleanup. Repeated
  call IDs and repeated tool-input/result events no longer create extra dispatches
  or unmatched session records.
- Shared ordered file-mutation locks across edit, write, and apply_patch, including
  move destinations, canonical paths, and device/inode identities for hard-link
  aliases. Contents, existence, and target identity are checked again after
  permission waits. This is same-process coordination, not a filesystem
  transaction or cross-process locking guarantee.

Bulk reads deduplicate instruction reminders only after their reads settle, so
a failed item cannot hide a successful sibling's guidance. Only fully returned
reminders remain claimed; omitted guidance stays retrievable without clearing
another concurrent batch's claims.

## Evaluation Method

`packages/opencode/script/bench-parallel-tools.ts` runs the real source CLI with
real read/search/edit tools in disposable synthetic repositories. Offline mode
uses scripted Responses streams; those results validate the harness and tools,
not model quality.

The live experiment used the first-party OpenAI Responses endpoint, native HTTP,
Ultrafast, and low reasoning effort. Each sample started a fresh CLI process.
Both arms used the current runtime and mutation safeguards. The baseline used
the original tracked GPT prompt and ordinary read/grep tools; the candidate used
the revised prompt, read_many, and contextual grep. Baseline parallel calls were
left **omitted**, not artificially disabled. Candidate set the supported boolean
to true. There is no isolated causal attribution to any one change.

Baseline snapshot matches the tracked prompt blob:
`9068df4778dc1a88c143e3b4a872d20c3341390f`.

The child and its descendants could connect only to the local metering proxy.
Managed config was isolated, managed-preference reads denied, and dependencies
provided locally without npm downloads. The parent alone held provider credentials
and forwarded only synthetic requests to a fixed official endpoint.

Limits included a maximum of 384 output tokens per request, eight requests per
sample, a 90-second sample deadline, bounded input/response bytes, and pre-dispatch
spend reservations. A provider failure stops the run; fault injection verified
that a dropped upstream connection produces one forwarded attempt, not retry
multiplication. Output files are exclusive-create and contain no credentials or
raw private configuration.

## Live Results

One sample per arm and task. All six samples returned the correct answer, all
required evidence, the requested model, and the Ultrafast tier. There were no
missing observations, redundant reads, tool errors, dependency violations, or
protected-file changes.

| Task                                            | Model   | Baseline Time To Correct Answer | Candidate Time | Baseline / Candidate Model Requests | Observation                                                                                                                             |
| ----------------------------------------------- | ------- | ------------------------------: | -------------: | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Four known files                                | Sol 6.1 |                         4.805 s |        4.991 s | 2 / 2                               | Both retrieved four useful files in one tool round. Candidate used one bulk call rather than four individual calls, but was not faster. |
| Four known files                                | Astra   |                         4.457 s |        5.117 s | 2 / 2                               | Same useful read width; the bulk-call arm was slower in this sample.                                                                    |
| Discover a target and read its referenced files | Sol 6.1 |                         6.614 s |        5.258 s | 4 / 3                               | Contextual search avoided a separate source-file read, reducing one request and about 20.5% of observed time.                           |

The known-file baseline already generated four independent calls together. It
would be incorrect to present this as a gain from serial to parallel execution.
The candidate's additional schema and instructions also increased request input
size. Fewer tool-call envelopes alone did not guarantee lower elapsed time.

The discovery result supports the specific mechanism of removing unnecessary
round trips. One pair does not establish a repeatable 20.5% speedup. Provider
load, caching, generated arguments, and cold process startup remain factors.

No live test here measures WebSocket performance, a large 16-file workload,
automatic effort selection, or native eager dispatch in isolation. Their
correctness and capability checks must not be described as live speed gains.

Final hard-link and mixed-success instruction fixes were made after live capture
and verified offline. The live manifests retain hashes of the measured sources;
the safety fixes are not presented as additional measured latency improvements.

## Spend

The two live runs forwarded 15 requests. Conservative reservations totaled
**$18.46122**, below the supervising $20 estimated-spend ceiling. Reservations
used $60/M input and $300/M output for both models, counted UTF-8 request bytes
plus an allowance as the input-token ceiling, and reserved the entire output
limit before dispatch. They deliberately overestimate the observed token usage
and are not the invoice, measured actual spend, or the models' individual rate
cards. Cache discounts were not used to enlarge the budget. No more live runs
were started after this evaluation.

## Correctness Checks

- Complete native LLM suite: 366 passed, 28 skipped, zero failures.
- Final application integration and benchmark safety sweep: 414 passed, one existing
  TODO, zero failures across 19 files (permissions, prompts, native adapter,
  eager cancellation, read/search tools, file mutations, and benchmark guards).
- Full offline benchmark matrix: 16/16 samples passed, covering both models and
  both arms on known reads, discovery, dependent reads, and conflicting edits.
- Dedicated benchmark safety tests and independent reviews cover disconnects,
  cancellations, bounded spend, isolation, runtime attribution, and result
  accounting. Application and native-package typechecks passed.

Test counts from repeated focused runs overlap and must not be added as unique
coverage. Skipped native recorded/live cases are not evidence of live support.
One broader run hit an intermittent configured-Git-reference glob fixture
failure. All nine executions in its isolated three-repeat run passed, as did the
subsequent complete 414-test sweep. No unrelated fixture rewrite was included.

## Artifacts And Reproduction

See `packages/opencode/script/bench-parallel-tools.md` for options, caps, safety
requirements, and offline reproduction. Live calls require explicit authorization
and price ceilings; the benchmark defaults to offline.

Raw sanitized JSONL records and exact arm configuration remain under the local
temporary `opencode` directory:

- `parallel-tools-baseline-gpt.txt`
- `parallel-tools-arms.json`
- `parallel-tools-offline-smoke.jsonl`
- `parallel-tools-offline-matrix.jsonl`
- `parallel-tools-offline-verified.jsonl` (final source verification)
- `parallel-tools-live-known.jsonl`
- `parallel-tools-live-discovery.jsonl`

Each manifest records source and prompt hashes, requested runtime, model/tier,
limits, and ordering. No global config, installed executable, or running
interactive process was replaced. Workflow orchestration remains opt-in.
