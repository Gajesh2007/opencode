# Default AI SDK Streaming Memory

Baseline: clean `8186186de1456080cf597068f32785e45c2628e0`, Bun 1.3.14,
macOS arm64, installed `ai@6.0.168` and `@ai-sdk/openai@3.0.53`.
No running opencode process or its installed dependencies were changed.

## Change And Contract

The maintained `patches/ai@6.0.168.patch` adds the public, opt-in
`StreamTextResult.takeFullStream()` method. It transfers the original stream,
instead of using `teeStream()` and retaining an unread branch. It is one-shot,
must precede other stream/auto-consuming getter access, and rejects later stream
access. Existing getters retain their original multireader/replay behavior.
Source, ESM, CJS, and both declaration formats carry the same contract.

The default LLM calls `LLMAISDK.fullStream(result)`, which takes the stream when
the maintained accessor exists and otherwise uses the existing public getter.
The fallback accommodates an already-installed, unpatched SDK: the patch becomes
active at the next normal dependency installation/process start controlled by
the operator. No private fields, global stream patches, second drain, or native
runtime substitution are involved.

Aggregate recording is deliberately unchanged. In the audited SDK source:

- `stream-text.ts:2264-2275,2295` retains the unused tee branch for `fullStream`.
- `:823,830,907,956,999,1041` retains content, steps, text, reasoning, tool output,
  and response history. These support tool execution, multistep continuation,
  stop conditions, callbacks, telemetry, and public aggregate promises.
- `:1198-1232` and `run-tools-transformation.ts:421-438` already pump provider IO
  eagerly. This patch does not make provider/network buffering bounded.
- `stream-text.ts:1242-1243` calls cancel on the locked stitchable stream. An early
  return closes the returned iterator, but that alone is not a reliable provider
  transport abort. The application's existing scoped AbortController remains
  responsible for aborting requests. This patch does not repair that SDK issue.

After an exclusive take, aggregate getters and `consumeStream()` do not create
additional consumers. Aggregates still resolve when the owner drains the stream;
awaiting them without draining can wait indefinitely. The opencode path does not
read these aggregates. Their contents/callback semantics remain intact.

## Method

`bench-ai-sdk-memory.ts` starts an ephemeral loopback SSE server in a separate
OS process and uses the real OpenAI chat provider, `wrapLanguageModel`,
`streamText`, the actual `LLMAISDK` adapter, and Effect `Stream.runForEach`.
Neither raw chunks nor normalized output are collected in the benchmark.
Each SSE delta contains deterministic varying ASCII data, flattened through
actual JSON encoding/parsing, rather than repeated shared string references.
The request has fixed messages, zero retries, and an offline-only dummy key.

The first measurements used the original installed SDK before a candidate was
created. For example, 4 MiB / 4,096 deltas retained +8,593,793 `heapUsed` bytes
and +6,515,777 external bytes with the result reachable after forced GC.
At 4 MiB / 16,384 deltas these were +11,704,717 / +6,581,629 bytes.
At 16 MiB / 16,384 deltas they were +24,261,529 / +19,137,689 bytes.
These are separate counters, not additive physical RAM estimates.

The final paired results below use a clean temporary installation of the
maintained root patch. The old `fullStream` getter is the control and preserves
the original implementation; `takeFullStream` is the candidate, through the
actual application helper. Both modes therefore load the identical SDK module
graph. Three fresh client/server process pairs per mode/size were run
sequentially; order was reversed on the middle repetition.

Measurements are relative to a post-import, pre-request forced-GC baseline.
Midpoint and reachable-completion checkpoints run three synchronous full GCs,
with 20 ms event-loop turns between them. The result is kept strongly reachable
and identity-checked after the completion checkpoint. There are no aggregate
getter accesses in the benchmark: those would themselves auto-consume a tee.
Result/source roots are then cleared, the measurement function returns, and ten
additional full GCs run. A WeakRef confirms actual result collection.

Peaks are sampled every 5 ms and every 128 normalized events, plus completion.
They are sampled peaks, not an exhaustive allocation trace. `maxRSS` is also
emitted. JSC `heapSize` and `extraMemorySize` are reported separately alongside
RSS and process counters. They can overlap and must never be summed as RAM saved.

## Results

All values in these tables are decimal MB, medians of three runs, relative to
each process's own baseline. All runs produced exactly payload-delta-count + 5
normalized events and exactly the requested text bytes.

Reachable result, post-GC:

| Payload / Deltas / Bytes Per Delta | Shared JSC Heap | Taken JSC Heap | Heap Reduction | Shared JSC Extra | Taken JSC Extra |
| ---------------------------------- | --------------: | -------------: | -------------: | ---------------: | --------------: |
| 4 MiB / 4,096 / 1,024              |           8.637 |          7.906 |          0.730 |            6.551 |           6.521 |
| 4 MiB / 16,384 / 256               |          11.744 |          8.942 |          2.803 |            6.613 |           6.575 |
| 4 MiB / 65,536 / 64                |          23.966 |         12.952 |         11.014 |            6.647 |           6.647 |
| 16 MiB / 16,384 / 1,024            |          24.337 |         21.529 |          2.808 |           19.202 |          19.159 |

