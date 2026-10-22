import { expect } from "bun:test"
import { openai } from "@ai-sdk/openai"
import { jsonSchema, tool } from "ai"
import { LLMEvent } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
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
import { LLMNative } from "@/session/llm/native-request"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { MessageV2 } from "@/session/message-v2"
import { SessionProcessor } from "@/session/processor"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Snapshot } from "@/snapshot"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const model: Provider.Model = {
  id: ModelID.make("scripted-responses"),
  providerID: ProviderID.openai,
  api: { id: "scripted-responses", url: "https://unused.invalid/v1", npm: "@ai-sdk/openai" },
  name: "Scripted Responses",
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

const completed = {
  type: "response.completed",
  response: { id: "resp-scripted", usage: { input_tokens: 1, output_tokens: 1 } },
}
const answer = [{ type: "response.output_text.delta", item_id: "answer", delta: "answer" }, completed]
const transient = { type: "error", code: "server_error", message: "upstream failed" }
const tokenQuota = "quota input-tpm:123456789012:openai.gpt-6.1-sol (InputTokens) exceeded by 72778.776483333"
const quotaError = { type: "error", code: "quota_exceeded", message: tokenQuota }
type Retry = Extract<SessionStatus.Info, { type: "retry" }>

const setup = Effect.fn("test.providerErrorRetry.setup")(function* (script: readonly (readonly unknown[])[]) {
  const session = yield* Session.Service
  const bus = yield* Bus.Service
  const root = (yield* TestInstance).directory
  const chat = yield* session.create({ title: "Native provider-error retry" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    sessionID: chat.id,
    role: "user",
    agent: "build",
    model: { providerID: model.providerID, modelID: model.id },
    time: { created: Date.now() },
  })
  const message: MessageV2.Assistant = {
    id: MessageID.ascending(),
    sessionID: chat.id,
    role: "assistant",
    parentID: user.id,
    agent: "build",
    mode: "build",
    modelID: model.id,
    providerID: model.providerID,
    path: { cwd: root, root },
    time: { created: Date.now() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  yield* session.updateMessage(message)
  const calls: LLM.StreamInput[] = []
  const requests: { body: string; at: number }[] = []
  const events: LLMEvent[] = []
  const retries: Retry[] = []
  const errors: NonNullable<MessageV2.Assistant["error"]>[] = []
  const retrying = yield* Effect.all([Deferred.make<Retry>(), Deferred.make<Retry>()])
  const failed = yield* Deferred.make<NonNullable<MessageV2.Assistant["error"]>>()
  yield* (yield* bus.subscribe(SessionStatus.Event.Status)).pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        if (event.properties.sessionID !== chat.id || event.properties.status.type !== "retry") return
        retries.push(event.properties.status)
        const signal = retrying[event.properties.status.attempt - 1]
        if (signal) yield* Deferred.succeed(signal, event.properties.status)
      }),
    ),
    Effect.forkScoped,
  )
  yield* (yield* bus.subscribe(Session.Event.Error)).pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        if (event.properties.sessionID !== chat.id || !event.properties.error) return
        errors.push(event.properties.error)
        yield* Deferred.succeed(failed, event.properties.error)
      }),
    ),
    Effect.forkScoped,
  )
  const client = Context.get(
    yield* Layer.build(
      LLMClient.layer.pipe(
        Layer.provide(
          Layer.mock(RequestExecutor.Service, {
            execute: (request) =>
              Effect.gen(function* () {
                expect(request.url).toBe("https://unused.invalid/v1/responses")
                const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
                const body = yield* Effect.promise(() => web.text())
                const frames = script[requests.length] ?? answer
                requests.push({ body, at: yield* Clock.currentTimeMillis })
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
                    headers: { "content-type": "text/event-stream" },
                  }),
                )
              }),
          }),
        ),
      ),
    ),
    LLMClient.Service,
  )
  const processors = yield* Layer.build(SessionProcessor.layer).pipe(
    Effect.provideService(LLM.Service, {
      stream: (input) =>
        Stream.suspend(() => {
          calls.push(input)
          return client
            .stream({
              request: LLMNative.request({
                model: input.model,
                apiKey: "test-key",
                system: input.system,
                messages: input.messages,
                tools: input.tools,
              }),
              tools: LLMNativeRuntime.nativeTools(input.tools, {
                messages: input.messages,
                abort: new AbortController().signal,
              }),
              stopWhen: LLMClient.stepCountIs(2),
            })
            .pipe(Stream.tap((event) => Effect.sync(() => events.push(event))))
        }),
    }),
  )
  const handle = yield* Context.get(processors, SessionProcessor.Service).create({
    assistantMessage: message,
    sessionID: chat.id,
    model,
  })
  const input: LLM.StreamInput = {
    user,
    sessionID: chat.id,
    model,
    agent: { name: "build", mode: "primary", options: {}, permission: [] },
    system: [],
    messages: [{ role: "user", content: "test" }],
    tools: {},
  }
  return { handle, input, message, calls, requests, events, retries, errors, retrying, failed }
})

