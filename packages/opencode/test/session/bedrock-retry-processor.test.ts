import { expect } from "bun:test"
import { APICallError, jsonSchema, streamText, tool, wrapLanguageModel } from "ai"
import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { Agent } from "@/agent/agent"
import { Collaboration } from "@/agent/collaboration"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Image } from "@/image/image"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { LLM } from "@/session/llm"
import { LLMAISDK } from "@/session/llm/ai-sdk"
import { BedrockRetry } from "@/session/llm/bedrock-retry"
import { MessageV2 } from "@/session/message-v2"
import { SessionProcessor } from "@/session/processor"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Snapshot } from "@/snapshot"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

const model: Provider.Model = {
  id: ModelID.make("scripted-bedrock"),
  providerID: ProviderID.make("amazon-bedrock"),
  api: { id: "scripted-bedrock", url: "https://unused.invalid", npm: "@ai-sdk/amazon-bedrock" },
  name: "Scripted Bedrock",
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: false,
    toolcall: true,
    interleaved: false,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128000, output: 32000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const it = testEffect(
  Layer.mergeAll(
    Session.defaultLayer,
    Bus.layer,
    SessionStatus.defaultLayer,
    RuntimeFlags.layer({ experimentalEventSystem: false }),
    Layer.mock(Config.Service, { get: () => Effect.succeed({}) }),
    Layer.mock(Snapshot.Service, { track: () => Effect.succeed(undefined) }),
    Layer.mock(Agent.Service, {}),
    Layer.mock(Permission.Service, {}),
    Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
    Layer.mock(SessionSummary.Service, { summarize: () => Effect.void }),
    Layer.mock(Image.Service, {}),
    Layer.mock(EventV2Bridge.Service, {}),
    Layer.mock(Collaboration.Service, { hasMail: () => Effect.succeed(false) }),
  ),
)

const text = () =>
  Stream.make(
    LLMEvent.textStart({ id: "text" }),
    LLMEvent.textDelta({ id: "text", text: "answer" }),
    LLMEvent.textEnd({ id: "text" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  )

const throttled = () =>
  new APICallError({
    message: "Too many requests",
    url: "https://unused.invalid",
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: { "retry-after-ms": "1" },
    isRetryable: true,
  })

const guarded = (input: LLM.StreamInput) => {
  const state = (input.bedrockRetry ??= BedrockRetry.state())
  state.active = true
  return state
}

function raw(input: LLM.StreamInput, doStream: LanguageModelV3["doStream"]) {
  if (!input.bedrockRetry) throw new Error("processor did not provide its logical retry budget")
  const state = input.bedrockRetry
  const result = streamText({
    onError: () => {},
    model: wrapLanguageModel({
      model: {
        specificationVersion: "v3",
        provider: "amazon-bedrock",
        modelId: "scripted-bedrock",
        supportedUrls: {},
        doGenerate: async () => {
          throw new Error("unexpected generation")
        },
        doStream,
      },
      middleware: {
        specificationVersion: "v3",
        wrapStream: ({ model, params }) => BedrockRetry.stream({ model, params, state }),
      },
    }),
    messages: input.messages,
    tools: input.tools,
    maxRetries: 0,
  })
  const adapter = LLMAISDK.adapterState()
  return Stream.fromAsyncIterable(LLMAISDK.fullStream(result), (error) => error).pipe(
    Stream.mapEffect((event) => LLMAISDK.toLLMEvents(adapter, event)),
    Stream.flattenIterable,
  )
}

const rawAnswer = (): Awaited<ReturnType<LanguageModelV3["doStream"]>> => ({
  stream: new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "answer" })
      controller.enqueue({ type: "text-delta", id: "answer", delta: "answer" })
      controller.enqueue({ type: "text-end", id: "answer" })
      controller.enqueue({
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      })
      controller.close()
    },
  }),
})

