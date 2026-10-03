import { Effect, Stream } from "effect"
import { heapStats } from "bun:jsc"
import { LLM, LLMEvent } from "../src"
import * as OpenAI from "../src/providers/openai"
import { tool } from "../src/tool"
import { ToolRuntime } from "../src/tool-runtime"

// Run each case in a fresh process: bun script/bench-runtime.ts plain|single|none|loop|tools
const mode = process.argv[2] ?? "single"
const count = Number(process.env.CHUNKS ?? 32768)
const size = Number(process.env.CHUNK_BYTES ?? 1024)
const request = LLM.request({ model: OpenAI.configure({ apiKey: "test" }).chat("test"), prompt: "test" })
const tools = {
  wait: tool({
    description: "Wait for a given duration.",
    jsonSchema: { type: "object" },
    execute: (input) => Effect.sleep(Number(input)).pipe(Effect.as("done")),
  }),
}

const text = (chunks: number) =>
  Stream.range(0, chunks - 1, 1).pipe(
    Stream.map((index) =>
      LLMEvent.textDelta({
        id: "text",
        // Flatten each unique chunk so retained memory includes its payload, not shared padding.
        text: `${index.toString(36).padStart(8, "0")}${"x".repeat(size - 8)}`.toUpperCase(),
      }),
    ),
  )

await Effect.runPromise(text(256).pipe(Stream.runDrain))
Bun.gc(true)
Bun.gc(true)
const baseline = heapStats()
const before = baseline.heapSize + baseline.extraMemorySize
const start = performance.now()
let retained = before
let firstResult: number | undefined
let results = 0

const source =
  mode === "tools"
    ? Stream.fromIterable([
        LLMEvent.toolCall({ id: "slow", name: "wait", input: 200 }),
        LLMEvent.toolCall({ id: "fast", name: "wait", input: 10 }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])
    : text(count).pipe(Stream.concat(Stream.make(LLMEvent.textEnd({ id: "text" }), LLMEvent.finish({ reason: "stop" }))))

const stream =
  mode === "plain"
    ? source
    : ToolRuntime.stream({
        request,
        tools,
        ...(mode === "none" ? { toolExecution: "none" as const } : {}),
        ...(mode === "loop" ? { stopWhen: ToolRuntime.stepCountIs(2) } : {}),
        stream: () => source,
      })

await Effect.runPromise(
  stream.pipe(
    Stream.tap((event) =>
      Effect.sync(() => {
        if (event.type === "text-end") {
          Bun.gc(true)
          Bun.gc(true)
          const heap = heapStats()
          retained = heap.heapSize + heap.extraMemorySize
        }
        if (event.type !== "tool-result") return
        firstResult ??= performance.now() - start
        results++
      }),
    ),
    Stream.runDrain,
  ),
)
console.log(
  JSON.stringify({
    mode,
    chunks: mode === "tools" ? undefined : count,
    payloadMiB: mode === "tools" ? undefined : (count * size) / 1024 ** 2,
    elapsedMs: Math.round((performance.now() - start) * 100) / 100,
    retainedMiB: Math.round(((retained - before) / 1024 ** 2) * 100) / 100,
    firstResultMs: firstResult === undefined ? undefined : Math.round(firstResult * 100) / 100,
    results: mode === "tools" ? results : undefined,
  }),
)
