import { expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLMError, TransportReason } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import type { ModelMessage } from "ai"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const model: Provider.Model = {
  id: ModelID.make("gpt-5.5"),
  providerID: ProviderID.openai,
  api: { id: "gpt-5.5", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
  name: "OpenAI",
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: true,
    toolcall: true,
    interleaved: false,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128000, output: 32000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}
const provider: Provider.Info = {
  id: ProviderID.openai,
  name: "OpenAI",
  env: [],
  source: "config",
  models: {},
  options: { apiKey: "key" },
}
const policy = { model, provider, auth: undefined, providerOptions: { serviceTier: "ultrafast" } }

test("automatic native policy requires explicit Ultrafast on the trusted direct API", () => {
  expect(LLMNativeRuntime.autoNative(policy)).toBe(true)
  expect(LLMNativeRuntime.autoNative({ ...policy, providerOptions: { openai: { serviceTier: "ultrafast" } } })).toBe(
    false,
  )
  for (const serviceTier of [undefined, "auto", "priority", "default"]) {
    expect(LLMNativeRuntime.autoNative({ ...policy, providerOptions: { serviceTier } })).toBe(false)
  }
  for (const baseURL of [
    "http://api.openai.com/v1",
    "https://api.openai.com.evil.test/v1",
    "https://custom.test/v1",
    "https://api.openai.com/v1?key=other",
    "https://api.openai.com/v1#fragment",
    "https://user:pass@api.openai.com/v1",
    "https://api.openai.com/custom",
    "invalid",
  ]) {
    expect(
      LLMNativeRuntime.autoNative({ ...policy, provider: { ...provider, options: { apiKey: "key", baseURL } } }),
    ).toBe(false)
  }
  expect(
    LLMNativeRuntime.autoNative({
      ...policy,
      model: { ...model, api: { ...model.api, url: "https://custom.test/v1" } },
    }),
  ).toBe(false)
  expect(
    LLMNativeRuntime.autoNative({
      ...policy,
      model: { ...model, providerID: ProviderID.openaiCodex },
      provider: { ...provider, id: ProviderID.openaiCodex },
    }),
  ).toBe(false)
  expect(
    LLMNativeRuntime.autoNative({
      ...policy,
      model: { ...model, api: { ...model.api, npm: "@ai-sdk/openai-compatible" } },
    }),
  ).toBe(false)
  expect(
    LLMNativeRuntime.autoNative({
      ...policy,
      auth: { type: "oauth", access: "access", refresh: "refresh", expires: 1 },
    }),
  ).toBe(false)
  expect(LLMNativeRuntime.autoNative({ ...policy, provider: { ...provider, options: {} } })).toBe(false)
})

test("model transport overrides provider and custom fetch is rejected even for explicit native", () => {
  const configured = { ...provider, options: { apiKey: "key", transport: "websocket" } }
  expect(LLMNativeRuntime.autoNative({ ...policy, provider: configured })).toBe(true)
  expect(
    LLMNativeRuntime.autoNative({
      ...policy,
      provider: configured,
      model: { ...model, options: { transport: "http" } },
    }),
  ).toBe(false)
  const custom = { ...provider, options: { apiKey: "key", fetch: globalThis.fetch } }
  expect(LLMNativeRuntime.autoNative({ ...policy, provider: custom })).toBe(false)
  expect(LLMNativeRuntime.status({ ...policy, provider: custom })).toMatchObject({
    type: "unsupported",
    reason: expect.stringContaining("custom provider fetch"),
  })
})

const failure = (method: string, kind = method) =>
  new LLMError({
    module: "WebSocketExecutor",
    method,
    reason: new TransportReason({ kind, message: method }),
  })
const user = (content: string): ModelMessage => ({ role: "user", content })
const assistant = (content: string): ModelMessage => ({ role: "assistant", content })
const frames = (id: string) => [
  { type: "response.output_text.delta", item_id: "msg", delta: id },
  { type: "response.completed", response: { id } },
]

function fixture(mode = "success", socketURL?: string) {
  const websocket: Record<string, unknown>[] = []
  const http: Record<string, unknown>[] = []
  const control = { mode, opens: 0 }
  const continuation = LLMNativeRuntime.createContinuationState()
  const fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      expect(request.url).toBe("https://api.openai.com/v1/responses")
      expect(request.headers.get("authorization")).toBe("Bearer key")
      http.push((await request.json()) as Record<string, unknown>)
      return new Response(
        frames("http_response")
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      )
    },
    { preconnect: () => undefined },
  ) satisfies typeof globalThis.fetch
  const layer = LLMClient.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        RequestExecutor.defaultLayer,
        Layer.succeed(WebSocketExecutor.Service, {
          open: (input) => {
            control.opens++
            expect(input.url).toBe("wss://api.openai.com/v1/responses")
            if (socketURL) return WebSocketExecutor.open({ ...input, url: socketURL })
            if (control.mode === "open") return Effect.fail(failure("open"))
            if (control.mode === "timeout")
              return Effect.fail(
                new LLMError({
                  module: "WebSocketExecutor",
                  method: "open",
                  reason: new TransportReason({ kind: "open", message: "Handshake timed out" }),
                }),
              )
            return Effect.succeed({
              sendText: (body: string) =>
                Effect.gen(function* () {
                  websocket.push(JSON.parse(body) as Record<string, unknown>)
                  if (control.mode === "send") return yield* failure("sendText", "send")
                }),
              messages: Stream.suspend(() => {
                if (control.mode === "read") return Stream.fail(failure("message", "close"))
                if (control.mode === "after-output")
                  return Stream.make(JSON.stringify(frames("partial")[0])).pipe(
                    Stream.concat(Stream.fail(failure("open"))),
                  )
                if (control.mode === "provider")
                  return Stream.make(
                    JSON.stringify({ type: "error", code: "invalid_model", message: "Model unavailable" }),
                  )
                return Stream.fromIterable(frames(`ws_${websocket.length}`).map((event) => JSON.stringify(event)))
              }),
              close: Effect.void,
            })
          },
        }),
      ),
    ),
  )
  const send = Effect.fn(function* (
    messages: ModelMessage[],
    previousResponseId?: string,
    options: Record<string, unknown> = {},
    providerOptions: Record<string, unknown> = {
      serviceTier: "ultrafast",
      instructions: "Keep full instructions",
      store: false,
    },
  ) {
    const native = LLMNativeRuntime.stream({
      ...policy,
      provider: { ...provider, options: { ...provider.options, ...options } },
      llmClient: yield* LLMClient.Service,
      messages,
      previousResponseId,
      continuation,
      sessionID: "session",
      tools: {},
      headers: {},
      abort: new AbortController().signal,
      providerOptions,
    })
    if (native.type !== "supported") throw new Error(native.reason)
    return yield* native.stream.pipe(Stream.provideService(FetchHttpClient.Fetch, fetch), Stream.runCollect)
  })
  return { websocket, http, control, continuation, layer, send }
}

