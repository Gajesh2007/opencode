# P1 Implementation and Folder Search

Local working-tree checkpoint on October 8, 2026. This supersedes the remaining
P1 recommendations in the earlier reports, not their historical measurements.
No global executable, provider selection, credentials, or network settings were
changed. Existing worktree changes were preserved.

## Completed Work

| Priority                   | Implementation                                                                                                                                                                                             | Verification                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Accurate timing            | Tool metadata updates preserve the original start. Monotonic records correlate preparation, request preparation, first useful output, local tool execution, request lifetime, and assistant-step lifetime. | Timestamp-update, wall-clock, retry, cancellation, and real tool regressions.                                                      |
| Consistent pruning         | Omitted `compaction` or `prune` enables pruning; explicit `false` disables it.                                                                                                                             | Persisted-history matrix, recent output and skill protection, and newly appended history.                                          |
| Real agent-task benchmarks | Disposable small-fix, investigation, tool-chain, and multi-file integration tasks execute the actual CLI and check behavior independently.                                                                 | All four passed with the compiled binary; negative control retains its failed sample.                                              |
| Auxiliary failure safety   | Reviewer/steering failures become unavailable, not approval. Interruption remains terminal. Responses are bounded to 8,192 characters and 30 seconds.                                                      | Error, defect, malformed, empty, truncated, timeout, and cancellation cases.                                                       |
| Truthful workflow outcomes | Clean empty findings differ from malformed/empty execution; partial results and incomplete coverage survive synthesis. Truncated finishes and parent cancellation during synthesis cannot become success.  | Workflow, parser, child-result, synthesis, and explicit opt-in regressions.                                                        |
| Goal/task accounting       | Separate durable execution records count all recorded steps and descendants without copying fork history. Goal creation/replacement and terminal membership have explicit boundaries.                      | Active totals, duplicate idle events, deleted children, late finishes, unknown pricing, and persisted interruption-state recovery. |

Timing names are intentionally limited: `dispatch` ends at the existing prepared
request callback, not physical socket transmission. `overall` is one assistant
processor step; the benchmark separately measures CLI launch through exit.
Concurrent tool durations overlap. Queueing, rendering, approval wait, review,
compaction, and provider-internal retries do not each have a separate timer.

## Opt-In Defaults

Both capabilities are disabled unless their dedicated environment flag is true:

```sh
OPENCODE_EXPERIMENTAL_WORKFLOW=true
OPENCODE_EXPERIMENTAL_METAAGENT=true
```

The umbrella experimental flag does not enable them. Disabled capabilities are
absent from tool/command exposure and reject direct execution. Persisted enabled
meta-agent settings do not inject their lens or run reviews while the gate is
off. Goal continuation remains a separate capability and retains safe steering.

## Folder-Wide Chat Search

Open `/sessions` and type a query. The default searches titles, summary titles,
and user/assistant text in both persisted message formats, including archived
and child sessions. It searches the exact current folder, project, and workspace,
not just the recent chats loaded into the UI. Tool bodies, reasoning, and
attachments are excluded.

- `Tab`: switch between title-and-content search and title-only search.
- `Ctrl+O`: load more matches when available.
- `Ctrl+L`: retry a failed search; `Ctrl+R` remains the existing rename shortcut.

Results include bounded snippets. Obsolete requests are cancelled and stale
responses ignored. Immutable session-ID cursors prevent chat updates, archival,
or deletion from shifting unread matches across an offset boundary. Newly
created chats before the cursor are found by refreshing the search.

SDK/API additions:

- `session.search`: `GET /session/search`, with query, mode, limit, and cursor.
- `session.usage`: `GET /session/:sessionID/usage`, for recorded subtree usage.
- Goal metadata also exposes whole-task recorded usage and coverage information.

Search uses SQLite substring queries, not a full-text index. No destructive
history rewrite or transcript migration is required for search.

## Accounting Boundaries

The ledger starts with newly recorded executions; historical transcript copies
are not an authoritative billing ledger and are not backfilled. Known finishes
remain counted after cancellation or child deletion. Unfinished requests remain
unknown, not known zero-cost work. Central LLM tracking includes small/title and
auxiliary calls; paid context warming is tracked separately, while connection-only
warming does not create a model-usage entry.

Catalog estimates, provider-reported costs, unknown prices, and unverified premium
tier prices remain distinct. Missing prices are not treated as explicitly free
models. Invalid reported gateway prices are rejected. External-tool charges and
hidden provider retries are not represented as fully known billing. Budget checks
are therefore not an invoice or a guaranteed global spending cap.

Pending goal continuations use a renewable 30-second lease and a persisted
continuation record. A 10-second heartbeat preserves live ownership; a 10-second
recovery scan resumes expired claims without duplicating the synthetic message.
Tests cover persisted interruption states after claim, preparation, message, and
part creation. These are deterministic recovery fixtures, not a production
process-kill experiment or an exactly-once guarantee for external side effects.

Two generated database migrations add execution accounting and recoverable goal
turns. They are included in the local build and apply on the normal updated start.

## Verification

- 325 integrated application tests passed across 17 files for pruning, timing,
  workflow outcomes, auxiliary safety, opt-in defaults, search, and SDK routes.
- 130 additional application tests passed across eight files for accounting,
  goal interruption/recovery, LLM/warming, Bedrock wiring, and migrations.
- 191 additional application tests passed across three files for provider
  pricing, prompt behavior, and session HTTP routes: 646 across 28 files total.
- Complete native package suite: 305 passed, 28 intentionally skipped.
- Application and native package typechecks passed; SDK regenerated successfully.
- Independent review's five findings were repaired and rechecked: incomplete
  workflow finishes, synthesis cancellation, interrupted goal claims, missing
  pricing, and mutable-offset search pagination.
- Compiled CLI completed all four offline task benchmarks with objective
  acceptance checks. These scripted-model runs validate harness behavior, not
  model quality, live inference speed, or a before/after performance improvement.
- Manual compiled-TUI check found a message-only `RangeError` match, then zero
  matches in title-only mode. The disposable terminal session was closed.

The unfiltered application suite was attempted but timed out after 600 seconds;
it is **not claimed passing**. Its failure triage identified permission-test
environment contamination, integration fixtures and an obsolete empty migration
directory (repaired), plus older task-schema snapshot and Codex recording
mismatches. Focused checks use isolated configuration and permission flags.
Historical recordings were not silently rewritten to hide a mismatch.

## Build and Reproduction

Local macOS arm64 build: `1.18.34-p1.20261008.4`.

```sh
packages/opencode/dist/opencode-darwin-arm64/bin/opencode
```

Restart with this executable to adopt the changes. The running process does not
hot-reload them. The build includes TUI support and omits embedded web UI.

From `packages/opencode`, the offline benchmark is:

```sh
bun run script/bench-agent-tasks.ts --binary /absolute/path/to/opencode
```

The final compiled benchmark artifacts are in the approved local temporary
directory under `opencode/agent-bench-L30Rpw`. Each task retains its workspace,
acceptance output, invocation identity, usage records, and phase measurements.
See `script/bench-agent-tasks.md` for explicit billable live-mode controls.
