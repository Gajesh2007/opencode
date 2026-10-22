import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import type { LLMClientShape } from "@opencode-ai/llm/route"
import { LLMEvent, type LLMRequest } from "@opencode-ai/llm"
import { jsonSchema, tool } from "ai"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID, SessionID } from "@/session/schema"
import { LLMRequestPrep } from "@/session/llm/request"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { LLMWarm } from "@/session/llm/warm"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

function fixture() {
  const model: Provider.Model = {
    id: ModelID.make("gpt-6.1-sol"),
    providerID: ProviderID.openai,
    api: { id: "gpt-6.1-sol", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
    name: "GPT",
    options: { contextWarming: true },
    headers: {},
    status: "active",
    release_date: "2026-01-01",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128000, output: 32000 },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      interleaved: false,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
  }
  const provider: Provider.Info = {
    id: ProviderID.openai,
    name: "OpenAI",
    source: "config",
    env: [],
    models: {},
    options: { apiKey: "test-key" },
  }
  const selection: LLMWarm.Selection = {
    sessionID: "ses_warm",
    providerID: model.providerID,
    modelID: model.id,
    agent: "build",
  }
  return {
    native: true,
    selection,
    model,
    provider,
    auth: undefined,
    sessionID: selection.sessionID,
    user: {
      id: MessageID.make("msg_warm"),
      sessionID: SessionID.make(selection.sessionID),
      role: "user" as const,
      time: { created: 1 },
      agent: "build",
      model: { modelID: model.id, providerID: model.providerID },
      system: "PRIVATE_USER_SYSTEM",
    },
    agent: { name: "build", mode: "primary" as const, options: {}, permission: [], prompt: "PRIVATE_AGENT_PROMPT" },
    system: ["PRIVATE_MEMORY_AND_GOAL"],
    messages: [{ role: "user" as const, content: "PRIVATE_USER_PROMPT" }],
    tools: {
      lookup: tool({
        description: "Look up an item",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => "PRIVATE_EXECUTOR",
      }),
    },
    plugin: {
      init: () => Effect.void,
      list: () => Effect.succeed([]),
      trigger: <T>(_name: unknown, _input: unknown, output: T) => Effect.succeed(output),
    },
    flags: { client: "test" } as RuntimeFlags.Info,
    isWorkflow: false,
  }
}

it.effect("certifies only builtin text and schema tools, with no user data or closures", () =>
  Effect.gen(function* () {
    const input = fixture()
    const prepared = yield* LLMRequestPrep.prepare(input)
    const snapshot = LLMWarm.snapshot({ ...input, prepared })
    expect(snapshot).toBeDefined()
    expect(prepared.messages[0].providerOptions?.openai).toEqual({ promptCacheBreakpoint: { mode: "explicit" } })
    expect(prepared.messages[1].content).toContain("PRIVATE_USER_SYSTEM")
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_")
    expect(snapshot?.tools.lookup).not.toHaveProperty("execute")
    expect(snapshot?.tools.lookup.inputSchema).toMatchObject({ type: "object" })
  }),
)

for (const id of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-sol-2026-10-01"]) {
  it.effect(`defaults selected public OpenAI Ultrafast ${id} to certified context warming`, () =>
    Effect.gen(function* () {
      const input = fixture()
      input.model.api.id = id
      input.model.options = { serviceTier: "ultrafast" }
      const prepared = yield* LLMRequestPrep.prepare(input)
      expect(prepared.params.options.contextWarming).toBe(true)
      expect(prepared.warmPrefix).toBeDefined()
      expect(LLMWarm.snapshot({ ...input, prepared })).toBeUndefined()
    }),
  )
}

