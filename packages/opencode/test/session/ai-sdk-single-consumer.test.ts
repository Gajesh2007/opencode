import { describe, expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import {
  streamText,
  tool,
  wrapLanguageModel,
  type AsyncIterableStream,
  type Output,
  type TextStreamPart,
  type ToolSet,
} from "ai"
import { Effect, Stream } from "effect"
import z from "zod"
import { LLMAISDK } from "../../src/session/llm/ai-sdk"

// Mirrors the pinned patch's public declaration while an existing install is untouched.
declare module "ai" {
  interface StreamTextResult<TOOLS extends ToolSet, OUTPUT extends Output.Output> {
    takeFullStream(): AsyncIterableStream<TextStreamPart<TOOLS>>
  }
}

const usage = {
  inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
}

function provider(count = 64) {
  const state = { pulled: 0, cancelled: false }
  const finished = Promise.withResolvers<void>()
  const model: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "offline",
    modelId: "offline",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("stream only")
    },
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        pull(controller) {
          const i = state.pulled++
          if (i === 0) return controller.enqueue({ type: "stream-start", warnings: [] })
          if (i === 1)
            return controller.enqueue({
              type: "text-start",
              id: "text",
              providerMetadata: { offline: { start: true } },
            })
          if (i < count + 2)
            return controller.enqueue({
              type: "text-delta",
              id: "text",
              delta: String(i),
              providerMetadata: { offline: { index: i } },
            })
          if (i === count + 2) return controller.enqueue({ type: "text-end", id: "text" })
          controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage })
          controller.close()
          finished.resolve()
        },
        cancel() {
          state.cancelled = true
          finished.resolve()
        },
      }),
    }),
  }
  return { model, state, finished: finished.promise }
}

async function drain(result: Pick<ReturnType<typeof streamText>, "fullStream">) {
  const state = LLMAISDK.adapterState()
  const events: string[] = []
  await Effect.runPromise(
    Stream.fromAsyncIterable(LLMAISDK.fullStream(result), (error) => error).pipe(
      Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
      Stream.flattenIterable,
      Stream.runForEach((event) => Effect.sync(() => events.push(event.type))),
    ),
  )
  return events
}

const patched = await (async () => {
  const result = streamText({ model: provider(1).model, prompt: "offline capability probe" })
  const available = typeof result.takeFullStream === "function"
  await drain(result)
  return available
})()
const single = patched ? test : test.skip