const processWithBackoff = Effect.fn("test.providerErrorRetry.processWithBackoff")(function* (
  test: Effect.Success<ReturnType<typeof setup>>,
  count: number,
  delay?: number,
) {
  const fiber = yield* test.handle.process(test.input).pipe(Effect.forkChild)
  for (let index = 0; index < count; index++) {
    const retry = yield* TestClock.withLive(
      awaitWithTimeout(Deferred.await(test.retrying[index]), "missing provider retry status"),
    )
    const wait = delay ?? 2000 * 2 ** index
    expect(retry.next).toBe((yield* Clock.currentTimeMillis) + wait)
    expect(test.requests).toHaveLength(index + 1)
    yield* TestClock.adjust(wait - 1)
    expect(test.requests).toHaveLength(index + 1)
    yield* TestClock.adjust(1)
  }
  return yield* TestClock.withLive(awaitWithTimeout(Fiber.join(fiber), "provider retry did not finish"))
})

for (const type of ["error", "response.failed"]) {
  it.instance(`native ${type} without details retries once and clears the terminal error`, () =>
    Effect.gen(function* () {
      const test = yield* setup([[{ type }]])
      expect(yield* processWithBackoff(test, 1)).toBe("continue")
      expect(test.requests.map((request) => request.at)).toEqual([0, 2000])
      expect(test.requests[0].body).toBe(test.requests[1].body)
      expect(test.calls).toHaveLength(2)
      expect(test.events.filter(LLMEvent.is.providerError)).toMatchObject([{ retryable: true }])
      expect(test.retries.map((retry) => retry.attempt)).toEqual([1])
      expect(test.errors).toEqual([])
      expect(test.message.error).toBeUndefined()
      expect(test.message.finish).toBe("stop")
      expect(MessageV2.parts(test.message.id).filter((part) => part.type === "text")).toMatchObject([
        { text: "answer" },
      ])
    }).pipe(Effect.provide(TestClock.layer())),
  )
}

it.instance("two transient provider errors retry at 2s and 4s before succeeding", () =>
  Effect.gen(function* () {
    const test = yield* setup([
      [transient],
      [{ type: "response.failed", response: { error: { code: "internal_error", message: "upstream failed" } } }],
    ])
    expect(yield* processWithBackoff(test, 2)).toBe("continue")
    expect(test.requests.map((request) => request.at)).toEqual([0, 2000, 6000])
    expect(new Set(test.requests.map((request) => request.body)).size).toBe(1)
    expect(test.calls).toHaveLength(3)
    expect(test.retries.map((retry) => retry.attempt)).toEqual([1, 2])
    expect(test.events.filter(LLMEvent.is.providerError)).toMatchObject([{ retryable: true }, { retryable: true }])
    expect(test.message.error).toBeUndefined()
    expect(test.errors).toEqual([])
  }).pipe(Effect.provide(TestClock.layer())),
)

for (const type of ["error", "response.failed"]) {
  it.instance(`native ${type} input-TPM quota recovers after one minute`, () =>
    Effect.gen(function* () {
      const test = yield* setup([
        [
          type === "error"
            ? quotaError
            : { type, response: { error: { code: "quota_exceeded", message: tokenQuota } } },
        ],
      ])
      expect(yield* processWithBackoff(test, 1, 60_000)).toBe("continue")
      expect(test.requests.map((request) => request.at)).toEqual([0, 60_000])
      expect(test.requests[0].body).toBe(test.requests[1].body)
      expect(test.events.filter(LLMEvent.is.providerError)).toEqual([
        { type: "provider-error", message: `quota_exceeded: ${tokenQuota}` },
      ])
      expect(test.errors).toEqual([])
      expect(test.message.error).toBeUndefined()
      expect(MessageV2.parts(test.message.id).filter((part) => part.type === "text")).toMatchObject([
        { text: "answer" },
      ])
    }).pipe(Effect.provide(TestClock.layer())),
  )
}