The exact median-difference heap reductions are 730,436; 2,802,504; 11,014,070;
and 2,807,784 bytes respectively. The gain scales with event count, about
168-178 bytes per delta in this fixture, not primarily with response bytes.
External/extra retention is effectively unchanged: aggregate strings still live.
This is not a 99% default-path reduction.

Midpoint forced-GC heap, shared -> taken: 8.363 -> 8.043 MB;
10.845 -> 9.684 MB; 20.442 -> 15.939 MB; 23.446 -> 22.280 MB.

Sampled peaks:

| Payload / Deltas | Shared RSS | Taken RSS | Shared Heap | Taken Heap | Shared Extra | Taken Extra |
| ---------------- | ---------: | --------: | ----------: | ---------: | -----------: | ----------: |
| 4 MiB / 4,096    |    112.542 |   110.395 |       9.588 |      9.480 |        8.497 |       8.595 |
| 4 MiB / 16,384   |    151.110 |   148.832 |      17.389 |     16.278 |       13.455 |      13.250 |
| 4 MiB / 65,536   |    238.305 |   226.591 |      40.558 |     36.979 |       26.796 |      26.566 |
| 16 MiB / 16,384  |    225.001 |   216.236 |      30.820 |     30.116 |       27.238 |      27.440 |

Peak RSS is noisy. In the 65,536-delta case, shared RSS increases were
236.257-240.632 MB; taken increases were 225.198-251.937 MB. One taken run was
worse than all shared runs. The median improvement is not a guaranteed physical
RAM or peak-RSS saving. RSS also stays high after collection because GC does not
necessarily return allocator pages to the OS.

Release controls: all 12 shared results and 10 of 12 taken results were verified
collected at the release checkpoint. Two taken results were still reachable
after the 200 ms / ten-GC release attempt; those checkpoints are explicitly
marked `resultCollected:false` and excluded from released medians. The benchmark
does not establish their retaining root or guarantee immediate SDK collection.

| Payload / Deltas | Shared Released Heap / Extra | Taken Released Heap / Extra | Verified Shared / Taken |
| ---------------- | ---------------------------: | --------------------------: | ----------------------: |
| 4 MiB / 4,096    |                3.143 / 2.078 |               3.117 / 2.057 |                   3 / 3 |
| 4 MiB / 16,384   |                3.208 / 2.143 |               3.153 / 2.093 |                   3 / 2 |
| 4 MiB / 65,536   |                3.238 / 2.171 |               3.256 / 2.197 |                   3 / 2 |
| 16 MiB / 16,384  |                3.218 / 2.151 |               3.179 / 2.119 |                   3 / 3 |

After verified result collection, neither mode shows meaningful additional
response-size/event-count retention. The residual roughly 3.2 MB heap / 2.1 MB
extra reflects warmed runtime/provider work relative to the cold import baseline,
not proof that all request-related allocations have individually been traced.

## Reproduction And Checks

From `packages/opencode`, after a normal patched dependency installation:

```sh
bun script/bench-ai-sdk-memory.ts fullStream 4096 1024
bun script/bench-ai-sdk-memory.ts takeFullStream 4096 1024
```

Repeat both modes three times for `(4096,1024)`, `(16384,256)`, `(65536,64)`, and
`(16384,1024)`, sequentially, without concurrent tests/profiling. Compare per-run
baseline deltas and report only confirmed-collected released controls.
`AI_SDK_MODULE=/absolute/path/to/isolated/ai/dist/index.mjs` selects an isolated
SDK without modifying the workspace install. Candidate mode explicitly fails
if the patch is absent, instead of silently benchmarking the fallback.

The SDK contract suite capability-probes and drains an offline result. Only the
five exclusive-accessor tests are skipped on a deliberately unpatched install;
application fallback, aggregate, multireader, and actual-provider cases still run.
A patched install must run every case. Tests cover guarded ownership, aggregates,
callbacks, provider metadata, transformed-stream backpressure, early return,
AbortSignal, real OpenAI and OpenRouter loopback auth/headers, middleware, tools,
tool output metadata, lowercase repair, and invalid-tool repair.

The final focused patched package regression run passed 413 tests (including ten
new SDK cases) with no skips. The intentionally untouched installed SDK passed
the five applicable new cases and capability-skipped only the five exclusive
accessor cases. ESM and CJS are verified independently.
Direct `bun typecheck` and typechecking against the isolated patched declarations
both passed. Temporary installs used the workspace's Zod 4.1.8 peer version.
An inherited `OPENCODE_CONFIG` caused three provider tests to fail identically
with both the old and patched SDK; clearing it only in test subprocesses resolved
all three. The user's running environment was not altered.

Root lock regeneration was performed with `bun install --lockfile-only`; its
unrelated advance of the moving `ghostty-web#main` dependency was removed.
Root frozen-lock verification consequently still encounters that moving-branch
resolution issue. The maintained AI patch itself applies on a clean isolated
install and passes frozen-lock installation there; no workspace `node_modules`
install was performed.
