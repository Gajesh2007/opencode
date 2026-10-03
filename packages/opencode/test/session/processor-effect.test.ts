import { NodeFileSystem } from "@effect/platform-node"
import { expect } from "bun:test"
import { tool } from "ai"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import path from "path"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Collaboration } from "@/agent/collaboration"
import { Bus } from "../../src/bus"
import { Config } from "@/config/config"
import { Image } from "@/image/image"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import * as Log from "@opencode-ai/core/util/log"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionEvent } from "@opencode-ai/core/session-event"
import { LLM as NativeLLM, LLMEvent, Usage, tool as nativeTool } from "@opencode-ai/llm"
import * as OpenAI from "@opencode-ai/llm/providers/openai"
import { ToolRuntime } from "../../../llm/src/tool-runtime"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const waitFor = <A>(check: Effect.Effect<A | undefined>, message: string) =>
  Effect.gen(function* () {
    const stop = Date.now() + 500
    while (Date.now() < stop) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(message))
  })

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  LLM.defaultLayer,
  Provider.defaultLayer,
  status,
  SyncEvent.defaultLayer,
  EventV2Bridge.defaultLayer,
  Collaboration.defaultLayer,
).pipe(Layer.provideMerge(infra))
const env = Layer.mergeAll(
  TestLLMServer.layer,
  SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(deps),
  ),
)

