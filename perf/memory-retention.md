# Memory Retention Follow-Up

Baseline: `8186186de1456080cf597068f32785e45c2628e0`. Offline measurements on
macOS arm64, Bun 1.3.14, Effect 4.0.0-beta.66, and AI SDK 6.0.168. The running
opencode instance was not restarted, instrumented, or connected to a benchmark.
Workspace-installed SDK dependencies were left unchanged.

## Results

These are workload-specific retention measurements, not a percentage reduction
in the entire application's RAM. JSC `heapSize` and `extraMemorySize` can overlap;
they are reported separately and must not be added together as RAM saved.

| Workload                                                              | Baseline JSC Heap |    Final JSC Heap | Interpretation                                                                   |
| --------------------------------------------------------------------- | ----------------: | ----------------: | -------------------------------------------------------------------------------- |
| 48 completed jobs, independent 1 MiB outputs                          |         +51.00 MB | +0.90 to +1.94 MB | Approximately 96-98% less registry retention across the final runs               |
| 32 MiB raw MCP text, normalized result kept alive                     |        +32.33 MiB |         +0.57 MiB | Medians of three fresh processes per version, approximately 98% less retention   |
| TUI, 60 sessions x 120 messages, independent 8 KiB legacy/v2 payloads |   185.22 MB total |   122.24 MB total | Roughly 63 MB less fixture heap; unopened debug projections no longer accumulate |
| AI SDK, 4 MiB text in 65,536 deltas, result kept alive                |         +23.97 MB |         +12.95 MB | About 11 MB less replay-event retention; aggregate text is unchanged             |
| AI SDK, 16 MiB text in 16,384 deltas, result kept alive               |         +24.34 MB |         +21.53 MB | About 2.81 MB saved, not a 99% default-runtime reduction                         |

MB means decimal megabytes; MiB means 1,048,576 bytes. Job and MCP numbers are
post-GC growth over their warmed fixtures. TUI values include the mounted fixture,
whose matched excluded-project control retained approximately 64.42 MB of heap.
AI SDK values are growth over post-import, pre-request fixtures.

The jobs' separate extra-memory growth was 50.96 MB before versus 0.86 to 1.90 MB
after. MCP extra-memory medians were 32.20 versus 0.39 MiB. TUI extra memory was
157.06 versus 97.57 MB in the 60-session verification. SDK extra-memory retention
was effectively unchanged. These are separate counters, not additive savings.

Queued-agent probes retained 24 of 24 original `Tool.Context` wrappers before,
versus 0 of 24 after, while actual execution permits remained held. A separate
cold-start regression verifies 0 of 8 wrappers, without hiding initialization
retention behind a warmup. Queue heap/RSS includes substantial configuration,
filesystem, and runtime allocation, so no exact total-RAM saving is inferred
from the nominal 24 MiB of transcript payload alone.

RSS was noisy and did not consistently improve for jobs or MCP. The final TUI
verification observed peak RSS around 352 MB versus the original 396 MB, but its
control also reached about 320 MB through transient allocation. The SDK's sampled
peak improvements overlapped run-to-run noise. Forced GC does not guarantee that
allocator pages are returned to the OS.

## Changes

- Background jobs keep private, instance-lifetime receipts for terminal output
  and errors instead of keeping every payload and resolved completion handle in
  the registry. Repeated `get`, `list`, and `wait` remain readable. Metadata keeps
  its original non-JSON semantics. Storage failures fall back to memory.
- Same-ID replacement retires the superseded receipt under the readers' lock;
  completion is generation-safe. Disposal resolves outstanding waiters before
  cleaning receipt files. Receipts use mode 0600 and no TTL silently drops results.
- Internal cancellation and deletion request summary-only job lists, avoiding
  reloading every completed output merely to route cancellations. Public listing
  still returns full results by default.
- Queued subagents own execution descriptors, not full tool contexts. Inherited
  lazy diagnostic frames also held caller arguments; eager string-only snapshots
  retain diagnostic names, stack text, and span ancestry without those closures.
- MCP plugins still receive the original result, but the subsequent normalized
  output no longer retains `content: result.content`. Text artifacts, attachment
  conversion, metadata, and abort completion remain intact.
- V2 transcript state activates only for the opened debug session. Switching or
  closing the view releases it; revisiting reloads persisted messages. Legacy
  deletion handlers release associated parts and session data, and generation
  guards prevent deleted/switched views from being revived by stale requests.
