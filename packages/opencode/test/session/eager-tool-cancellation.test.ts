import { describe, expect } from "bun:test"
import { LLMEvent } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Collaboration } from "@/agent/collaboration"
import { Bus } from "@/bus"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { LLMNative } from "@/session/llm/native-request"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import type { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import { SessionTiming } from "@/session/timing"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { requireInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Permission.layer.pipe(Layer.provideMerge(Bus.layer)))

const model: Provider.Model = {
  id: ModelID.make("test-model"),
  providerID: ProviderID.openai,
  api: { id: "test-model", npm: "@ai-sdk/openai", url: "https://eager-cancellation.test/v1" },
  name: "Test model",
  options: {},
  headers: {},
  status: "active",
  release_date: "2026-01-01",
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128000, output: 32000 },
  capabilities: {
    temperature: false,
    reasoning: false,
    attachment: false,
    toolcall: true,
    interleaved: false,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
  },
}

const completed = { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }
const failed = { type: "error", message: "provider failed after requesting a read" }

const fixture = Effect.fnUntraced(function* (
  options: { name?: string; readOnly?: boolean; preAborted?: boolean; cleanup?: Effect.Effect<void> } = {},
) {
  const instance = yield* requireInstance
  const permission = yield* Permission.Service
  const bus = yield* Bus.Service
  const name = options.name ?? "lookup"
  const abort = new AbortController()
  if (options.preAborted) abort.abort()
  const asked = yield* Deferred.make<Permission.Request>()
  const cleanupStarted = yield* Deferred.make<void>()
  const cleaned = yield* Deferred.make<boolean>()
  const providerClosed = yield* Deferred.make<void>()
  const state = {
    executed: [] as string[],
    completed: [] as string[],
    hooks: [] as string[],
    signals: [] as AbortSignal[],
    timings: [] as SessionTiming.Record[],
    requests: 0,
  }
  const session: Session.Info = {
    id: SessionID.descending(),
    slug: "eager-cancellation",
    projectID: instance.project.id,
    directory: instance.directory,
    title: "Eager cancellation",
    version: "test",
    time: { created: 0, updated: 0 },
  }
  const message: MessageV2.Assistant = {
    id: MessageID.ascending(),
    parentID: MessageID.ascending(),
    sessionID: session.id,
    role: "assistant",
    agent: "test",
    mode: "test",
    providerID: model.providerID,
    modelID: model.id,
    time: { created: 0 },
    path: { cwd: instance.directory, root: instance.worktree },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
  }

  yield* (yield* bus.subscribe(Permission.Event.Asked)).pipe(
    Stream.runForEach((event) => Deferred.succeed(asked, event.properties)),
    Effect.forkScoped,
  )
  const tools = yield* SessionTools.resolve({
    session,
    model,
    agent: {
      name: "test",
      mode: "primary",
      options: {},
      permission: [{ permission: "read", pattern: "*", action: "ask" }],
    },
    messages: [],
    bypassAgentCheck: false,
    processor: {
      message,
      timing: SessionTiming.start(
        { sessionID: session.id, messageID: message.id },
        { emit: (record) => state.timings.push(record) },
      ),
      updateToolCall: () => Effect.die("unexpected tool metadata update"),
      completeToolCall: (id) => Effect.sync(() => void state.completed.push(id)),
    },
    promptOps: {
      cancel: () => Effect.void,
      resolvePromptParts: () => Effect.succeed([]),
      prompt: () => Effect.die("unexpected prompt"),
      loop: () => Effect.die("unexpected loop"),
    },
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(MCP.Service, { tools: () => Effect.succeed({}) }),
        Layer.mock(Truncate.Service, {}),
        Layer.mock(Collaboration.Service, {}),
        Layer.mock(Plugin.Service, {
          trigger: (hook, _input, output) =>
            Effect.sync(() => {
              state.hooks.push(hook)
              return output
            }),
        }),
        Layer.mock(ToolRegistry.Service, {
          tools: () =>
            Effect.succeed([
              {
                id: name,
                description: "Read only after permission is granted",
                ...(options.readOnly === false ? {} : { readOnly: true }),
                parameters: Schema.Struct({}),
                execute: (_args, ctx) =>
                  Effect.gen(function* () {
                    state.signals.push(ctx.abort)
                    yield* ctx.ask({ permission: "read", patterns: ["fixture.txt"], always: ["*"], metadata: {} })
                    state.executed.push(ctx.callID ?? "missing")
                    return { title: "read", output: "fixture contents", metadata: {} }
                  }).pipe(
                    Effect.onExit((exit) =>
                      Effect.gen(function* () {
                        yield* Deferred.succeed(cleanupStarted, undefined)
                        yield* options.cleanup ?? Effect.void
                        yield* Deferred.succeed(cleaned, Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
                      }),
                    ),
                  ),
              },
            ]),
        }),
      ),
    ),
  )
  const native = LLMNativeRuntime.nativeTools(tools, { messages: [], abort: abort.signal })
  const request = LLMNative.request({ model, apiKey: "test-key", messages: [{ role: "user", content: "Read it" }] })

  const fork = <A, E>(self: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const fiber = yield* self.pipe(Effect.forkScoped)
      // Release orphaned bridge promises before scoped fiber cleanup, including when an assertion fails.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          abort.abort()
          for (const request of yield* permission.list()) {
            yield* permission.reply({ requestID: request.id, reply: "reject" }).pipe(Effect.ignore)
          }
        }),
      )
      return fiber
    })

  const stream = (tail: Stream.Stream<unknown>) =>
    LLMClient.stream({ request, tools: native }).pipe(
      Stream.provide(
        LLMClient.layer.pipe(
          Layer.provide(
            Layer.mock(RequestExecutor.Service, {
              execute: (request) =>
                Effect.sync(() => {
                  state.requests++
                  return HttpClientResponse.fromWeb(
                    request,
                    new Response(
                      Stream.make({
                        type: "response.output_item.done",
                        item: { type: "function_call", id: "item", call_id: "call", name, arguments: "{}" },
                      }).pipe(
                        Stream.concat(tail),
                        Stream.map((event) => `data: ${JSON.stringify(event)}\n\n`),
                        Stream.encodeText,
                        Stream.ensuring(Deferred.succeed(providerClosed, undefined)),
                        Stream.toReadableStream,
                      ),
                      { headers: { "content-type": "text/event-stream" } },
                    ),
                  )
                }),
            }),
          ),
        ),
      ),
    )

  const pending = awaitWithTimeout(Deferred.await(asked), "read never requested permission").pipe(
    Effect.tap((request) =>
      pollWithTimeout(
        permission.list().pipe(Effect.map((items) => items.find((item) => item.id === request.id))),
        "permission request was not pending",
      ),
    ),
    Effect.tap((request) =>
      Effect.sync(() => {
        expect(request).toMatchObject({
          sessionID: session.id,
          permission: "read",
          patterns: ["fixture.txt"],
          tool: { messageID: message.id, callID: "call" },
        })
        expect(state.executed).toEqual([])
      }),
    ),
  )
  const cancelled = Effect.gen(function* () {
    expect(yield* permission.list()).toEqual([])
    expect(yield* Deferred.isDone(cleaned)).toBe(true)
    expect(yield* Deferred.await(cleaned)).toBe(true)
    expect(state.signals).toHaveLength(1)
    expect(state.signals[0].aborted).toBe(true)
    expect(state.hooks).toEqual(["tool.execute.before"])
    expect(state.executed).toEqual([])
    expect(state.completed).toEqual([])
    expect(state.timings.filter((record) => record.phase === "tool")).toMatchObject([
      { phase: "tool", callID: "call", tool: name, status: "interrupted" },
    ])
    expect(state.timings.filter((record) => record.phase === "tool")).toHaveLength(1)
    expect(state.timings.filter((record) => record.phase === "approval")).toMatchObject([
      { callID: "call", status: "interrupted" },
    ])
    expect(state.requests).toBe(1)
    expect(yield* Deferred.isDone(providerClosed)).toBe(true)
  })

  return {
    abort,
    asked,
    pending,
    cleanupStarted,
    cleaned,
    providerClosed,
    state,
    permission,
    native,
    fork,
    stream,
    cancelled,
  }
})