const setup = Effect.fn("test.bedrockProcessor.setup")(function* (
  script: (input: LLM.StreamInput, attempt: number) => Stream.Stream<LLMEvent, unknown>,
  selected = model,
) {
  const session = yield* Session.Service
  const bus = yield* Bus.Service
  const root = (yield* TestInstance).directory
  const chat = yield* session.create({ title: "Scripted Bedrock retry processor" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    sessionID: chat.id,
    role: "user",
    agent: "build",
    model: { providerID: selected.providerID, modelID: selected.id },
    time: { created: Date.now() },
  })
  const message: MessageV2.Assistant = {
    id: MessageID.ascending(),
    sessionID: chat.id,
    role: "assistant",
    parentID: user.id,
    agent: "build",
    mode: "build",
    modelID: selected.id,
    providerID: selected.providerID,
    path: { cwd: root, root },
    time: { created: Date.now() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  yield* session.updateMessage(message)
  const calls: LLM.StreamInput[] = []
  const retries: number[] = []
  const errors: NonNullable<MessageV2.Assistant["error"]>[] = []
  const off = yield* bus.subscribeCallback(SessionStatus.Event.Status, (event) => {
    if (event.properties.sessionID === chat.id && event.properties.status.type === "retry") {
      retries.push(event.properties.status.attempt)
    }
  })
  yield* Effect.addFinalizer(() => Effect.sync(off))
  const offError = yield* bus.subscribeCallback(Session.Event.Error, (event) => {
    if (event.properties.sessionID === chat.id && event.properties.error) errors.push(event.properties.error)
  })
  yield* Effect.addFinalizer(() => Effect.sync(offError))
  const services = yield* Layer.build(SessionProcessor.layer).pipe(
    Effect.provideService(LLM.Service, {
      stream: (input) =>
        Stream.suspend(() => {
          calls.push(input)
          return script(input, calls.length)
        }),
    }),
  )
  const handle = yield* Context.get(services, SessionProcessor.Service).create({
    assistantMessage: message,
    sessionID: chat.id,
    model: selected,
  })
  const input: LLM.StreamInput = {
    user,
    sessionID: chat.id,
    model: selected,
    agent: { name: "build", mode: "primary", options: {}, permission: [] },
    system: [],
    messages: [{ role: "user", content: "test" }],
    tools: {},
  }
  return { handle, input, message, calls, retries, errors }
})

it.instance("unguarded Bedrock preserves retryable 429 handling", () =>
  Effect.gen(function* () {
    const test = yield* setup((_input, attempt) => (attempt === 1 ? Stream.fail(throttled()) : text()))
    expect(yield* test.handle.process(test.input)).toBe("continue")
    expect(test.calls).toHaveLength(2)
    expect(test.retries).toEqual([1])
    expect(test.message.error).toBeUndefined()
  }),
)

it.instance("unguarded Bedrock preserves hollow completion retries", () =>
  Effect.gen(function* () {
    const test = yield* setup((_input, attempt) => (attempt === 1 ? Stream.empty : text()))
    expect(yield* test.handle.process(test.input)).toBe("continue")
    expect(test.calls).toHaveLength(2)
    expect(test.retries).toEqual([1])
    expect(test.message.error).toBeUndefined()
  }),
)

for (const active of [false, true]) {
  it.instance(`${active ? "guarded" : "unguarded"} parent interruption stays terminal without a hollow retry`, () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const test = yield* setup((input) => {
        if (active) guarded(input)
        return Stream.fromEffect(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
      })
      const fiber = yield* test.handle.process(test.input).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(entered), "processor did not subscribe")
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(test.calls).toHaveLength(1)
      expect(test.retries).toEqual([])
      expect(test.message.error?.name).toBe("MessageAbortedError")
      expect(test.message.time.completed).toBeDefined()
    }),
  )
}

it.instance("guarded compaction is not replaced by scope-close abort", () =>
  Effect.gen(function* () {
    const test = yield* setup(
      (input) => {
        const state = guarded(input)
        return Stream.make(LLMEvent.stepFinish({ index: 0, reason: "length", usage: { inputTokens: 100 } })).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              state.error = new DOMException("scope closed", "AbortError")
            }),
          ),
        )
      },
      { ...model, limit: { context: 20, output: 10 } },
    )
    expect(yield* test.handle.process(test.input)).toBe("compact")
    expect(test.calls).toHaveLength(1)
    expect(test.calls[0].bedrockRetry?.error?.name).toBe("AbortError")
    expect(test.message.error).toBeUndefined()
    expect(test.retries).toEqual([])
  }),
)