it.instance("native input-TPM quota retries stop after three wire calls", () =>
  Effect.gen(function* () {
    const test = yield* setup([[quotaError], [quotaError], [quotaError]])
    expect(yield* processWithBackoff(test, 2, 60_000)).toBe("stop")
    yield* TestClock.withLive(awaitWithTimeout(Deferred.await(test.failed), "missing terminal quota error"))
    expect(test.requests.map((request) => request.at)).toEqual([0, 60_000, 120_000])
    expect(test.retries.map((retry) => retry.attempt)).toEqual([1, 2])
    expect(test.errors).toHaveLength(1)
    expect(test.message.error).toMatchObject({ data: { message: `quota_exceeded: ${tokenQuota}` } })
  }).pipe(Effect.provide(TestClock.layer())),
)

for (const [code, message] of [
  ["quota_exceeded", "please try again"],
  ["quota_exceeded", `billing_hard_limit_reached: ${tokenQuota}`],
  ["quota_exceeded", `insufficient_quota: ${tokenQuota}`],
  ["invalid_api_key", tokenQuota],
  ["insufficient_quota", tokenQuota],
  ["context_length_exceeded", tokenQuota],
]) {
  it.instance(`native permanent rejection is not retried: ${code}: ${message}`, () =>
    Effect.gen(function* () {
      const test = yield* setup([[{ type: "error", error: { code, message } }]])
      expect(yield* test.handle.process(test.input)).toBe("stop")
      yield* awaitWithTimeout(Deferred.await(test.failed), "missing terminal error")
      expect(test.requests).toHaveLength(1)
      expect(test.retries).toEqual([])
      expect(test.message.error).toMatchObject({ data: { message: `${code}: ${message}` } })
    }),
  )
}

it.instance("cancelling native input-TPM backoff prevents redispatch", () =>
  Effect.gen(function* () {
    const test = yield* setup([[quotaError]])
    const fiber = yield* test.handle.process(test.input).pipe(Effect.forkChild)
    const retry = yield* TestClock.withLive(awaitWithTimeout(Deferred.await(test.retrying[0]), "missing quota backoff"))
    expect(retry.next).toBe((yield* Clock.currentTimeMillis) + 60_000)
    yield* Fiber.interrupt(fiber)
    yield* TestClock.adjust(120_000)
    expect(test.requests).toHaveLength(1)
    expect(test.retries).toHaveLength(1)
    expect(test.message.time.completed).toBeDefined()
  }).pipe(Effect.provide(TestClock.layer())),
)

it.instance("provider-error exhaustion stops after exactly three wire calls with one terminal error", () =>
  Effect.gen(function* () {
    const failure = { type: "error", code: "rate_limit_exceeded", message: "slow down" }
    const test = yield* setup([[failure], [failure], [failure]])
    expect(yield* processWithBackoff(test, 2)).toBe("stop")
    yield* TestClock.withLive(awaitWithTimeout(Deferred.await(test.failed), "missing terminal error"))
    expect(test.requests.map((request) => request.at)).toEqual([0, 2000, 6000])
    expect(test.calls).toHaveLength(3)
    expect(test.retries.map((retry) => retry.attempt)).toEqual([1, 2])
    expect(test.errors).toHaveLength(1)
    expect(test.message.error).toMatchObject({
      name: "APIError",
      data: { message: "rate_limit_exceeded: slow down", isRetryable: true },
    })
    expect(test.message.time.completed).toBeDefined()
  }).pipe(Effect.provide(TestClock.layer())),
)

for (const code of ["invalid_api_key", "invalid_request_error", "insufficient_quota", "unknown_provider_code"]) {
  it.instance(`explicit ${code} stays terminal despite optimistic retry text in a nested error`, () =>
    Effect.gen(function* () {
      const test = yield* setup([
        [{ type: "error", error: { code, message: "please try again", type: "invalid_request_error" } }],
      ])
      expect(yield* test.handle.process(test.input)).toBe("stop")
      yield* awaitWithTimeout(Deferred.await(test.failed), "missing terminal error")
      expect(test.calls).toHaveLength(1)
      expect(test.requests).toHaveLength(1)
      expect(test.retries).toEqual([])
      expect(test.events.filter(LLMEvent.is.providerError)).toMatchObject([
        { message: `${code}: please try again`, retryable: false },
      ])
      expect(test.message.error).toMatchObject({
        name: "APIError",
        data: { message: `${code}: please try again`, isRetryable: false },
      })
      expect(test.errors).toHaveLength(1)
    }),
  )
}