describe("session eager tool cancellation", () => {
  it.instance("provider-error waits for permission cancellation and read cleanup before finishing", () =>
    Effect.gen(function* () {
      const finish = yield* Deferred.make<void>()
      const cleanup = yield* Deferred.make<void>()
      const test = yield* fixture({ cleanup: Deferred.await(cleanup) })
      expect(test.native.lookup.execution).toBe("eager")
      const fiber = yield* test.stream(Stream.fromEffect(Deferred.await(finish).pipe(Effect.as(failed)))).pipe(
        Stream.tap((event) => (event.type === "finish" ? test.cancelled : Effect.void)),
        Stream.runCollect,
        test.fork,
      )
      yield* Effect.addFinalizer(() => Deferred.succeed(cleanup, undefined))
      const request = yield* test.pending
      yield* Deferred.succeed(finish, undefined)
      yield* awaitWithTimeout(Deferred.await(test.cleanupStarted), "provider-error did not interrupt the read")

      // Readiness is established above; this timeout checks that cleanup holds the terminal boundary open.
      expect(yield* Fiber.await(fiber).pipe(Effect.timeoutOption("50 millis"))).toEqual(Option.none())
      expect(yield* Deferred.isDone(test.cleaned)).toBe(false)
      yield* Deferred.succeed(cleanup, undefined)
      const events = yield* awaitWithTimeout(Fiber.join(fiber), "provider-error stream did not finish")
      expect(events.filter(LLMEvent.is.providerError)).toMatchObject([{ message: failed.message }])
      expect(events.filter(LLMEvent.is.toolResult)).toEqual([])
      expect(events.filter(LLMEvent.is.toolError)).toEqual([])
      expect(events.filter(LLMEvent.is.finish)).toHaveLength(1)
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" })
      expect(test.abort.signal.aborted).toBe(false)
      expect(yield* test.permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.flip)).toBeInstanceOf(
        Permission.NotFoundError,
      )
      yield* test.cancelled
    }),
  )

  it.instance("interrupting the stream removes the real pending permission before cancellation returns", () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const fiber = yield* test.stream(Stream.never).pipe(Stream.runDrain, test.fork)
      const request = yield* test.pending
      yield* awaitWithTimeout(Fiber.interrupt(fiber), "stream cancellation did not finish")
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(test.abort.signal.aborted).toBe(false)
      yield* test.cancelled
      expect(yield* test.permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.flip)).toBeInstanceOf(
        Permission.NotFoundError,
      )
      expect(test.state.completed).toEqual([])
    }),
  )

  it.instance("an early consumer stop drains the read and cannot be revived by a late permission grant", () =>
    Effect.gen(function* () {
      const stop = yield* Deferred.make<void>()
      const test = yield* fixture()
      const fiber = yield* test
        .stream(
          Stream.fromEffect(
            Deferred.await(stop).pipe(
              Effect.as({ type: "response.output_text.delta", item_id: "text", delta: "stop here" }),
            ),
          ).pipe(Stream.concat(Stream.never)),
        )
        .pipe(Stream.takeUntil(LLMEvent.is.textDelta), Stream.runCollect, test.fork)
      const request = yield* test.pending
      yield* Deferred.succeed(stop, undefined)
      const events = yield* awaitWithTimeout(Fiber.join(fiber), "consumer stop did not finish")
      expect(events.at(-1)).toMatchObject({ type: "text-delta", text: "stop here" })
      expect(events.filter(LLMEvent.is.finish)).toEqual([])
      expect(events.filter(LLMEvent.is.toolResult)).toEqual([])
      yield* test.cancelled
      expect(yield* test.permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.flip)).toBeInstanceOf(
        Permission.NotFoundError,
      )
      expect(test.state.completed).toEqual([])
    }),
  )

  it.instance("a caller abort interrupts the permission-waiting read without completing it stale", () =>
    Effect.gen(function* () {
      const finish = yield* Deferred.make<void>()
      const test = yield* fixture()
      const fiber = yield* test.stream(Stream.fromEffect(Deferred.await(finish).pipe(Effect.as(completed)))).pipe(
        Stream.tap((event) => (event.type === "finish" ? test.cancelled : Effect.void)),
        Stream.runCollect,
        test.fork,
      )
      const request = yield* test.pending
      test.abort.abort()
      yield* awaitWithTimeout(Deferred.await(test.cleaned), "caller abort did not clean up the read")
      yield* Deferred.succeed(finish, undefined)
      const events = yield* awaitWithTimeout(Fiber.join(fiber), "aborted read stream did not finish")
      expect(events.filter(LLMEvent.is.toolError)).toHaveLength(1)
      expect(events.filter(LLMEvent.is.toolResult)).toMatchObject([{ id: "call", result: { type: "error" } }])
      expect(yield* test.permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.flip)).toBeInstanceOf(
        Permission.NotFoundError,
      )
      yield* test.cancelled
    }),
  )

  it.instance("a pre-aborted read leaves no pending permission or post-permission execution", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ preAborted: true })
      expect(test.native.lookup.execution).toBe("eager")
      const fiber = yield* test.stream(Stream.make(completed)).pipe(
        Stream.tap((event) =>
          event.type === "finish"
            ? Effect.gen(function* () {
                expect(yield* test.permission.list()).toEqual([])
                if (test.state.signals.length) yield* test.cancelled
              })
            : Effect.void,
        ),
        Stream.runCollect,
        test.fork,
      )
      const events = yield* awaitWithTimeout(Fiber.join(fiber), "pre-aborted read remained pending")
      expect(events.filter(LLMEvent.is.toolCall)).toHaveLength(1)
      expect(events.filter(LLMEvent.is.toolError)).toHaveLength(1)
      expect(events.filter(LLMEvent.is.toolResult)).toMatchObject([{ id: "call", result: { type: "error" } }])
      expect(events.at(-1)?.type).toBe("finish")
      expect(yield* test.permission.list()).toEqual([])
      expect(yield* Deferred.isDone(test.providerClosed)).toBe(true)
      expect(test.state.signals.every((signal) => signal.aborted)).toBe(true)
      expect(test.state.hooks).not.toContain("tool.execute.after")
      expect(test.state.executed).toEqual([])
      expect(test.state.completed).toEqual([])
      if (yield* Deferred.isDone(test.asked)) {
        const request = yield* Deferred.await(test.asked)
        expect(yield* test.permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.flip)).toBeInstanceOf(
          Permission.NotFoundError,
        )
      }
    }),
  )

  it.instance("a custom tool named read without a readOnly marker waits until generation finishes", () =>
    Effect.gen(function* () {
      const finish = yield* Deferred.make<void>()
      const announced = yield* Deferred.make<void>()
      const test = yield* fixture({ name: "read", readOnly: false })
      expect(test.native.read.execution).toBeUndefined()
      const fiber = yield* test.stream(Stream.fromEffect(Deferred.await(finish).pipe(Effect.as(completed)))).pipe(
        Stream.tap((event) => (event.type === "tool-call" ? Deferred.succeed(announced, undefined) : Effect.void)),
        Stream.runCollect,
        test.fork,
      )
      yield* awaitWithTimeout(Deferred.await(announced), "custom read call was not streamed")
      expect(yield* test.permission.list()).toEqual([])
      expect(test.state.signals).toEqual([])
      expect(test.state.hooks).toEqual([])
      yield* Deferred.succeed(finish, undefined)
      const request = yield* test.pending
      expect(yield* Deferred.isDone(test.providerClosed)).toBe(true)
      yield* test.permission.reply({ requestID: request.id, reply: "once" })
      const events = yield* awaitWithTimeout(Fiber.join(fiber), "custom read did not finish after permission")
      expect(test.state.executed).toEqual(["call"])
      expect(test.state.completed).toEqual([])
      expect(test.state.hooks).toEqual(["tool.execute.before", "tool.execute.after"])
      expect(yield* Deferred.await(test.cleaned)).toBe(false)
      expect(test.state.timings.filter((record) => record.phase === "tool")).toMatchObject([
        { phase: "tool", callID: "call", tool: "read", status: "completed" },
      ])
      expect(events.filter(LLMEvent.is.toolResult)).toHaveLength(1)
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "tool-calls" })
    }),
  )
})