it.instance("guarded mailbox preemption is not replaced by scope-close abort", () =>
  Effect.gen(function* () {
    const collaboration = yield* Collaboration.Service
    const test = yield* setup((input) => {
      const state = guarded(input)
      return Stream.make(LLMEvent.reasoningStart({ id: "mail" }), LLMEvent.reasoningEnd({ id: "mail" })).pipe(
        Stream.concat(text()),
        Stream.ensuring(
          Effect.sync(() => {
            state.error = new DOMException("scope closed", "AbortError")
          }),
        ),
      )
    }).pipe(Effect.provideService(Collaboration.Service, { ...collaboration, hasMail: () => Effect.succeed(true) }))
    expect(yield* test.handle.process(test.input)).toBe("continue")
    expect(test.calls).toHaveLength(1)
    expect(test.message.error).toBeUndefined()
    expect(test.retries).toEqual([])
    expect(MessageV2.parts(test.message.id).some((part) => part.type === "text")).toBe(false)
  }),
)

it.instance("raw commitment not represented by a processor part still forbids hollow replay", () =>
  Effect.gen(function* () {
    const test = yield* setup((input) => {
      guarded(input).committed = true
      return Stream.empty
    })
    expect(yield* test.handle.process(test.input)).toBe("continue")
    expect(test.calls).toHaveLength(1)
    expect(test.retries).toEqual([])
    expect(test.message.error).toBeUndefined()
  }),
)

it.instance("other providers retain legacy retries after output", () =>
  Effect.gen(function* () {
    const test = yield* setup(
      (_input, attempt) =>
        attempt === 1
          ? Stream.make(LLMEvent.textStart({ id: "legacy" })).pipe(Stream.concat(Stream.fail(throttled())))
          : text(),
      { ...model, providerID: ProviderID.make("test") },
    )
    expect(yield* test.handle.process(test.input)).toBe("continue")
    expect(test.calls).toHaveLength(2)
    expect(test.calls[0].bedrockRetry).toBe(test.calls[1].bedrockRetry)
    expect(test.calls[0].bedrockRetry?.active).toBe(false)
    expect(test.retries).toEqual([1])
    expect(test.message.error).toBeUndefined()
  }),
)

it.instance("guarded exhaustion cannot restart through the outer transient retry", () =>
  Effect.gen(function* () {
    const test = yield* setup((input, attempt) => {
      const state = guarded(input)
      state.attempts = 3
      state.error = throttled()
      return attempt === 1 ? Stream.fail(state.error) : text()
    })
    expect(yield* test.handle.process(test.input)).toBe("stop")
    expect(test.calls).toHaveLength(1)
    expect(test.retries).toEqual([])
    expect(test.message.error?.name).toBe("APIError")
    expect(test.message.time.completed).toBeDefined()
    yield* pollWithTimeout(
      Effect.sync(() => test.errors.length || undefined),
      "missing terminal error event",
    )
    expect(test.errors).toHaveLength(1)
  }),
)

it.instance("guarded terminal EOF cannot restart through the hollow retry", () =>
  Effect.gen(function* () {
    const test = yield* setup((input, attempt) => {
      const state = guarded(input)
      state.attempts = 3
      state.error = new Error("Bedrock no-output attempt budget exhausted")
      return attempt === 1 ? Stream.empty : text()
    })
    expect(yield* test.handle.process(test.input)).toBe("stop")
    expect(test.calls).toHaveLength(1)
    expect(test.retries).toEqual([])
    expect(test.message.error).toMatchObject({ data: { message: expect.stringContaining("budget exhausted") } })
    yield* pollWithTimeout(
      Effect.sync(() => test.errors.length || undefined),
      "missing terminal error event",
    )
    expect(test.errors).toHaveLength(1)
  }),
)