describe("AI SDK single-consumer public contract", () => {
  test("app seam supports a public result without the optional accessor", async () => {
    const result = streamText({ model: provider(4).model, prompt: "offline" })
    let accessed = 0
    const stream = LLMAISDK.fullStream({
      get fullStream() {
        accessed++
        return result.fullStream
      },
    })
    let text = ""
    for await (const event of stream) {
      if (event.type === "text-delta") text += event.text
    }
    expect(accessed).toBe(1)
    expect(text).toBe("2345")
  })

  test("app seam drains metadata and leaves aggregate promises intact", async () => {
    const source = provider(4)
    let finished = false
    const result = streamText({
      model: source.model,
      prompt: "offline",
      onFinish: () => {
        finished = true
      },
    })
    const stream = LLMAISDK.fullStream(result)
    if (patched) expect(() => result.fullStream).toThrow("exclusively taken")
    const aggregate = result.text
    const events = []
    for await (const event of stream) events.push(event)
    expect(await aggregate).toBe("2345")
    expect(await result.finishReason).toBe("stop")
    expect((await result.totalUsage).totalTokens).toBe(5)
    expect((await result.steps)[0].response.messages).toHaveLength(1)
    expect(events.find((event) => event.type === "text-delta")?.providerMetadata).toEqual({ offline: { index: 2 } })
    expect(finished).toBe(true)
  })

  test("unchanged getters support multiple readers and later replay", async () => {
    const result = streamText({ model: provider(4).model, prompt: "offline" })
    const full = result.fullStream
    const text = result.textStream
    const values = await Promise.all([
      (async () => {
        const items = []
        for await (const event of full) items.push(event)
        return items
      })(),
      (async () => {
        let value = ""
        for await (const delta of text) value += delta
        return value
      })(),
    ])
    expect(values[1]).toBe("2345")
    const replay = []
    for await (const event of result.fullStream) replay.push(event)
    expect(replay).toEqual(values[0])
    expect(await result.text).toBe("2345")
  })

  single("exclusive take rejects subsequent readers and a second take", async () => {
    const result = streamText({ model: provider(4).model, prompt: "offline" })
    const stream = result.takeFullStream()
    expect(() => result.takeFullStream()).toThrow("already been accessed")
    expect(() => result.fullStream).toThrow("exclusively taken")
    expect(() => result.textStream).toThrow("exclusively taken")
    expect(() => result.partialOutputStream).toThrow("exclusively taken")
    for await (const _ of stream) {
    }
  })

  single("cannot take after shared or automatic consumption", async () => {
    const result = streamText({ model: provider(4).model, prompt: "offline" })
    const text = result.text
    expect(() => result.takeFullStream()).toThrow("already been accessed")
    expect(await text).toBe("2345")
  })

  single("slow consumer bounds transformed output without changing SDK eager provider IO", async () => {
    const source = provider(4096)
    let transformed = 0
    const result = streamText({
      model: source.model,
      prompt: "offline",
      experimental_transform: () =>
        new TransformStream({
          transform(part, controller) {
            transformed++
            controller.enqueue(part)
          },
        }),
    })
    const iterator = result.takeFullStream()[Symbol.asyncIterator]()
    await iterator.next()
    // Wait for the SDK's eager producer while the consumer stops requesting data.
    await source.finished
    expect(transformed).toBeLessThan(32)
    // ai@6.0.168 eagerly pumps provider IO before its downstream transform stages.
    expect(source.state.pulled).toBe(4100)
    await iterator.return?.()
    expect((await iterator.next()).done).toBe(true)
  })

  single("early iterator return closes the owner without acquiring another reader", async () => {
    const source = provider(4096)
    const result = streamText({ model: source.model, prompt: "offline" })
    const iterator = result.takeFullStream()[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.()
    expect((await iterator.next()).done).toBe(true)
    expect(() => result.fullStream).toThrow("exclusively taken")
  })

  single("AbortSignal still terminates the owner", async () => {
    const source = provider(4096)
    const abort = new AbortController()
    const result = streamText({ model: source.model, prompt: "offline", abortSignal: abort.signal })
    const events = []
    for await (const event of result.takeFullStream()) {
      events.push(event.type)
      if (event.type === "text-delta") abort.abort()
    }
    expect(events).toContain("abort")
    expect(source.state.pulled).toBeLessThan(32)
  })
})

describe("loopback actual provider compatibility", () => {
  test.each(["openai", "openrouter"] as const)(
    "%s preserves auth, middleware, tools, repair and usage",
    async (name) => {
      const requests: { auth: string | null; marker: string | null; body: unknown }[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          requests.push({
            auth: request.headers.get("authorization"),
            marker: request.headers.get("x-offline"),
            body: await request.json(),
          })
          const frames = [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: { name: "LOOKUP", arguments: '{"query":"hello"}' },
                  },
                ],
              },
              finish_reason: null,
            },
            {
              delta: {
                tool_calls: [
                  { index: 1, id: "call-2", type: "function", function: { name: "missing", arguments: "{}" } },
                ],
              },
              finish_reason: null,
            },
            { delta: {}, finish_reason: "tool_calls" },
          ]
            .map(
              (choice) =>
                `data: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", created: 1, model: "offline", choices: [{ index: 0, ...choice }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\n`,
            )
            .join("")
          return new Response(frames + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
        },
      })
      try {
        let middleware = false
        const executed: unknown[] = []
        const repaired: string[] = []
        const result = streamText({
          model: wrapLanguageModel({
            model:
              name === "openai"
                ? createOpenAI({ baseURL: server.url.href, apiKey: "offline-key" }).chat("offline")
                : createOpenRouter({ baseURL: server.url.href, apiKey: "offline-key" }).chat("offline"),
            middleware: {
              specificationVersion: "v3",
              transformParams: async (args) => {
                middleware = true
                return args.params
              },
            },
          }),
          messages: [{ role: "user", content: "fixed" }],
          headers: { "x-offline": "preserved" },
          maxRetries: 0,
          tools: {
            lookup: tool({
              inputSchema: z.object({ query: z.string() }),
              execute: async (input) => {
                executed.push(input)
                return { title: "lookup", output: "found", metadata: { ok: true } }
              },
            }),
            invalid: tool({
              inputSchema: z.object({ tool: z.string() }),
              execute: async (input) => {
                executed.push(input)
                return { title: "invalid", output: "invalid", metadata: { invalid: true } }
              },
            }),
          },
          experimental_repairToolCall: async (failed) => {
            repaired.push(failed.toolCall.toolName)
            if (failed.toolCall.toolName === "LOOKUP") return { ...failed.toolCall, toolName: "lookup" }
            return {
              ...failed.toolCall,
              toolName: "invalid",
              input: JSON.stringify({ tool: failed.toolCall.toolName }),
            }
          },
        })
        const events = await drain(result)
        expect(events.filter((type) => type === "tool-call")).toHaveLength(2)
        expect(events.filter((type) => type === "tool-result")).toHaveLength(2)
        expect(middleware).toBe(true)
        expect(repaired).toEqual(["LOOKUP", "missing"])
        expect(executed).toEqual([{ query: "hello" }, { tool: "missing" }])
        expect((await result.toolResults).map((item) => item.output)).toEqual([
          { title: "lookup", output: "found", metadata: { ok: true } },
          { title: "invalid", output: "invalid", metadata: { invalid: true } },
        ])
        expect((await result.totalUsage).totalTokens).toBe(5)
        expect(requests).toHaveLength(1)
        expect(requests[0].auth).toBe("Bearer offline-key")
        expect(requests[0].marker).toBe("preserved")
      } finally {
        await server.stop(true)
      }
    },
  )
})