for (const option of ["model-false", "provider-false", "non-ultra", "other-model", "custom-endpoint"] as const) {
  it.effect(`does not default context warming for ${option}`, () =>
    Effect.gen(function* () {
      const input = fixture()
      input.model.api.id = option === "other-model" ? "gpt-5-mini" : "gpt-6.1-sol"
      input.model.options = { serviceTier: option === "non-ultra" ? "default" : "ultrafast" }
      if (option === "model-false") {
        input.model.options.contextWarming = false
        input.provider.options.contextWarming = true
      }
      if (option === "provider-false") input.provider.options.contextWarming = false
      if (option === "custom-endpoint") input.provider.options.baseURL = "https://example.com/v1"
      const prepared = yield* LLMRequestPrep.prepare(input)
      expect(prepared.params.options.contextWarming).toBe(false)
      expect(prepared.warmPrefix).toBeUndefined()
      expect(prepared.messages).toHaveLength(2)
      expect(prepared.messages[0].providerOptions).toBeUndefined()
      expect(prepared.messages[0].content).toContain("PRIVATE_USER_SYSTEM")
      expect(LLMWarm.snapshot({ ...input, prepared })).toBeUndefined()
    }),
  )
}

it.effect("uses the final selected tier rather than the model alias for the default", () =>
  Effect.gen(function* () {
    const input = fixture()
    input.model.api.id = "gpt-6.1-sol"
    input.model.options = {}
    input.model.serviceTiers = { ultrafast: { serviceTier: "ultrafast" } }
    const selected = yield* LLMRequestPrep.prepare({
      ...input,
      user: { ...input.user, model: { ...input.user.model, serviceTier: "ultrafast" } },
    })
    expect(selected.params.options.contextWarming).toBe(true)
    expect(selected.warmPrefix).toBeDefined()
    input.model.options.serviceTier = "ultrafast"
    const reset = yield* LLMRequestPrep.prepare({
      ...input,
      user: { ...input.user, model: { ...input.user.model, serviceTier: "default" } },
    })
    expect(reset.params.options.contextWarming).toBe(false)
    expect(reset.warmPrefix).toBeUndefined()
  }),
)

it.effect("rejects edited builtin prefixes, hosted tools, arbitrary options and oversize tool tables", () =>
  Effect.gen(function* () {
    const input = fixture()
    const prepared = yield* LLMRequestPrep.prepare(input)
    expect(LLMWarm.snapshot({ ...input, prepared: { ...prepared, warmPrefix: "PRIVATE_USER_SYSTEM" } })).toBeUndefined()
    expect(
      LLMWarm.snapshot({
        ...input,
        prepared: { ...prepared, params: { ...prepared.params, options: { instructions: "PRIVATE_INSTRUCTIONS" } } },
      }),
    ).toBeUndefined()
    expect(
      LLMWarm.snapshot({
        ...input,
        prepared: { ...prepared, tools: { lookup: { ...input.tools.lookup, description: "x".repeat(25_000) } } },
      }),
    ).toBeUndefined()
    expect(
      LLMWarm.snapshot({
        ...input,
        prepared: { ...prepared, tools: { lookup: { ...input.tools.lookup, description: "x".repeat(70_000) } } },
      }),
    ).toBeUndefined()
    expect(
      LLMWarm.snapshot({ ...input, prepared: { ...prepared, headers: { ...prepared.headers, plugin: "dynamic" } } }),
    ).toBeUndefined()
    const edited = yield* LLMRequestPrep.prepare({
      ...input,
      plugin: {
        ...input.plugin,
        trigger: (_name, _input, output) => {
          if (typeof output === "object" && output !== null && "system" in output && Array.isArray(output.system))
            output.system[0] += " changed"
          return Effect.succeed(output)
        },
      },
    })
    expect(edited.warmPrefix).toBeUndefined()
    expect(
      LLMWarm.snapshot({
        ...input,
        prepared: {
          ...prepared,
          tools: {
            lookup: { ...prepared.tools.lookup, strict: true },
          },
        },
      }),
    ).toBeUndefined()
    expect(LLMWarm.snapshot({ ...input, native: false, prepared })).toBeUndefined()
    expect(
      LLMWarm.snapshot({ ...input, model: { ...input.model, api: { ...input.model.api, id: "gpt-4o" } }, prepared }),
    ).toBeUndefined()
  }),
)