for (const name of ["AbortError", "TimeoutError"]) {
  it.instance(`guarded ${name} converted to EOF remains terminal`, () =>
    Effect.gen(function* () {
      const error = new DOMException("caller ended request", name)
      const test = yield* setup((input, attempt) => {
        guarded(input).error = error
        return attempt === 1 ? Stream.empty : text()
      })
      expect(yield* test.handle.process(test.input)).toBe("stop")
      expect(test.calls).toHaveLength(1)
      expect(test.retries).toEqual([])
      expect(test.message.error?.name).toBe(name === "AbortError" ? "MessageAbortedError" : "UnknownError")
      expect(test.message.error).toMatchObject({ data: { message: expect.stringContaining("caller ended request") } })
    }),
  )
}

it.instance("raw 429 Retry-After is honored within the same processor budget", () =>
  Effect.gen(function* () {
    const dispatches: number[] = []
    const test = yield* setup((input) =>
      raw(input, async () => {
        dispatches.push(performance.now())
        if (dispatches.length <= 2) {
          throw new APICallError({
            message: "Too many requests",
            url: "https://unused.invalid",
            requestBodyValues: {},
            statusCode: 429,
            isRetryable: true,
            responseHeaders: { "Retry-After": "0.08" },
          })
        }
        return rawAnswer()
      }),
    )
    expect(yield* test.handle.process(test.input)).toBe("continue")
    expect(test.calls).toHaveLength(1)
    expect(dispatches).toHaveLength(3)
    expect(dispatches[1] - dispatches[0]).toBeGreaterThanOrEqual(80)
    expect(dispatches[2] - dispatches[1]).toBeGreaterThanOrEqual(80)
    expect(test.calls[0].bedrockRetry).toMatchObject({ active: true, attempts: 3, committed: true, error: undefined })
    expect(test.retries).toEqual([])
    expect(test.message.error).toBeUndefined()
    expect(
      MessageV2.parts(test.message.id)
        .filter((part) => part.type === "text")
        .map((part) => part.text),
    ).toEqual(["answer"])
  }),
)

it.instance("raw exhausted 429 budget cannot multiply through processor retry", () =>
  Effect.gen(function* () {
    let dispatches = 0
    const test = yield* setup((input, call) => {
      if (call > 1) return text()
      return raw(input, async () => {
        dispatches++
        throw throttled()
      })
    })
    expect(yield* test.handle.process(test.input)).toBe("stop")
    expect(test.calls).toHaveLength(1)
    expect(dispatches).toBe(3)
    expect(test.calls[0].bedrockRetry).toMatchObject({ active: true, attempts: 3, committed: false })
    expect(test.calls[0].bedrockRetry?.error).toBeInstanceOf(BedrockRetry.BedrockRetryError)
    expect(test.retries).toEqual([])
  }),
)

it.instance("raw Retry-After beyond the wall budget stops without a replacement dispatch", () =>
  Effect.gen(function* () {
    let dispatches = 0
    const test = yield* setup((input) =>
      raw(input, async () => {
        dispatches++
        throw new APICallError({
          message: "Too many requests",
          url: "https://unused.invalid",
          requestBodyValues: {},
          statusCode: 429,
          isRetryable: true,
          responseHeaders: { "retry-after": "80" },
        })
      }),
    )
    expect(yield* test.handle.process(test.input)).toBe("stop")
    expect(test.calls).toHaveLength(1)
    expect(dispatches).toBe(1)
    expect(test.calls[0].bedrockRetry?.error).toMatchObject({ reason: "budget" })
    expect(test.retries).toEqual([])
  }),
)

it.instance("raw hollow exhaustion does not gain two additional processor retries", () =>
  Effect.gen(function* () {
    let dispatches = 0
    const test = yield* setup((input) =>
      raw(input, async () => {
        dispatches++
        return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start: (controller) => controller.close() }) }
      }),
    )
    expect(yield* test.handle.process(test.input)).toBe("stop")
    expect(test.calls).toHaveLength(1)
    expect(dispatches).toBe(3)
    expect(test.calls[0].bedrockRetry?.error).toMatchObject({ reason: "empty" })
    expect(test.retries).toEqual([])
  }),
)