- A maintained AI SDK patch exposes an opt-in, single-consumer `takeFullStream()`
  handoff. The application uses it when installed and otherwise retains its
  existing public-getter fallback. Other SDK consumers retain multireader/replay
  behavior. No private fields or globally patched stream methods are used.

## Measurement Method

Every before measurement preceded its implementation change. Job probes use real
services, temporary instance state, independent flattened strings, held permits,
event-loop turns, and repeated forced GC. WeakRefs test wrapper ownership only
after advancing task turns. Public status reads and scope disposal are asserted.
The file-backed results have the same instance lifetime as the former registry;
this is not cross-restart job durability.

The MCP fixture executes the actual `SessionTools.resolve` wrapper and real
truncation/file writing. Its mock transport generates payloads on invocation, not
in a fixture-owned retained array. Settled checkpoints advance an event-loop turn
before two full GCs, then observe the still-live normalized result. Saved output
size, plugin visibility, metadata, and attachments are checked. Earlier synchronous
checkpoints retained temporary I/O continuations and were discarded rather than
reported as permanent retention.

TUI probes mount both real providers and the SDK event path. Distinct JSON-parsed
strings prevent repeated-reference fixtures from understating payload retention.
An excluded-project run produces the same events without retaining their session
graphs. SDK batch fences, not guessed sleeps, establish processing completion.
The reported TUI savings specifically concern debug views that were never opened.

AI SDK probes run the loopback SSE server in a separate OS process, use the real
OpenAI provider and application event adapter, and drain rather than collect
events. The unchanged shared getter and maintained accessor load the same patched
module graph. Three runs per mode/size reverse order on the middle repetition.
The result is observed across forced-GC reachable checkpoints, then explicitly
released. Two of 24 release attempts did not collect within the observation window
and were excluded from released medians, not reported as successful cleanup.
An additional final high-event verification compared the live WeakRef target to
the result holder, observed an approximately 11.07 MB heap difference, and verified
collection in both modes. Detailed counters are in the SDK benchmark report.

## Reproduce

Run from `packages/opencode`, with inherited application configuration cleared
only in the benchmark subprocess. Run memory probes separately from other tests:

```sh
env -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT -u OPENCODE_CONFIG_DIR -u OPENCODE_YOLO -u OPENCODE_YOLO_FOREVER -u OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS OPENCODE_MEMORY_BENCH=1 OPENCODE_MEMORY_PHASE=jobs bun test test/agent/memory-retention.bench.test.ts --timeout 120000
env -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT -u OPENCODE_CONFIG_DIR -u OPENCODE_YOLO -u OPENCODE_YOLO_FOREVER -u OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS OPENCODE_MEMORY_BENCH=1 OPENCODE_MEMORY_PHASE=coldqueue bun test test/agent/memory-retention.bench.test.ts --timeout 120000
env -u OPENCODE_CONFIG -u OPENCODE_CONFIG_CONTENT -u OPENCODE_CONFIG_DIR -u OPENCODE_YOLO -u OPENCODE_YOLO_FOREVER -u OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS OPENCODE_BENCH_MCP_OUTPUT=1 bun test test/session/mcp-output-memory.test.ts --timeout 30000
bun run --conditions=browser test/cli/cmd/tui/transcript-memory.bench.ts retain 60 120 8192
bun run --conditions=browser test/cli/cmd/tui/transcript-memory.bench.ts control 60 120 8192
```

For SDK probes, see `packages/opencode/script/bench-ai-sdk-memory.md`. Candidate
mode requires the maintained patch, either through normal dependency installation
or the documented isolated `AI_SDK_MODULE` override. It does not silently benchmark
the old fallback as the candidate. The running process retains its installed code
until a normal updated start; no benchmark patched it in place.

## Remaining Limits

Legacy cross-session transcript accumulation and an opened debug session's own
timeline growth remain. A debug view opened mid-stream keeps the original single-
fetch, snapshot-wins behavior: partial deltas are not persisted by v2 projectors,
and final events restore authoritative content. A proposed event-sequence fence
was withdrawn because it could not truthfully represent those unmaterialized
deltas. No new polling loop, ambiguous delta replay, per-token database persistence,
or API/SDK schema change is included.

SDK aggregate recording and eager provider buffering remain; early iterator return
alone does not guarantee transport abort, so the application's existing scoped
AbortController remains responsible for cancellation. Consumers retaining returned
job results still own those payloads. Disk I/O adds work at job completion and
result retrieval; the change bounds registry retention, not every allocation in
the process tree. No single percentage here is a claim about whole-system RAM.