for (const toolChoice of [undefined, "auto", "required", "none"] as const) {
  it.effect(
    `native foreground and warm requests match tool tables, roles and ${toolChoice ?? "omitted"} choice`,
    () => {
      const sent: Record<string, unknown>[] = []
      return Effect.gen(function* () {
        const input = fixture()
        input.model.options.serviceTier = "default"
        input.model.options.transport = "websocket"
        const initial = yield* LLMRequestPrep.prepare(input)
        const prepared = { ...initial, tools: { ...initial.tools, invalid: input.tools.lookup } }
        const saved = LLMWarm.snapshot({ ...input, toolChoice, prepared })
        expect(saved).toBeDefined()
        if (!saved) return
        const client = yield* LLMClient.Service
        const native = {
          ...input,
          toolChoice,
          llmClient: client,
          messages: prepared.messages,
          tools: prepared.tools,
          headers: prepared.headers,
          providerOptions: prepared.params.options,
          abort: new AbortController().signal,
        }
        const foreground = LLMNativeRuntime.stream(native)
        expect(foreground.type).toBe("supported")
        if (foreground.type !== "supported") return
        yield* foreground.stream.pipe(Stream.runDrain)
        const warm = LLMNativeRuntime.warmRequest(
          {
            ...native,
            toolChoice: saved.toolChoice,
            messages: [
              {
                role: "system",
                content: saved.prefix,
                providerOptions: { openai: { promptCacheBreakpoint: { mode: "explicit" } } },
              },
            ],
            providerOptions: {
              ...saved.options,
              promptCacheOptions: { mode: "explicit", prewarm: true },
              store: false,
            },
          },
          saved.tools,
        )
        expect(warm).toBeDefined()
        if (!warm) return
        const compiled = yield* client.prepare<{ tools: unknown[]; input: unknown[]; tool_choice?: string }>(warm)
        expect(compiled.body.tools).toEqual(sent[0].tools as unknown[])
        expect(compiled.body.tools).toHaveLength(2)
        expect(compiled.body.input[0]).toEqual((sent[0].input as unknown[])[0])
        expect(compiled.body.input[0]).toMatchObject({ role: "developer" })
        expect(compiled.body.tool_choice).toBe(sent[0].tool_choice as string | undefined)
        expect(JSON.stringify(compiled.body)).not.toContain("PRIVATE_")
      }).pipe(
        Effect.provide(
          LLMClient.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(RequestExecutor.Service, {}),
                Layer.mock(WebSocketExecutor.Service, {
                  open: () =>
                    Effect.succeed({
                      sendText: (message) =>
                        Effect.sync(() => {
                          sent.push(JSON.parse(message))
                        }),
                      messages: Stream.empty,
                      close: Effect.void,
                    }),
                }),
              ),
            ),
          ),
        ),
      )
    },
  )
}

it.effect("connection preparation refuses custom endpoints and custom fetch without sending any model request", () =>
  Effect.gen(function* () {
    const input = fixture()
    const calls: LLMRequest[] = []
    const client = yield* LLMClient.Service
    expect(
      yield* LLMNativeRuntime.preconnect({
        ...input,
        llmClient: client,
        headers: {},
        abort: new AbortController().signal,
      }),
    ).toBe(true)
    expect(
      yield* LLMNativeRuntime.preconnect({
        ...input,
        provider: { ...input.provider, options: { apiKey: "test", baseURL: "https://example.com/v1" } },
        llmClient: client,
        headers: {},
        abort: new AbortController().signal,
      }),
    ).toBe(false)
    expect(
      yield* LLMNativeRuntime.preconnect({
        ...input,
        provider: { ...input.provider, options: { apiKey: "test", fetch: globalThis.fetch } },
        llmClient: client,
        headers: {},
        abort: new AbortController().signal,
      }),
    ).toBe(false)
    expect(calls).toHaveLength(0)
  }).pipe(
    Effect.provide(
      Layer.mock(LLMClient.Service, {
        preconnect: (request) => {
          expect(request.messages).toHaveLength(0)
          expect(request.system).toHaveLength(0)
          return Effect.void
        },
      }),
    ),
  ),
)