const it = testEffect(env)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value).toBe("continue")
        expect(calls).toBe(1)
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor preempts after reasoning when collaboration mail arrives", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const collaboration = yield* Collaboration.Service
        const release = defer<void>()
        yield* llm.push(reply().reason("considering options").wait(release.promise).text("must not reach text").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        yield* collaboration.registerRoot(chat.id)
        const child = SessionID.make("ses_processor_preempt_child")
        yield* collaboration.registerChild({ parentSessionID: chat.id, sessionID: child, taskName: "worker" })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const input = {
          user: parent,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user" as const, content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const processing = yield* handle.process(input).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* collaboration.send({
          sessionID: child,
          target: "..",
          kind: "MESSAGE",
          content: "new direction",
          triggerTurn: false,
        })
        yield* Effect.sync(() => release.resolve())

        expect(yield* Fiber.join(processing)).toBe("continue")
        expect(MessageV2.parts(msg.id).some((part) => part.type === "reasoning")).toBe(true)
        expect(
          MessageV2.parts(msg.id).some((part) => part.type === "text" && part.text === "must not reach text"),
        ).toBe(false)
        expect(msg.error).toBeUndefined()
        expect(yield* collaboration.hasMail(chat.id)).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry a hollow completion with no output", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // First turn finishes "successfully" with no text / reasoning / tool — a
        // hollow completion (provider ended before inference really ran). The
        // processor must re-issue the request rather than accept the empty turn.
        yield* llm.push(reply().stop())
        yield* llm.push(reply().text("recovered answer").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        // hollow attempt + one retry = 2 calls; the recovered text reaches the message.
        expect(calls).toBe(2)
        expect(value).toBe("continue")
        expect(parts.some((part) => part.type === "text" && part.text === "recovered answer")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live(
  "session.processor effect tests stop retrying empty completions after the cap",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          // Every attempt is hollow. The processor must give up after the bounded
          // cap (EMPTY_COMPLETION_MAX_RETRIES) instead of looping forever. Queue
          // exactly initial + cap = 3 so a 4th call (a bug) would hit the auto
          // fallback and fail the count assertion rather than be masked.
          for (let i = 0; i < 3; i++) yield* llm.push(reply().stop())

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "hi")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          const input = {
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          } satisfies LLM.StreamInput

          const value = yield* handle.process(input)
          const calls = yield* llm.calls

          // initial attempt + EMPTY_COMPLETION_MAX_RETRIES (2) = 3 calls, then accept.
          expect(calls).toBe(3)
          expect(value).toBe("continue")
        }),
      { config: (url) => providerCfg(url) },
    ),
  // Two real backoffs (2s + 4s) exceed the default 5s test timeout.
  15_000,
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* waitFor(
          Effect.sync(() => MessageV2.parts(msg.id).find((part): part is MessageV2.TextPart => part.type === "text")),
          "timed out waiting for text part",
        )
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = MessageV2.parts(msg.id).find((part): part is MessageV2.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.text("after", { usage: { input: 100, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("compact")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor does not prefetch native tool execution past compaction", () =>
  provideTmpdirServer(
    ({ dir }) =>
      Effect.gen(function* () {
        const { session, provider } = yield* boot()
        const snapshot = yield* Snapshot.Service
        let executions = 0
        const processors = yield* Layer.build(
          SessionProcessor.layer.pipe(
            Layer.fresh,
            Layer.provide(summary),
            Layer.provide(Image.defaultLayer),
            Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
          ),
        ).pipe(
          Effect.map((services) => Context.get(services, SessionProcessor.Service)),
          Effect.provideService(Snapshot.Service, {
            ...snapshot,
            // Leave time for a prefetched pull to dispatch tools while the
            // step-finish handler is still deciding whether to compact.
            track: () => Effect.sleep("30 millis").pipe(Effect.andThen(snapshot.track())),
          }),
          Effect.provideService(LLM.Service, {
            stream: () =>
              ToolRuntime.stream({
                request: NativeLLM.request({
                  model: OpenAI.configure({ apiKey: "test" }).chat("test-model"),
                  prompt: "Run the tool",
                }),
                tools: {
                  counted: nativeTool({
                    description: "Count tool executions",
                    parameters: Schema.Struct({}),
                    success: Schema.String,
                    execute: () =>
                      Effect.sync(() => {
                        executions++
                        return "executed"
                      }),
                  }),
                },
                stream: () =>
                  Stream.make(LLMEvent.toolCall({ id: "call_counted", name: "counted", input: {} })).pipe(
                    Stream.concat(
                      Stream.make(
                        LLMEvent.stepFinish({
                          index: 0,
                          reason: "tool-calls",
                          usage: new Usage({ inputTokens: 100 }),
                        }),
                      ),
                    ),
                  ),
              }),
          }),
        )
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const result = yield* handle.process({
          user: parent,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })
        expect(msg.error).toBeUndefined()
        expect(result).toBe("compact")
        expect(executions).toBe(0)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is MessageV2.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is MessageV2.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests coalesce small text deltas into batched PartDelta events", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service

        // 10 small deltas, each 2 chars, stay below the 64-character threshold.
        // Timer flushes may split the burst, but it should still be coalesced.
        let chain = reply()
        for (let i = 0; i < 10; i++) chain = chain.text("ab")
        yield* llm.push(chain.stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "stream")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const partDeltaEvents: { partID: string; delta: string }[] = []
        yield* bus.subscribeCallback(MessageV2.Event.PartDelta, (event) => {
          partDeltaEvents.push({
            partID: event.properties.partID,
            delta: event.properties.delta,
          })
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "stream" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const text = parts.find((part): part is MessageV2.TextPart => part.type === "text")

        // Correctness: streamed text is fully reconstructed.
        expect(value).toBe("continue")
        expect(text?.text).toBe("ab".repeat(10))

        // The first delta is immediate; the rest can batch until a timer or end.
        expect(partDeltaEvents[0]?.delta).toBe("ab")
        expect(partDeltaEvents.length).toBeLessThan(10)

        // The accumulated delta text matches the part's text exactly.
        const sameTarget = partDeltaEvents.every((e) => e.partID === text?.id)
        expect(sameTarget).toBe(true)
        const concatenated = partDeltaEvents.map((e) => e.delta).join("")
        expect(concatenated).toBe("ab".repeat(10))
      }),
    { config: (url) => providerCfg(url) },
  ),
)

for (const kind of ["text", "reasoning", "tool"] as const) {
  it.live(`session.processor bounds delayed ${kind} delta publication latency`, () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { session, provider } = yield* boot()
          const bus = yield* Bus.Service
          const upstream = yield* LLM.Service
          const received = yield* Deferred.make<void>()
          const gate = defer<void>()
          yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
          const arrivals: number[] = []
          const publications: { delta: string; time: number }[] = []
          const finish = { time: Infinity }
          // Observe real, decoded HTTP events immediately before the processor,
          // rather than benchmarking a copy of its batching implementation.
          const processors = yield* Layer.build(
            SessionProcessor.layer.pipe(
              Layer.fresh,
              Layer.provide(summary),
              Layer.provide(Image.defaultLayer),
              Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
            ),
          ).pipe(
            Effect.map((services) => Context.get(services, SessionProcessor.Service)),
            Effect.provideService(LLM.Service, {
              ...upstream,
              stream: (input) =>
                upstream.stream(input).pipe(
                  Stream.tap((event) =>
                    Effect.gen(function* () {
                      if (
                        event.type !== "text-delta" &&
                        event.type !== "reasoning-delta" &&
                        event.type !== "tool-input-delta"
                      )
                        return
                      if (!event.text) return
                      arrivals.push(performance.now())
                      if (arrivals.length === 3) yield* Deferred.succeed(received, undefined)
                    }),
                  ),
                ),
            }),
          )
          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "stream")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
          yield* (yield* bus.subscribe(MessageV2.Event.PartDelta)).pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event.properties.messageID === msg.id)
                  publications.push({ delta: event.properties.delta, time: performance.now() })
              }),
            ),
            Effect.forkScoped,
          )
          yield* llm.push(
            raw({
              head: ["a", "b", "c"].map((text, index) => ({
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [
                  {
                    delta:
                      kind === "text"
                        ? { content: text }
                        : kind === "reasoning"
                          ? { reasoning_content: text }
                          : {
                              tool_calls: [
                                {
                                  index: 0,
                                  ...(index === 0 ? { id: "call_latency", type: "function" } : {}),
                                  function: { ...(index === 0 ? { name: "test" } : {}), arguments: text },
                                },
                              ],
                            },
                  },
                ],
              })),
              wait: gate.promise,
              tail: [
                {
                  id: "chatcmpl-test",
                  object: "chat.completion.chunk",
                  choices: [{ delta: {}, finish_reason: "stop" }],
                },
              ],
            }),
          )
          yield* Deferred.await(received).pipe(
            Effect.andThen(Effect.sleep("120 millis")),
            Effect.andThen(
              Effect.sync(() => {
                finish.time = performance.now()
                gate.resolve()
              }),
            ),
            Effect.forkScoped,
          )
          const start = performance.now()
          yield* handle.process({
            user: parent,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "stream" }],
            tools: {},
          })
          yield* waitFor(
            Effect.sync(() => (publications.map((event) => event.delta).join("") === "abc" ? true : undefined)),
            "timed out waiting for delta publications",
          )
          const delays = publications.flatMap((event) => [...event.delta].map(() => event.time))
          expect(arrivals).toHaveLength(3)
          expect(publications.map((event) => event.delta).join("")).toBe("abc")
          const first = delays[0] - arrivals[0]
          const stalled = Math.max(...arrivals.slice(1).map((time, index) => delays[index + 1] - time))
          if (process.env.OPENCODE_TEST_DELTA_LATENCY)
            console.log(
              `delta latency ${kind}: first=${first.toFixed(2)}ms stalled_max=${stalled.toFixed(2)}ms process_to_first=${(delays[0] - start).toFixed(2)}ms`,
            )
          expect(publications[0].delta).toBe("a")
          // Even under live-clock scheduling delays, publication must not wait
          // for more provider output. Keep the exact timings as measurements.
          expect(delays.every((time) => time < finish.time)).toBe(true)
        }),
      { config: (url) => providerCfg(url) },
    ),
  )
}

