# Tool Runtime Retention and Latency

Run from `packages/llm`, with each case in a fresh process:

```sh
bun script/bench-runtime.ts plain
bun script/bench-runtime.ts single
bun script/bench-runtime.ts none
bun script/bench-runtime.ts loop
bun script/bench-runtime.ts tools
```

`CHUNKS` (default 32768) and `CHUNK_BYTES` (default 1024) control the text workload. The source generates unique, flattened strings one chunk at a time and the consumer drains events rather than collecting them. A 256-chunk warmup precedes measurement. Retained memory is the increase in JavaScriptCore `heapSize + extraMemorySize` after two forced GCs at `text-end`, while the runtime's current-step state is still live. This is not RSS or total allocation volume.

Measured locally on macOS arm64, Bun 1.3.14, Effect 4.0.0-beta.66:

| Workload | Before | After |
| --- | ---: | ---: |
| Plain stream, 32 MiB text, retained memory (control) | 0.53 MiB | Unchanged implementation |
| Single-round tool runtime, 32 MiB text, retained memory | 66.28 MiB | 0.73 MiB |
| Caller-executed tools (`none`), 32 MiB text, retained memory | 66.29 MiB | 0.73 MiB |
| First result, parallel 200 ms and 10 ms tools | 203.46 ms | 14.74 ms |

The single-round and caller-executed paths no longer build assistant history that can never be used. Follow-up-capable (`loop`) runs intentionally retain their current response to construct the next request. Synchronous event indexing and accumulation no longer allocate an Effect per delta.

Tool results now stream in completion order through Effect's backpressured concurrent mapper. Follow-up history remains in the original call order; the model cannot resume until all tools finish. Total tool execution time remains about 205 ms for this workload, so the latency improvement is time to the first usable result, not faster handlers.

Timing is illustrative and subject to scheduling/JIT/GC noise; no remote model or network time is included. Memory results are synthetic, and consumers using `generate` or `runCollect` still intentionally retain all emitted events. The benchmark should be rerun on the target runtime/workload before extrapolating.

Regression tests also exercise a never-completing sibling tool, cancellation on early consumer exit, inherited sequential concurrency, and SSE `[DONE]` termination of a held-open HTTP response body. The sibling and SSE tests timed out at one second before the fixes; they now complete and verify resource cleanup. Frames after `[DONE]` are not decoded.