function harness(
  input: ReturnType<typeof fixture>,
  block = false,
  events = [LLMEvent.finish({ reason: "stop" })] as LLMEvent[],
) {
  const data = {
    requests: [] as LLMRequest[],
    retries: [] as number[],
    connections: 0,
    finished: 0,
    config: {} as Config.Info,
    started: [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()],
    cancelled: Deferred.makeUnsafe<void>(),
    blockConnection: false,
    holdCancellation: false,
    connectionStarted: Deferred.makeUnsafe<void>(),
    connectionCancelled: Deferred.makeUnsafe<void>(),
    releaseCancellation: Deferred.makeUnsafe<void>(),
  }
  const layer = LLMWarm.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Auth.Service, { get: () => Effect.succeed(undefined) }),
        Layer.mock(Config.Service, { get: () => Effect.sync(() => data.config) }),
        Layer.mock(Provider.Service, {
          getModel: () => Effect.succeed(input.model),
          getProvider: () => Effect.succeed(input.provider),
        }),
        Layer.mock(LLMClient.Service, {
          preconnect: () =>
            Effect.gen(function* () {
              data.connections++
              if (!data.blockConnection) return
              yield* Effect.acquireUseRelease(
                Effect.void,
                () => Deferred.succeed(data.connectionStarted, undefined).pipe(Effect.andThen(Effect.never)),
                () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(data.connectionCancelled, undefined)
                    if (data.holdCancellation) yield* Deferred.await(data.releaseCancellation)
                  }),
              )
            }),
          stream: ((request: LLMRequest | { request: LLMRequest }) =>
            Stream.unwrap(
              Effect.gen(function* () {
                if ("request" in request) throw new Error("Warm must not use executable tools")
                data.requests.push(request)
                data.retries.push(yield* RequestExecutor.RetryLimit)
                return Stream.fromEffect(
                  Effect.acquireUseRelease(
                    Effect.void,
                    () =>
                      Deferred.succeed(data.started[data.requests.length - 1], undefined).pipe(
                        Effect.andThen(block ? Effect.never : Effect.void),
                      ),
                    () =>
                      Effect.gen(function* () {
                        data.finished++
                        yield* Deferred.succeed(data.cancelled, undefined)
                      }),
                  ),
                ).pipe(Stream.drain, Stream.concat(Stream.fromIterable(events)))
              }),
            )) as LLMClientShape["stream"],
        }),
      ),
    ),
  )
  return { data, layer }
}

for (const enabled of [true, false]) {
  it.instance(
    `Ultrafast ${enabled ? "skips known unsupported paid prewarm" : "honors false despite selection.context"}`,
    () => {
      const input = fixture()
      input.model.api.id = "gpt-6.1-sol"
      input.model.options = { serviceTier: "ultrafast", ...(enabled ? {} : { contextWarming: false }) }
      const test = harness(input)
      return Effect.gen(function* () {
        const service = yield* LLMWarm.Service
        yield* service.capture({ ...input, prepared: yield* LLMRequestPrep.prepare(input) })
        yield* TestClock.adjust("15 minutes")
        const result = yield* service.warm({ ...input.selection, ...(enabled ? {} : { context: true }) })
        expect(result.context).toBe("skipped")
        expect(test.data.requests).toHaveLength(0)
      }).pipe(Effect.provide(test.layer), Effect.provide(TestClock.layer()))
    },
  )
}