it.live("session.processor streams coalesced tool input before replacing it with parsed input", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service
        const events = yield* EventV2Bridge.Service
        const gate = defer<void>()
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()))
        const input = { code: 'const text = "hello";\n'.repeat(6) }
        const source = JSON.stringify({ ...input, ignored: true })
        const chunks = Array.from({ length: Math.ceil(source.length / 8) }, (_, i) => ({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: source.slice(i * 8, i * 8 + 8) } }] } }],
        }))
        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        { index: 0, id: "call_code", type: "function", function: { name: "code", arguments: "" } },
                      ],
                    },
                  },
                ],
              },
              ...chunks.slice(0, 8),
            ],
            wait: gate.promise,
            tail: [
              ...chunks.slice(8),
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: { prompt_tokens: 10, completion_tokens: 71, total_tokens: 81 },
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "write code")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const deltas: { partID: string; field: string; delta: string }[] = []
        const states: Schema.Schema.Type<typeof MessageV2.ToolState>[] = []
        const order: string[] = []
        const v2: SessionEvent.Event[] = []
        const off = yield* bus.subscribeAllCallback((event: { type: string; properties: unknown }) => {
          if (
            event.type === MessageV2.Event.PartDelta.type &&
            Schema.is(MessageV2.Event.PartDelta.properties)(event.properties)
          ) {
            if (event.properties.messageID !== msg.id) return
            deltas.push(event.properties)
            order.push("delta")
            return
          }
          if (
            event.type !== MessageV2.Event.PartUpdated.type ||
            !Schema.is(MessageV2.Event.PartUpdated.properties)(event.properties)
          )
            return
          const part = event.properties.part
          if (part.messageID !== msg.id || part.type !== "tool") return
          states.push(part.state)
          order.push(part.state.status)
        })
        const offV2 = yield* events.sync((event) =>
          Effect.sync(() => {
            if (Schema.is(SessionEvent.All)(event) && event.data.sessionID === chat.id) v2.push(event)
          }),
        )
        yield* Effect.addFinalizer(() => Effect.sync(off))
        yield* Effect.addFinalizer(() => offV2)

        const run = yield* handle
          .process({
            user: parent,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "write code" }],
            tools: {
              code: tool({
                description: "Write code",
                inputSchema: z.object({ code: z.string() }),
                execute: async () => ({ title: "Code", metadata: {}, output: "tool output is not an input delta" }),
              }),
            },
          })
          .pipe(Effect.forkChild)

        yield* waitFor(
          Effect.sync(() => deltas[0]),
          "timed out waiting for live tool input",
        )
        expect(deltas[0]?.delta).toBe(source.slice(0, 8))
        expect(states).toEqual([{ status: "pending", input: {}, raw: "" }])
        const pending = MessageV2.parts(msg.id).find((part) => part.type === "tool")
        expect(pending?.state).toEqual({ status: "pending", input: {}, raw: "" })
        gate.resolve()

        expect(yield* Fiber.join(run)).toBe("continue")
        yield* waitFor(
          Effect.sync(() => states.find((state) => state.status === "completed")),
          "tool did not complete",
        )
        const call = MessageV2.parts(msg.id).find((part) => part.type === "tool")
        if (!call) throw new Error("missing tool part")
        const batches = deltas.map((event) => event.delta)
        expect(batches.join("")).toBe(source)
        expect(batches.length).toBeLessThan(chunks.length)
        expect(batches.some((delta) => delta.length === 64)).toBe(true)
        expect(batches.every((delta) => delta.length <= 64)).toBe(true)
        expect(deltas).toEqual(
          batches.map((delta) => ({
            sessionID: chat.id,
            messageID: msg.id,
            partID: call.id,
            field: "state.raw",
            delta,
          })),
        )
        expect(order).toEqual(["pending", ...batches.map(() => "delta"), "pending", "running", "completed"])
        expect(states[1]).toEqual({ status: "pending", input: {}, raw: source })
        expect(call.state.status).toBe("completed")
        expect(call.state.input).toEqual(input)
        expect(call.state).not.toHaveProperty("raw")
        expect(msg.tokens.output).toBe(71)
        expect(
          v2.filter((event) => event.type === SessionEvent.Tool.Input.Delta.type).map((event) => event.data.delta),
        ).toEqual(batches)
        expect(v2.find((event) => event.type === SessionEvent.Tool.Input.Ended.type)?.data.text).toBe(source)
        expect(
          v2
            .filter(
              (event) =>
                event.type.startsWith("session.next.tool.input.") || event.type === SessionEvent.Tool.Called.type,
            )
            .map((event) => event.type),
        ).toEqual([
          SessionEvent.Tool.Input.Started.type,
          ...batches.map(() => SessionEvent.Tool.Input.Delta.type),
          SessionEvent.Tool.Input.Ended.type,
          SessionEvent.Tool.Called.type,
        ])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor preserves tool metadata changed during input-end publication", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        yield* llm.tool("lookup", { query: "test" })
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const states: MessageV2.ToolPart["state"][] = []
        const off = yield* events.sync((event) =>
          Effect.gen(function* () {
            if (Schema.is(SessionEvent.Tool.Input.Ended)(event) && event.data.sessionID === chat.id) {
              // A tool can report running metadata while the input-end handler yields.
              yield* handle.updateToolCall(event.data.callID, (part) => ({
                ...part,
                state: {
                  status: "running",
                  input: { query: "test" },
                  title: "Task started",
                  metadata: { sessionId: "child-session" },
                  time: { start: Date.now() },
                },
              }))
            }
            if (Schema.is(SessionEvent.Tool.Called)(event) && event.data.sessionID === chat.id) {
              const part = MessageV2.parts(msg.id).find((part) => part.type === "tool")
              if (part) states.push(part.state)
            }
          }),
        )
        yield* Effect.addFinalizer(() => off)
        yield* handle.process({
          user: parent,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool" }],
          tools: {
            lookup: tool({
              description: "Look up information",
              inputSchema: z.object({ query: z.string() }),
              execute: async () => ({ title: "Done", output: "result", metadata: {} }),
            }),
          },
        })
        expect(states).toMatchObject([
          { status: "running", title: "Task started", metadata: { sessionId: "child-session" } },
        ])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests reset reasoning state across retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("one").reset(), reply().reason("two").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is MessageV2.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(reasoning.some((part) => part.text === "two")).toBe(true)
        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service

        yield* llm.error(503, { error: "boom" })
        // Non-empty success: an empty-text turn is now treated as a hollow
        // completion and retried, which would add an extra call to this count.
        yield* llm.text("recovered")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (evt.properties.status.type === "retry") states.push(evt.properties.status.attempt)
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        off()

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry transient gateway stream errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service

        // A gateway/proxy "internal server error" delivered with a non-5xx status the
        // SDK does not auto-mark retryable (so the old classifier halted). It must now
        // retry with backoff based on the transient message.
        yield* llm.error(418, { error: { message: "internal server error" } })
        yield* llm.text("recovered")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "gateway")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (evt.properties.status.type === "retry") states.push(evt.properties.status.attempt)
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "gateway" }],
          tools: {},
        })

        off()
        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
        expect(parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests complete AI SDK tool calls when native flag is off", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.tool("lookup", { query: "weather" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool" }],
          tools: {
            lookup: tool({
              description: "Look up information",
              inputSchema: z.object({ query: z.string() }),
              execute: async (input) => ({
                title: "Weather lookup",
                output: `result:${input.query}`,
                metadata: { source: "test" },
              }),
            }),
          },
        })

        const parts = MessageV2.parts(msg.id)
        const call = parts.find((part): part is MessageV2.ToolPart => part.type === "tool")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(call?.callID).toBe("call_1")
        expect(call?.tool).toBe("lookup")
        expect(call?.state.status).toBe("completed")
        if (call?.state.status !== "completed") return
        expect(call.state.input).toEqual({ query: "weather" })
        expect(call.state.output).toBe("result:weather")
        expect(call.state.title).toBe("Weather lookup")
        expect(call.state.metadata).toEqual({ source: "test" })
        expect(call.state.time.start).toBeDefined()
        expect(call.state.time.end).toBeDefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor flushes and persists separate pending tool inputs on cancellation", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service
        const events = yield* EventV2Bridge.Service
        const short = '{"cmd":"pw'
        const long = '{"cmd":"' + "a".repeat(64)
        const publishing = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))

        yield* llm.push(
          raw({
            chunks: [
              { index: 0, id: "call_short", type: "function", function: { name: "bash", arguments: "" } },
              { index: 1, id: "call_long", type: "function", function: { name: "bash", arguments: "" } },
              { index: 0, function: { arguments: short.slice(0, 1) } },
              { index: 0, function: { arguments: short.slice(1) } },
              { index: 1, function: { arguments: long } },
            ].map((call) => ({
              id: "chatcmpl-test",
              object: "chat.completion.chunk",
              choices: [{ delta: { tool_calls: [call] } }],
            })),
            hang: true,
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })
        const deltas: { partID: string; field: string; delta: string }[] = []
        const v2: (SessionEvent.Tool.Input.Delta | SessionEvent.Step.Failed)[] = []
        const off = yield* bus.subscribeCallback(MessageV2.Event.PartDelta, (event) => {
          if (event.properties.messageID === msg.id) deltas.push(event.properties)
        })
        const offV2 = yield* events.sync((event) =>
          Effect.gen(function* () {
            if (
              (Schema.is(SessionEvent.Tool.Input.Delta)(event) || Schema.is(SessionEvent.Step.Failed)(event)) &&
              event.data.sessionID === chat.id
            ) {
              // Cancel between the legacy and v2 publications of the same batch.
              if (event.type === SessionEvent.Tool.Input.Delta.type && event.data.delta === long) {
                yield* Deferred.succeed(publishing, undefined)
                yield* Deferred.await(release)
              }
              v2.push(event)
            }
          }),
        )
        yield* Effect.addFinalizer(() => Effect.sync(off))
        yield* Effect.addFinalizer(() => offV2)

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Deferred.await(publishing)
        yield* waitFor(
          Effect.sync(() => deltas.find((event) => event.delta === long)),
          "timed out waiting for long tool input",
        )
        expect(deltas[0]?.delta).toBe(short.slice(0, 1))
        expect(
          MessageV2.parts(msg.id)
            .filter((part) => part.type === "tool")
            .map((part) => part.state),
        ).toEqual([
          { status: "pending", input: {}, raw: "" },
          { status: "pending", input: {}, raw: "" },
        ])
        const interrupted = yield* Fiber.interrupt(run).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interrupted)

        const exit = yield* Fiber.await(run)
        const parts = MessageV2.parts(msg.id)
        const calls = parts.filter((part) => part.type === "tool")
        const call = calls.find((part) => part.callID === "call_short")
        const other = calls.find((part) => part.callID === "call_long")
        if (!call || !other) throw new Error("missing pending tool parts")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        expect(deltas.every((event) => event.field === "state.raw")).toBe(true)
        expect(
          deltas
            .filter((event) => event.partID === call.id)
            .map((event) => event.delta)
            .join(""),
        ).toBe(short)
        expect(
          deltas
            .filter((event) => event.partID === other.id)
            .map((event) => event.delta)
            .join(""),
        ).toBe(long)
        expect(
          v2
            .filter((event) => event.type === SessionEvent.Tool.Input.Delta.type)
            .map((event) => [event.data.callID, event.data.delta]),
        ).toEqual(deltas.map((event) => [event.partID === call.id ? "call_short" : "call_long", event.delta]))
        expect(v2.map((event) => event.type)).toEqual([
          ...deltas.map(() => SessionEvent.Tool.Input.Delta.type),
          SessionEvent.Step.Failed.type,
        ])
        const count = deltas.length
        yield* Effect.sleep("40 millis")
        expect(deltas).toHaveLength(count)
        expect(calls.map((part) => part.state)).toMatchObject([
          { status: "error", input: {}, raw: short },
          { status: "error", input: {}, raw: long },
        ])
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool execution aborted")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.time.end).toBeDefined()
        }
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests record aborted errors and idle state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* bus.subscribeCallback(Session.Event.Error, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (!evt.properties.error) return
          errs.push(evt.properties.error.name)
          seen.resolve()
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        yield* Effect.promise(() => seen.promise)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        off()

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark interruptions aborted without manual abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
      }),
    { config: (url) => providerCfg(url) },
  ),
)