it.live("automatic WebSocket enables verified continuation without changing the requested tier", () => {
  const test = fixture()
  return Effect.gen(function* () {
    yield* test.send([user("first")])
    yield* test.send([user("first"), assistant("ws_1"), user("second")], "ws_1")
    expect(test.http).toHaveLength(0)
    expect(test.websocket[1]).toMatchObject({
      service_tier: "ultrafast",
      previous_response_id: "ws_1",
      input: [{ role: "user", content: [{ type: "input_text", text: "second" }] }],
    })
  }).pipe(Effect.provide(test.layer))
})

it.live("nested tier options cannot activate automatic WebSocket when the wire tier is absent", () => {
  const test = fixture()
  return Effect.gen(function* () {
    yield* test.send([user("nested")], undefined, {}, { openai: { serviceTier: "ultrafast" } })
    expect(test.control.opens).toBe(0)
    expect(test.websocket).toHaveLength(0)
    expect(test.http).toHaveLength(1)
    expect(test.http[0]).not.toHaveProperty("service_tier")
    yield* test.send([user("flat")])
    expect(test.websocket).toHaveLength(1)
    expect(test.websocket[0].service_tier).toBe("ultrafast")
  }).pipe(Effect.provide(test.layer))
})

it.live("opening failure falls back once with full context and invalidates the WebSocket receipt", () => {
  const test = fixture()
  return Effect.gen(function* () {
    yield* test.send([user("first")])
    test.control.mode = "open"
    const history = [user("first"), assistant("ws_1"), user("second")]
    yield* test.send(history, "ws_1")
    expect(test.http).toHaveLength(1)
    expect(test.http[0]).toMatchObject({ service_tier: "ultrafast", instructions: "Keep full instructions" })
    expect(test.http[0]).not.toHaveProperty("previous_response_id")
    expect(test.http[0].input).toHaveLength(3)
    expect(test.continuation.size).toBe(0)
    test.control.mode = "success"
    yield* test.send([...history, assistant("http_response"), user("third")], "http_response")
    expect(test.websocket[1]).not.toHaveProperty("previous_response_id")
    expect(test.websocket[1].input).toHaveLength(5)
  }).pipe(Effect.provide(test.layer))
})