it.instance("waits 15 minutes, emits HTTP prewarm with no user data, and disables retries", () => {
  const input = fixture()
  const test = harness(input)
  return Effect.gen(function* () {
    const service = yield* LLMWarm.Service
    yield* service.capture({ ...input, toolChoice: "none", prepared: yield* LLMRequestPrep.prepare(input) })
    expect(yield* service.warm(input.selection)).toEqual({ connection: "warmed", context: "fresh" })
    expect(test.data.requests).toHaveLength(0)
    yield* TestClock.adjust("15 minutes")
    expect((yield* service.warm(input.selection)).context).toBe("scheduled")
    yield* Deferred.await(test.data.started[0])
    expect(test.data.requests.length).toBe(1)
    expect(test.data.retries).toEqual([0])
    const request = test.data.requests[0]
    expect(request.model.route.transport.id).toBe("http-json")
    expect(request.providerOptions?.openai?.promptCacheOptions).toEqual({ mode: "explicit", prewarm: true })
    expect(request.providerOptions?.openai?.store).toBe(false)
    expect(request.messages).toHaveLength(0)
    expect(JSON.stringify({ system: request.system, tools: request.tools })).not.toContain("PRIVATE_")
    const wire = yield* LLMClient.prepare(request)
    expect(wire.body).toMatchObject({
      store: false,
      tool_choice: "none",
      prompt_cache_options: { mode: "explicit", prewarm: true },
      tools: [{ type: "function", name: "lookup" }],
    })
    expect(JSON.stringify(wire.body)).not.toContain("PRIVATE_")
    yield* Deferred.await(test.data.cancelled)
    yield* TestClock.adjust("61 seconds")
    expect((yield* service.warm(input.selection)).context).toBe("fresh")
  }).pipe(Effect.provide(test.layer), Effect.provide(TestClock.layer()))
})

it.instance("matches foreground and HTTP selection field ordering and omitted defaults", () => {
  const input = fixture()
  const test = harness(input)
  return Effect.gen(function* () {
    const service = yield* LLMWarm.Service
    yield* service.capture({
      ...input,
      selection: {
        sessionID: input.selection.sessionID,
        parentSessionID: undefined,
        providerID: input.model.providerID,
        modelID: input.model.id,
        agent: "build",
        variant: undefined,
        upstream: undefined,
      },
      prepared: yield* LLMRequestPrep.prepare(input),
    })
    yield* TestClock.adjust("15 minutes")
    expect(
      (yield* service.warm({
        providerID: input.model.providerID,
        modelID: input.model.id,
        agent: "build",
        upstream: "default",
        sessionID: input.selection.sessionID,
      })).context,
    ).toBe("scheduled")
    expect(test.data.requests).toHaveLength(1)
  }).pipe(Effect.provide(test.layer), Effect.provide(TestClock.layer()))
})

it.instance("interrupting the warm caller after connection cancels its paid stream", () => {
  const input = fixture()
  const test = harness(input, true)
  return Effect.gen(function* () {
    const service = yield* LLMWarm.Service
    yield* service.capture({ ...input, prepared: yield* LLMRequestPrep.prepare(input) })
    yield* TestClock.adjust("15 minutes")
    const call = yield* service.warm(input.selection).pipe(Effect.forkChild)
    yield* Deferred.await(test.data.started[0])
    expect(test.data.connections).toBe(1)
    expect(test.data.finished).toBe(0)
    yield* Fiber.interrupt(call)
    yield* Deferred.await(test.data.cancelled)
    expect(test.data.finished).toBe(1)
  }).pipe(Effect.provide(test.layer), Effect.provide(TestClock.layer()))
})

it.instance("the deadline interrupts the actual connection operation", () => {
  const input = fixture()
  const test = harness(input)
  test.data.blockConnection = true
  return Effect.gen(function* () {
    const service = yield* LLMWarm.Service
    const call = yield* service.warm(input.selection).pipe(Effect.forkChild)
    yield* Deferred.await(test.data.connectionStarted)
    yield* TestClock.adjust("10 seconds")
    yield* Deferred.await(test.data.connectionCancelled)
    yield* Fiber.await(call)
    expect(test.data.requests).toHaveLength(0)
  }).pipe(Effect.provide(test.layer), Effect.provide(TestClock.layer()))
})

