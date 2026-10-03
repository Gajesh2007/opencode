# Harness Memory and Execution

These measurements use offline synthetic workloads and the actual implementation,
on macOS arm64 with Bun 1.3.14 and Effect 4.0.0-beta.66. They do not measure remote
model inference, internet latency, terminal paint time, or production tail latency.
Run benchmarks separately from builds and other tests to reduce scheduling noise.

## Results

For the follow-up investigation, see [Memory Retention](./memory-retention.md).
It reports JSC heap and external counters separately because they can overlap.
The historical native rows below used their summed counters as a comparison
score; those sums should not be interpreted as independent physical RAM bytes.

| Workload                                                        |                 Before |            After | Meaning                                                                    |
| --------------------------------------------------------------- | ---------------------: | ---------------: | -------------------------------------------------------------------------- |
| Native single-round streaming, 32 MiB response                  |              66.28 MiB |         0.73 MiB | Retained JSC heap plus external memory at text completion, after forced GC |
| Native caller-executed tools, same response                     |              66.29 MiB |         0.73 MiB | No unused assistant-history reconstruction                                 |
| First result from parallel 200 ms / 10 ms tools                 |              203.46 ms |         14.74 ms | Result visibility, not faster handlers; total remains about 205 ms         |
| Warm SQLite `SELECT 1`, median                                  |             0.15358 ms |       0.00244 ms | Runtime flags are resolved on database initialization, not every query     |
| Compacted history, 252 messages to 4 retained                   |             1.02387 ms |       0.24921 ms | Paired comparison with the same warm database implementation               |
| JSON decoded for that compacted-history read                    |        6,433,848 bytes |    402,954 bytes | Less hydration/allocation churn, not retained heap                         |
| Uncompacted history, 252 messages                               |             1.54072 ms |       1.15683 ms | Batched part hydration without a persistent history cache                  |
| Per-step diff summary, 252 messages with 128 KiB bodies         |                9.69 ms |          3.83 ms | Separate before/after runs, includes the warm database fix                 |
| JSON decoded for that diff summary                              |       33,112,227 bytes |        199 bytes | Snapshot metadata only; unrelated output never crosses into JS             |
| Stalled instance event subscriber, 10,000 distinct 4 KiB events | 10,000 events retained | 0 after overflow | A 1,024-event cap disconnects the slow client and releases its queue       |
| Stalled global event subscriber, same workload                  | 10,000 events retained | 0 after overflow | Same bounded lifecycle policy                                              |

The stalled-subscriber heap increases were approximately 48.6 MB and 48.4 MB
before, versus 90 KB and 33 KB after, respectively. These are synthetic JSC heap
observations, not process RSS guarantees. Queue capacity limits event count, not
the byte size of an individual event or bounded downstream batches.

The snapshot benchmark removed one Git subprocess per clean step and two per
dirty step. For 25 steps on a 1,000-file repository, median time decreased from
2,912 to 2,556 ms for clean steps and 6,438 to 4,991 ms for dirty steps. Scheduling
variance was substantial, so these 12% and 22% observations are not latency promises.

Truncating one million short lines now materializes only the preview's line strings.
Warm median time decreased from 13.28 to 11.14 ms in three-trial runs; sampled peak
RSS was approximately 336 versus 294 MiB. Shell RSS samples were too variable to
establish a memory reduction, so none is claimed. Its correctness regression now
saves all 16 MiB instead of silently losing trailing output after process exit.

## Changes

The optimization rule is to avoid constructing or retaining information that the
next consumer does not need, then shorten the paths that remain:

- Single-round native streams no longer accumulate a second assistant response.
- Concurrent tool results stream in completion order. Follow-up model messages
  remain in the original call order and wait for all tools to complete.
- SSE `[DONE]` terminates and releases held-open provider response bodies.
- Compaction boundaries are inspected before hydrating selected history parts.
- Diff summaries project snapshot boundaries instead of loading all message bodies.
- The queued-message retraction guard uses an indexed existence lookup.
- Warm database calls reuse initialization-time flags and the same client.
- Shell output is drained through process completion and file appends respect
  backpressure. Live metadata updates are coalesced while full output is preserved.
- File traversal uses a bounded producer queue and limited parallel file stats.
- Truncation scans newline boundaries without splitting every hidden line.
- Snapshot metadata paths are reused, but exclude rules are still read fresh.
- Slow SSE clients disconnect on overflow instead of silently losing deltas or
  backpressuring inference. Internal bus subscribers keep their delivery semantics.

Cancellation, partial UTF-8 output, unchanged history ordering, compaction replay,
fresh reads after updates/deletions, terminal framing, and subscription cleanup
have focused regression coverage.

## Reproduce

From `packages/llm`:

```sh
bun script/bench-runtime.ts single
bun script/bench-runtime.ts none
bun script/bench-runtime.ts tools
bun test test/tool-runtime.test.ts test/provider/openai-chat.test.ts --timeout 30000
```

See `packages/llm/script/bench-runtime.md` for the memory measurement definition,
control workload, and tunable response sizes.

From `packages/opencode`, isolate inherited provider configuration before testing:

```sh
env -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT -u OPENCODE_CONFIG_DIR -u OPENCODE_YOLO -u OPENCODE_YOLO_FOREVER -u OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS OPENCODE_BENCH_DATABASE=1 bun test test/storage/db.test.ts --timeout 30000
env -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT -u OPENCODE_CONFIG_DIR -u OPENCODE_YOLO -u OPENCODE_YOLO_FOREVER -u OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS OPENCODE_BENCH_SESSION_HISTORY=1 bun test test/session/message-history.test.ts --timeout 30000
env -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT -u OPENCODE_CONFIG_DIR -u OPENCODE_YOLO -u OPENCODE_YOLO_FOREVER -u OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS OPENCODE_BENCH_SESSION_SUMMARY=1 bun test test/session/summary.test.ts --timeout 30000
env -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT -u OPENCODE_CONFIG_DIR -u OPENCODE_YOLO -u OPENCODE_YOLO_FOREVER -u OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS BENCH_EXECUTION=1 bun test ./script/bench-execution.test.ts --timeout 120000
```

The history benchmark compares the unchanged public full-page stream with sparse
hydration in one process; both share the database improvement. Summary and database
before/after timings were captured separately. Heap inspection is outside timed
history loops. JSON byte counts describe parse volume and should not be confused
with RSS or total allocations.

## Limits

AI SDK remains the default LLM execution path. Native-specific savings require the
existing opt-in runtime; the database, history, summary, tool, snapshot, and SSE
changes also apply to the default harness. Follow-up-capable native tool loops
must retain assistant history, and collecting APIs intentionally retain events.

Provider HTTP error diagnostics still buffer the full error body before redaction
and truncation. Capping it safely requires separate partial-secret redaction tests;
truncating first can expose an incomplete secret that the current matcher misses.
No unverified change to that security boundary is included here.