it.live("a real rejected local WebSocket handshake safely falls back to native HTTP", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("No upgrade", { status: 426 }) }),
      ),
      (server) =>
        Effect.sync(() => {
          void server.stop(true)
        }),
    )
    const test = fixture("success", `ws://127.0.0.1:${server.port}/responses`)
    yield* test.send([user("first")]).pipe(Effect.provide(test.layer))
    expect(test.http).toHaveLength(1)
    expect(test.websocket).toHaveLength(0)
  }),
)

for (const mode of ["send", "read", "timeout", "provider", "after-output"]) {
  it.live(`does not fall back on ${mode} failures`, () => {
    const test = fixture(mode)
    return Effect.gen(function* () {
      const result = yield* test.send([user("first")]).pipe(Effect.exit)
      expect(test.http).toHaveLength(0)
      expect(test.control.opens).toBe(1)
      expect(test.continuation.size).toBe(0)
      if (mode !== "provider") expect(result._tag).toBe("Failure")
    }).pipe(Effect.provide(test.layer))
  })
}

it.live("explicit HTTP and disabled continuation override automatic defaults", () => {
  const test = fixture()
  return Effect.gen(function* () {
    yield* test.send([user("http")], undefined, { transport: "http" })
    expect(test.control.opens).toBe(0)
    expect(test.http).toHaveLength(1)
    yield* test.send([user("ws")], undefined, { responsesContinuation: false })
    expect(test.websocket).toHaveLength(1)
    expect(test.continuation.size).toBe(0)
  }).pipe(Effect.provide(test.layer))
})

it.live("an explicitly selected WebSocket does not opt into automatic HTTP fallback", () => {
  const test = fixture("open")
  return Effect.gen(function* () {
    const result = yield* test.send([user("first")], undefined, { transport: "websocket" }).pipe(Effect.exit)
    expect(result._tag).toBe("Failure")
    expect(test.http).toHaveLength(0)
  }).pipe(Effect.provide(test.layer))
})

it.live("cache breakpoints with interleaved system messages return unsupported before transport", () => {
  const test = fixture()
  return Effect.gen(function* () {
    const native = LLMNativeRuntime.stream({
      ...policy,
      llmClient: yield* LLMClient.Service,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "cached", providerOptions: { openai: { promptCacheBreakpoint: true } } }],
        },
        { role: "system", content: "dynamic suffix" },
      ],
      tools: {},
      headers: {},
      abort: new AbortController().signal,
    })
    expect(native).toEqual({
      type: "unsupported",
      reason: "Native Responses cannot preserve explicit cache breakpoints with interleaved system messages",
    })
    expect(test.control.opens).toBe(0)
    expect(test.http).toHaveLength(0)
  }).pipe(Effect.provide(test.layer))
})