it.instance("the deadline interrupts the actual paid stream", () => {
  const input = fixture()
  const test = harness(input, true)
  return Effect.gen(function* () {
    const service = yield* LLMWarm.Service
    yield* service.capture({ ...input, prepared: yield* LLMRequestPrep.prepare(input) })
    yield* TestClock.adjust("15 minutes")
    const call = yield* service.warm(input.selection).pipe(Effect.forkChild)
    yield* Deferred.await(test.data.started[0])
    yield* TestClock.adjust("10 seconds")
    yield* Deferred.await(test.data.cancelled)
    yield* Fiber.await(call)
    expect(test.data.finished).toBe(1)
  }).pipe(Effect.provide(test.layer), Effect.provide(TestClock.layer()))
})

it.instance("an interrupted older request cannot cancel the newer generation", () => {
  const input = fixture()
  const test = harness(input, true)
  test.data.blockConnection = true
  test.data.holdCancellation = true
  return Effect.gen(function* () {
    const service = yield* LLMWarm.Service
    const old = yield* service.warm(input.selection).pipe(Effect.forkChild)
    yield* Deferred.await(test.data.connectionStarted)
    yield* service.capture({ ...input, prepared: yield* LLMRequestPrep.prepare(input) })
    yield* Deferred.await(test.data.connectionCancelled)
    test.data.blockConnection = false
    yield* TestClock.adjust("15 minutes")
    const newer = yield* service.warm(input.selection).pipe(Effect.forkChild)
    yield* Deferred.await(test.data.started[0])
    yield* Fiber.interrupt(old)
    yield* Deferred.succeed(test.data.releaseCancellation, undefined)
    expect(test.data.finished).toBe(0)
    yield* Fiber.interrupt(newer)
    yield* Deferred.await(test.data.cancelled)
    expect(test.data.finished).toBe(1)
  }).pipe(Effect.provide(test.layer), Effect.provide(TestClock.layer()))
})

it.instance("bounds paid concurrency, retains duplicate jobs, and cancels on foreground capture", () => {
  const input = fixture()
  const test = harness(input, true)
  return Effect.gen(function* () {
    const service = yield* LLMWarm.Service
    const prepared = yield* LLMRequestPrep.prepare(input)
    for (const id of ["ses_one", "ses_two", "ses_three"]) {
      const next = { ...input, sessionID: id, selection: { ...input.selection, sessionID: id } }
      yield* service.capture({ ...next, prepared: yield* LLMRequestPrep.prepare(next) })
    }
    yield* TestClock.adjust("15 minutes")
    const one = { ...input.selection, sessionID: "ses_one" }
    const first = yield* service.warm(one).pipe(Effect.forkChild)
    yield* Deferred.await(test.data.started[0])
    expect((yield* service.warm(one)).context).toBe("busy")
    const second = yield* service.warm({ ...one, sessionID: "ses_two" }).pipe(Effect.forkChild)
    yield* Deferred.await(test.data.started[1])
    expect((yield* service.warm({ ...one, sessionID: "ses_three" })).context).toBe("busy")
    yield* Deferred.await(test.data.started[1])
    expect(test.data.requests.length).toBe(2)
    yield* service.capture({ ...input, selection: one, prepared })
    yield* Deferred.await(test.data.cancelled)
    expect(test.data.finished).toBe(1)
    yield* Fiber.interrupt(first)
    yield* Fiber.interrupt(second)
  }).pipe(Effect.provide(test.layer), Effect.provide(TestClock.layer()))
})

it.instance("skips configured plugins and throttles repeated connection warming", () => {
  const input = fixture()
  const test = harness(input)
  return Effect.gen(function* () {
    const service = yield* LLMWarm.Service
    expect((yield* service.warm(input.selection)).connection).toBe("warmed")
    expect((yield* service.warm({ ...input.selection, variant: "high" })).connection).toBe("skipped")
    expect(test.data.connections).toBe(1)
    test.data.config = { plugin: ["external-plugin"] }
    expect((yield* service.warm({ ...input.selection, sessionID: "ses_other" })).connection).toBe("skipped")
    expect(test.data.connections).toBe(1)
  }).pipe(Effect.provide(test.layer), Effect.provide(TestClock.layer()))
})

