// Offline only: each client and its loopback SSE fixture run in separate processes.
// Run: bun script/bench-ai-sdk-memory.ts [fullStream|takeFullStream] [chunks] [bytes]
import { heapStats } from "bun:jsc"
const mode = process.argv[2] ?? "fullStream"
const chunks = Number(process.argv[3] ?? 4096)
const bytes = Number(process.argv[4] ?? 1024)

if (mode === "server") {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      let index = 0
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (index > chunks) {
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
              controller.close()
              return
            }
            const i = index++
            const content = Array.from({ length: bytes }, (_, j) =>
              String.fromCharCode(33 + (((Math.imul(i + 1, 2654435761) >>> j % 24) + j * 17) % 90)),
            ).join("")
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({
                  id: "chatcmpl-memory",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "offline",
                  choices: [
                    { index: 0, delta: i < chunks ? { content } : {}, finish_reason: i === chunks ? "stop" : null },
                  ],
                  ...(i === chunks
                    ? { usage: { prompt_tokens: 1, completion_tokens: chunks, total_tokens: chunks + 1 } }
                    : {}),
                })}\n\n`,
              ),
            )
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  console.log(server.url.href)
} else {
  const result = await run()
  for (let i = 0; i < 10; i++) {
    Bun.gc(true)
    await Bun.sleep(20)
  }
  console.log(
    JSON.stringify({
      released: memory(),
      resultCollected: result.deref() === undefined,
      maxRSS: process.resourceUsage().maxRSS,
    }),
  )
}

function memory() {
  const jsc = heapStats()
  return { ...process.memoryUsage(), jscHeapSize: jsc.heapSize, jscExtraMemorySize: jsc.extraMemorySize }
}

async function run() {
  const { streamText, wrapLanguageModel } = (await import(process.env.AI_SDK_MODULE ?? "ai")) as typeof import("ai")
  const { createOpenAI } = await import("@ai-sdk/openai")
  const { Effect, Stream } = await import("effect")
  const { LLMAISDK } = await import("../src/session/llm/ai-sdk")
  const server = Bun.spawn([process.execPath, import.meta.path, "server", String(chunks), String(bytes)], {
    stdout: "pipe",
    stderr: "inherit",
  })
  try {
    const reader = server.stdout.getReader()
    const ready = await reader.read()
    reader.releaseLock()
    const baseURL = new TextDecoder().decode(ready.value).trim()
    const gc = async () => {
      for (let i = 0; i < 3; i++) {
        Bun.gc(true)
        await Bun.sleep(20)
      }
      return memory()
    }
    const baseline = await gc()
    const peak = { rss: baseline.rss, heapUsed: baseline.heapUsed, external: baseline.external }
    const sample = () => {
      const usage = process.memoryUsage()
      peak.rss = Math.max(peak.rss, usage.rss)
      peak.heapUsed = Math.max(peak.heapUsed, usage.heapUsed)
      peak.external = Math.max(peak.external, usage.external)
    }
    const timer = setInterval(sample, 5)
    const holder: { result?: ReturnType<typeof streamText> } = {
      result: streamText({
        model: wrapLanguageModel({
          model: createOpenAI({ apiKey: "offline-only", baseURL }).chat("offline"),
          middleware: { specificationVersion: "v3", transformParams: async (args) => args.params },
        }),
        messages: [{ role: "user", content: "fixed offline request" }],
        maxRetries: 0,
      }),
    }
    let events = 0
    let textBytes = 0
    const checkpoints: { events: number; usage: ReturnType<typeof memory> }[] = []
    const state = LLMAISDK.adapterState()
    let result = holder.result
    if (!result) throw new Error("missing result")
    if (mode !== "fullStream" && mode !== "takeFullStream") throw new Error("invalid mode")
    if (mode === "takeFullStream" && typeof Reflect.get(result, mode) !== "function")
      throw new Error("SDK patch missing")
    let source: ReturnType<typeof streamText>["fullStream"] | undefined =
      mode === "fullStream" ? result.fullStream : LLMAISDK.fullStream(result)
    const weak = new WeakRef(result)
    await Effect.runPromise(
      Stream.fromAsyncIterable(source, (error) => error).pipe(
        Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
        Stream.flattenIterable,
        Stream.runForEach((event) =>
          Effect.promise(async () => {
            events++
            if (event.type === "text-delta") textBytes += event.text.length
            if (events % 128 === 0) sample()
            if (events === Math.floor(chunks / 2)) checkpoints.push({ events, usage: await gc() })
          }),
        ),
      ),
    )
    sample()
    clearInterval(timer)
    const reachable = await gc()
    // Keep the SDK result genuinely observable across the reachable checkpoint.
    const reachableIdentity = weak.deref() === holder.result && holder.result === result
    holder.result = undefined
    // Clear async-frame roots as well as returning from the measurement function.
    result = undefined
    source = undefined
    globalThis.console.log(
      JSON.stringify({
        mode,
        chunks,
        bytes,
        events,
        textBytes,
        reachableIdentity,
        baseline,
        peak,
        checkpoints,
        reachable,
      }),
    )
    return weak
  } finally {
    server.kill()
    await server.exited
  }
}
