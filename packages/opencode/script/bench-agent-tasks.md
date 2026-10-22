# Small Agent Task Benchmark

Run from `packages/opencode`. The default is offline: a loopback OpenAI-compatible
fixture scripts model responses, while the **actual source CLI** executes read,
apply_patch, and bash tools in fresh disposable Git repositories. This checks the
harness, not model intelligence or inference performance. No live calls happen
unless `--mode live` is explicitly supplied.

```sh
bun run script/bench-agent-tasks.ts
bun run script/bench-agent-tasks.ts --only integration
# Negative control: must exit 1 and retain the failed sample.
bun run script/bench-agent-tasks.ts --only small-fix --fixture-failure
# Same four offline cases against a compiled CLI instead of the source entry:
bun run script/bench-agent-tasks.ts --binary /absolute/path/to/opencode
```

`--binary` must name an existing absolute file path. Without it, execution still
uses the source CLI. Each sample's `invocation.json` records the actual command,
including the selected executable. Bun remains required for the fixture tests.

Tasks: boundary/validation bug fix; source investigation without modifying the
source; JSONL aggregation through tools; parser/CLI integration with actual child
process acceptance tests. Fixtures specify exact outputs and edge cases. Every
case has independent tests, checks protected source/test files, checks phase
coverage and CLI error events, and requires exit zero. An acknowledgement or a
successful tool wrapper is never sufficient to pass.

`results.json` is updated after every task. Each uniquely named sample retains
working files, stdout events, stderr with timing records, acceptance output,
invocation (without config/auth), and its result, including all failed samples.
`durationMs` is monotonic CLI spawn-to-exit elapsed time, **not** the sum of tool
durations. Acceptance verification runs afterwards and is excluded from that
duration. Report all samples and acceptance rate before comparing accepted-task
latency; do not silently discard failure time. `usage` retains CLI step-finish
data; fixture token/cost values are synthetic and not billing measurements.

## Live Opt-In

Live mode incurs provider charges. Supply a dedicated JSON provider config with
credentials in its provider options, or a separate auth JSON file in the normal
OpenCode auth format. Neither inherited credentials nor project/global configs
are loaded. Config/auth content is not copied into result metadata, but provider
logs and model-created files should still be treated as private artifacts.

```sh
bun run script/bench-agent-tasks.ts --mode live \
  --model provider/exact-model --config /absolute/path/benchmark-config.json \
  --auth /absolute/path/benchmark-auth.json --timeout 120000
```

Use `--only small-fix` for a bounded smoke test, `--output /existing/output/path`
to select the artifact parent. Samples never overwrite previous samples. There
is a ten-step build-agent cap and a per-task wall deadline, but neither is a hard
token/dollar budget. Run serially without competing benchmarks. Repeat matched
model/effort/tier configurations and preserve every sample before interpreting
latency. Built-in read/edit/bash are permitted and delegation/network tools are
denied; **this is not an OS sandbox**. Bash can access the host/network, so run
untrusted live models in an external sandbox if that boundary is required.

## Phase Semantics

Normal logs contain `service=session.timing timing={...} phase`; JSON records
contain only IDs, tool names, statuses, and monotonic milliseconds, never prompt,
arguments, or tool output. `stepID` is the assistant message ID, and `requestID`
is `stepID:attempt` for processor-level stream attempts. These are local
correlation IDs, not provider request IDs.

| Phase        | Duration boundary                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| preparation  | Caller starts assistant-step preparation through immediately before processing; includes snapshot and tool resolution where caller supplies the timer.  |
| dispatch     | Start of processor stream attempt through existing LLM `onRequest` callback after request preparation. This is **not** actual socket-send time.         |
| first_useful | Dispatch callback through first non-whitespace text delta or complete tool-call event observed by the processor. Reasoning and empty text are excluded. |
| tool         | Actual local tool execute entry through exit, including plugin hooks, permissions, MCP normalization and failures. Concurrent durations overlap.        |
| request      | Processor attempt start through next retry or final cleanup; retry backoff can be included.                                                             |
| overall      | One assistant processor step through cleanup, **not the entire user task**. CLI elapsed covers the entire benchmark task.                               |

`elapsedMs` is relative to that assistant-step start. Persisted tool start/end
remain wall-clock timestamps for UI compatibility; repeated metadata preserves
the original start. The new local durations remain accurate across wall-clock
adjustments, but historical/copied tool timestamps cannot be repaired.

There is no separate queue, approval-wait, rendering, reviewer, compaction, or
provider-internal retry duration in this instrumentation. Permission wait is
included in tools; cleanup is included in request/overall. Provider/SDK internal
retries are not separate processor request IDs. Do not add overlapping phases
or compare fixture latency with live inference as an optimization result.