it.instance("rejects stale ownership and explicit cancellation clears retained context", () => {
  const input = fixture()
  const test = harness(input)
  return Effect.gen(function* () {
    const service = yield* LLMWarm.Service
    yield* service.capture({ ...input, prepared: yield* LLMRequestPrep.prepare(input) })
    yield* TestClock.adjust("15 minutes")
    input.provider.options.apiKey = "changed-key"
    expect((yield* service.warm(input.selection)).context).toBe("skipped")
    expect(test.data.requests).toHaveLength(0)
    yield* service.capture({ ...input, prepared: yield* LLMRequestPrep.prepare(input) })
    yield* service.cancel(input.selection.sessionID)
    yield* TestClock.adjust("15 minutes")
    expect((yield* service.warm(input.selection)).context).toBe("skipped")
    expect(test.data.requests).toHaveLength(0)
  }).pipe(Effect.provide(test.layer), Effect.provide(TestClock.layer()))
})

for (const events of [[], [LLMEvent.providerError({ message: "failed" })], [LLMEvent.textStart({ id: "text" })]]) {
  it.instance(`does not stamp freshness after ${events[0]?.type ?? "missing terminal"}`, () => {
    const input = fixture()
    const test = harness(input, false, events)
    return Effect.gen(function* () {
      const service = yield* LLMWarm.Service
      yield* service.capture({ ...input, prepared: yield* LLMRequestPrep.prepare(input) })
      yield* TestClock.adjust("15 minutes")
      expect((yield* service.warm(input.selection)).context).toBe("scheduled")
      yield* Deferred.await(test.data.cancelled)
      yield* TestClock.adjust("61 seconds")
      expect((yield* service.warm(input.selection)).context).toBe("scheduled")
    }).pipe(Effect.provide(test.layer), Effect.provide(TestClock.layer()))
  })
}

it.effect("resolves the direct Anthropic Messages endpoint for connection-only warming", () =>
  Effect.sync(() => {
    const base = fixture()
    const model: Provider.Model = {
      ...base.model,
      id: ModelID.make("claude-opus-5-5-fast"),
      providerID: ProviderID.anthropic,
      api: { id: "claude-opus-5-5", npm: "@ai-sdk/anthropic", url: "" },
      options: { speed: "fast" },
    }
    const provider: Provider.Info = { ...base.provider, id: ProviderID.anthropic, name: "Anthropic", options: {} }
    const previous = process.env.ANTHROPIC_BASE_URL
    delete process.env.ANTHROPIC_BASE_URL
    try {
      expect(LLMWarm.anthropicEndpoint(model, provider)).toBe("https://api.anthropic.com/v1/messages")
      // The SDK posts to `${baseURL}/messages`; warm the exact same host and path.
      expect(
        LLMWarm.anthropicEndpoint(model, {
          ...provider,
          options: { baseURL: "https://gateway.example.com/claude/v1/" },
        }),
      ).toBe("https://gateway.example.com/claude/v1/messages")
      // Plugin fetches, cleartext or credentialed endpoints, and other providers never warm.
      expect(LLMWarm.anthropicEndpoint(model, { ...provider, options: { fetch: () => undefined } })).toBeUndefined()
      expect(LLMWarm.anthropicEndpoint({ ...model, options: { fetch: () => undefined } }, provider)).toBeUndefined()
      expect(
        LLMWarm.anthropicEndpoint(model, { ...provider, options: { baseURL: "http://localhost:8080/v1" } }),
      ).toBeUndefined()
      expect(
        LLMWarm.anthropicEndpoint(model, { ...provider, options: { baseURL: "https://user:pw@example.com/v1" } }),
      ).toBeUndefined()
      expect(LLMWarm.anthropicEndpoint(base.model, base.provider)).toBeUndefined()
      expect(
        LLMWarm.anthropicEndpoint({ ...model, api: { ...model.api, npm: "@ai-sdk/openai-compatible" } }, provider),
      ).toBeUndefined()
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_BASE_URL = previous
    }
  }),
)