for (const kind of ["text", "reasoning", "tool"] as const) {
  it.instance(`guarded transient error after ${kind} activity cannot replay`, () =>
    Effect.gen(function* () {
      const progress =
        kind === "text"
          ? LLMEvent.textStart({ id: "progress" })
          : kind === "reasoning"
            ? LLMEvent.reasoningStart({ id: "progress" })
            : LLMEvent.toolInputStart({ id: "progress", name: "write" })
      const test = yield* setup((input, attempt) => {
        const state = guarded(input)
        state.committed = true
        return attempt === 1 ? Stream.make(progress).pipe(Stream.concat(Stream.fail(throttled()))) : text()
      })
      expect(yield* test.handle.process(test.input)).toBe("stop")
      expect(test.calls).toHaveLength(1)
      expect(test.retries).toEqual([])
      expect(MessageV2.parts(test.message.id).filter((part) => part.type === kind)).toHaveLength(1)
      expect(test.message.error?.name).toBe("APIError")
    }),
  )
}

for (const kind of ["text", "tool"] as const) {
  for (const ending of ["missing", "synthetic", "authoritative"] as const) {
    it.instance(
      `committed ${kind} with ${ending} finish ${ending === "authoritative" ? "continues" : "stops"} without replay`,
      () =>
        Effect.gen(function* () {
          const executed = Promise.withResolvers<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => executed.resolve()))
          const commitments: boolean[] = []
          let dispatches = 0
          if (kind === "text") executed.resolve()
          const test = yield* setup((input) =>
            raw(input, async () => {
              dispatches++
              return {
                stream: new ReadableStream<LanguageModelV3StreamPart>({
                  start(controller) {
                    if (kind === "tool") {
                      controller.enqueue({ type: "tool-call", toolCallId: "write-1", toolName: "write", input: "{}" })
                      return
                    }
                    controller.enqueue({ type: "text-start", id: "partial" })
                    controller.enqueue({ type: "text-delta", id: "partial", delta: "partial answer" })
                    controller.enqueue({ type: "text-end", id: "partial" })
                  },
                  async pull(controller) {
                    // EOF must occur after the local side effect, not merely after
                    // enqueuing a tool event the SDK has not dispatched yet.
                    await executed.promise
                    if (ending !== "missing") {
                      controller.enqueue({
                        type: "finish",
                        finishReason:
                          ending === "synthetic"
                            ? { unified: "other", raw: undefined }
                            : {
                                unified: kind === "tool" ? "tool-calls" : "stop",
                                raw: kind === "tool" ? "tool_use" : "end_turn",
                              },
                        usage: {
                          inputTokens: {
                            total: ending === "authoritative" ? 1 : undefined,
                            noCache: undefined,
                            cacheRead: undefined,
                            cacheWrite: undefined,
                          },
                          outputTokens: {
                            total: ending === "authoritative" ? 1 : undefined,
                            text: undefined,
                            reasoning: undefined,
                          },
                        },
                      })
                    }
                    controller.close()
                  },
                }),
              }
            }),
          )
          if (kind === "tool") {
            test.input.tools = {
              write: tool({
                description: "Count a local side effect",
                inputSchema: jsonSchema<Record<string, never>>({
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                }),
                execute: async () => {
                  commitments.push(test.calls[0].bedrockRetry?.committed === true)
                  executed.resolve()
                  return { title: "Written", output: "side effect completed", metadata: {} }
                },
              }),
            }
          }
          expect(yield* test.handle.process(test.input)).toBe(ending === "authoritative" ? "continue" : "stop")
          expect(test.calls).toHaveLength(1)
          expect(dispatches).toBe(1)
          expect(commitments).toEqual(kind === "tool" ? [true] : [])
          expect(test.retries).toEqual([])
          expect(test.calls[0].bedrockRetry).toMatchObject({ active: true, attempts: 1, committed: true })
          expect(MessageV2.parts(test.message.id).filter((part) => part.type === kind)).toHaveLength(1)
          if (ending === "authoritative") {
            expect(test.message.error).toBeUndefined()
            expect(test.calls[0].bedrockRetry?.error).toBeUndefined()
            expect(test.message.finish).toBe(kind === "tool" ? "tool-calls" : "stop")
            return
          }
          expect(test.message.error).toBeDefined()
          expect(test.calls[0].bedrockRetry?.error).toMatchObject({ name: "BedrockRetryError", reason: "incomplete" })
          expect(test.calls[0].bedrockRetry?.unknownUsageAttempts).toBe(1)
        }),
    )
  }
}