it.instance("cancelling during provider-error backoff never dispatches a second request", () =>
  Effect.gen(function* () {
    const test = yield* setup([[{ type: "error" }]])
    const fiber = yield* test.handle.process(test.input).pipe(Effect.forkChild)
    yield* awaitWithTimeout(Deferred.await(test.retrying[0]), "processor did not enter backoff")
    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(test.calls).toHaveLength(1)
    expect(test.requests).toHaveLength(1)
    expect(test.retries.map((retry) => retry.attempt)).toEqual([1])
    expect(test.message.time.completed).toBeDefined()
  }),
)

for (const kind of ["text", "reasoning", "tool"] as const) {
  it.instance(`native provider error after ${kind} activity cannot replay the request`, () =>
    Effect.gen(function* () {
      const progress =
        kind === "text"
          ? { type: "response.output_text.delta", item_id: "partial", delta: "partial answer" }
          : {
              type: "response.output_item.added",
              item:
                kind === "reasoning"
                  ? { type: "reasoning", id: "partial" }
                  : { type: "function_call", id: "partial", call_id: "write-1", name: "write", arguments: "" },
            }
      const test = yield* setup([[progress, transient]])
      expect(yield* test.handle.process(test.input)).toBe("stop")
      yield* awaitWithTimeout(Deferred.await(test.failed), "missing terminal error")
      expect(test.calls).toHaveLength(1)
      expect(test.requests).toHaveLength(1)
      expect(test.retries).toEqual([])
      expect(test.events.filter(LLMEvent.is.providerError)).toMatchObject([{ retryable: true }])
      expect(MessageV2.parts(test.message.id).filter((part) => part.type === kind)).toHaveLength(1)
      expect(test.message.error).toMatchObject({ name: "APIError", data: { message: "server_error: upstream failed" } })
    }),
  )
}

it.instance("a completed local tool is executed once when the follow-up model step fails", () =>
  Effect.gen(function* () {
    const executed: string[] = []
    const test = yield* setup([
      [
        {
          type: "response.output_item.done",
          item: { type: "function_call", id: "item-write", call_id: "write-1", name: "write", arguments: "{}" },
        },
        completed,
      ],
      [transient],
    ])
    test.input.tools = {
      write: tool({
        description: "Count a local side effect",
        inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {}, additionalProperties: false }),
        execute: async (_input, context) => {
          executed.push(context.toolCallId)
          return { title: "Written", output: "side effect completed", metadata: {} }
        },
      }),
    }
    expect(yield* test.handle.process(test.input)).toBe("stop")
    yield* awaitWithTimeout(Deferred.await(test.failed), "missing terminal error")
    expect(executed).toEqual(["write-1"])
    expect(test.calls).toHaveLength(1)
    expect(test.requests).toHaveLength(2)
    expect(test.requests[1].body).toContain('"type":"function_call_output"')
    expect(test.requests[1].body).toContain("side effect completed")
    expect(test.events.filter(LLMEvent.is.toolResult)).toHaveLength(1)
    expect(test.retries).toEqual([])
    expect(MessageV2.parts(test.message.id).filter((part) => part.type === "tool")).toMatchObject([
      { callID: "write-1", state: { status: "completed", output: "side effect completed" } },
    ])
    expect(test.message.error).toMatchObject({ name: "APIError", data: { message: "server_error: upstream failed" } })
  }),
)

it.instance("a provider-hosted tool forbids replay even before any output is observed", () =>
  Effect.gen(function* () {
    const test = yield* setup([[transient]])
    test.input.tools = { web_search: openai.tools.webSearch({}) }
    expect(yield* test.handle.process(test.input)).toBe("stop")
    yield* awaitWithTimeout(Deferred.await(test.failed), "missing terminal error")
    expect(test.calls).toHaveLength(1)
    expect(test.requests).toHaveLength(1)
    expect(test.requests[0].body).toContain('"name":"web_search"')
    expect(test.events.filter((event) => event.type !== "provider-error")).toEqual([])
    expect(test.retries).toEqual([])
    expect(MessageV2.parts(test.message.id)).toEqual([])
    expect(test.message.error).toMatchObject({ name: "APIError", data: { message: "server_error: upstream failed" } })
  }),
)
