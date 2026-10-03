import { expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import { jsonSchema, tool, type ModelMessage, type Tool } from "ai"
import type { Plugin } from "@/plugin"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { ProviderTransform } from "@/provider/transform"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { LLMRequestPrep } from "@/session/llm/request"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  LLMClient.layer.pipe(
    Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.poolLayer({ idleTtlMillis: 1000 }))),
  ),
)
const model: Provider.Model = {
  id: ModelID.make("gpt-5-mini"),
  providerID: ProviderID.openai,
  api: { id: "gpt-5-mini", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
  name: "GPT-5 Mini",
  capabilities: {
    temperature: true,
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
const user = (content: string): ModelMessage => ({ role: "user", content })
const assistant = (content: string): ModelMessage => ({ role: "assistant", content })
const sse = (events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  })
const completed = (id: string) => ({ type: "response.completed", response: { id } })
const text = (id: string, value = "hello") =>
  sse([{ type: "response.output_text.delta", item_id: "msg", delta: value }, completed(id)])
const stale = { type: "error", code: "previous_response_not_found", message: "No cached response" }
const call = { type: "tool-call" as const, toolCallId: "call_1", toolName: "lookup", input: {} }
const toolResponse = (id: string) =>
  sse([
    {
      type: "response.output_item.done",
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}" },
    },
    completed(id),
  ])
const result: ModelMessage = {
  role: "tool",
  content: [
    { type: "tool-result", toolCallId: "call_1", toolName: "lookup", output: { type: "text", value: "found" } },
  ],
}

const setup = Effect.fn(function* (responses: Response[]) {
  const bodies: Record<string, unknown>[] = []
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 0,
        async fetch(request) {
          bodies.push((await request.json()) as Record<string, unknown>)
          return responses.shift() ?? new Response("Unexpected request", { status: 500 })
        },
      }),
    ),
    (server) => Effect.sync(() => server.stop(true)),
  )
  const client = yield* LLMClient.Service
  const continuation = LLMNativeRuntime.createContinuationState()
  const executions = { count: 0 }
  const tools = {
    lookup: tool({
      description: "Look up",
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async () => {
        executions.count++
        return "found"
      },
    }),
  }
  const send = Effect.fn(function* (
    messages: ModelMessage[],
    previousResponseId?: string,
    overrides: {
      system?: string
      tools?: Record<string, Tool>
      model?: Provider.Model
      sessionID?: string
      options?: Record<string, unknown>
    } = {},
  ) {
    const selected = overrides.model ?? model
    const sessionID = SessionID.make(overrides.sessionID ?? "ses_continuation")
    const provider: Provider.Info = {
      id: ProviderID.openai,
      name: "OpenAI",
      source: "config",
      env: [],
      models: {},
      options: {
        apiKey: "test-key",
        baseURL: server.url.toString(),
        responsesContinuation: true,
        ...overrides.options,
      },
    }
    const prepared = yield* LLMRequestPrep.prepare({
      model: selected,
      provider,
      sessionID,
      previousResponseId,
      user: {
        id: MessageID.make("msg_test"),
        sessionID,
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: selected.providerID, modelID: selected.id },
      },
      agent: { name: "build", mode: "primary", permission: [], options: {} },
      system: [overrides.system ?? "Keep context"],
      messages,
      tools: overrides.tools ?? tools,
      auth: undefined,
      isWorkflow: false,
      plugin: {
        init: () => Effect.void,
        list: () => Effect.succeed([]),
        trigger: ((_name: unknown, _input: unknown, output: unknown) =>
          Effect.succeed(output)) as Plugin.Interface["trigger"],
      },
      flags: { client: "test" } as RuntimeFlags.Info,
    })
    // The shared AI SDK path must never receive the automatic pointer.
    expect(ProviderTransform.providerOptions(selected, prepared.params.options).openai).not.toHaveProperty(
      "previousResponseId",
    )
    const native = LLMNativeRuntime.stream({
      model: selected,
      provider,
      auth: undefined,
      llmClient: client,
      continuation,
      sessionID,
      previousResponseId,
      messages: prepared.messages,
      tools: prepared.tools,
      providerOptions: prepared.params.options,
      headers: prepared.headers,
      abort: new AbortController().signal,
    })
    if (native.type !== "supported") throw new Error(native.reason)
    return yield* Stream.runCollect(native.stream)
  })
  return { bodies, send, tools, executions, continuation }
})

it.live("continues multiple tool steps and turns with only the verified suffix and current tools", () =>
  Effect.gen(function* () {
    const test = yield* setup([toolResponse("resp_1"), text("resp_2", "found it"), text("resp_3", "next")])
    const history = [user("search")]
    yield* test.send(history)
    history.push({ role: "assistant", content: [call] }, result)
    yield* test.send(history, "resp_1")
    history.push(assistant("found it"), user("next"))
    yield* test.send(history, "resp_2")
    expect(test.executions.count).toBe(1)
    expect(test.bodies[1]).toMatchObject({
      previous_response_id: "resp_1",
      store: false,
      input: [{ type: "function_call_output", call_id: "call_1", output: "found" }],
      tools: [{ name: "lookup" }],
    })
    expect(test.bodies[2]).toMatchObject({
      previous_response_id: "resp_2",
      store: false,
      input: [{ role: "user", content: [{ type: "input_text", text: "next" }] }],
    })
    expect(JSON.stringify(test.bodies[1]).length).toBeLessThan(JSON.stringify(test.bodies[0]).length)
  }),
)

for (const mode of ["http", "stream", "failed"] as const) {
  it.live(`retries ${mode} stale response errors once with full history before tool execution`, () =>
    Effect.gen(function* () {
      const error =
        mode === "http"
          ? new Response(JSON.stringify({ error: { code: stale.code, message: stale.message } }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            })
          : sse(
              mode === "failed"
                ? [{ type: "response.failed", response: { error: { code: stale.code, message: stale.message } } }]
                : [stale],
            )
      const test = yield* setup([text("resp_1"), error, toolResponse("resp_2")])
      yield* test.send([user("first")])
      const events = yield* test.send([user("first"), assistant("hello"), user("search")], "resp_1")
      expect(test.bodies).toHaveLength(3)
      expect(test.bodies[1].previous_response_id).toBe("resp_1")
      expect(test.bodies[2]).not.toHaveProperty("previous_response_id")
      expect(test.bodies[2]).toMatchObject({ store: false, tools: [{ name: "lookup" }] })
      expect(test.bodies[2].input).toHaveLength(4)
      expect(test.executions.count).toBe(1)
      expect(events.filter((event) => event.type === "provider-error")).toHaveLength(0)
    }),
  )
}

it.live("resends changed tool schemas and empty tool sets without losing context", () =>
  Effect.gen(function* () {
    const test = yield* setup([text("resp_1"), text("resp_2"), text("resp_3")])
    yield* test.send([user("first")])
    const history = [user("first"), assistant("hello"), user("second")]
    yield* test.send(history, "resp_1", {
      tools: {
        updated: tool({
          description: "Changed",
          inputSchema: jsonSchema({ type: "object", properties: { changed: { type: "boolean" } } }),
        }),
      },
    })
    expect(test.bodies[1]).toMatchObject({
      previous_response_id: "resp_1",
      tools: [
        { name: "updated", description: "Changed", parameters: { properties: { changed: { type: "boolean" } } } },
      ],
    })
    yield* test.send([...history, assistant("hello"), user("third")], "resp_2", { tools: {} })
    expect(test.bodies[2]).toMatchObject({ previous_response_id: "resp_2", tools: [] })
  }),
)

for (const change of [
  "system",
  "model",
  "key",
  "session",
  "prefix",
  "assistant",
  "unknown",
  "disabled",
  "default",
  "model-opt-out",
] as const) {
  it.live(`uses full history for changed ${change}`, () =>
    Effect.gen(function* () {
      const test = yield* setup([text("resp_1"), text("resp_2")])
      yield* test.send([user("first")])
      yield* test.send(
        [
          user(change === "prefix" ? "edited" : "first"),
          assistant(change === "assistant" ? "edited" : "hello"),
          user("second"),
        ],
        change === "unknown" ? "resp_unknown" : "resp_1",
        {
          system: change === "system" ? "New system" : undefined,
          model:
            change === "model"
              ? { ...model, api: { ...model.api, id: "gpt-5" } }
              : change === "model-opt-out"
                ? { ...model, options: { responsesContinuation: false } }
                : undefined,
          sessionID: change === "session" ? "ses_other" : undefined,
          options:
            change === "key"
              ? { apiKey: "different" }
              : change === "disabled"
                ? { responsesContinuation: false }
                : change === "default"
                  ? { responsesContinuation: undefined }
                  : undefined,
        },
      )
      expect(test.bodies[1]).not.toHaveProperty("previous_response_id")
      expect(test.bodies[1].input).toHaveLength(4)
      if (change === "system") expect(JSON.stringify(test.bodies[1].input)).toContain("New system")
    }),
  )
}

it.live("never retries after output and invalidates the consumed receipt", () =>
  Effect.gen(function* () {
    const test = yield* setup([
      text("resp_1"),
      sse([{ type: "response.output_text.delta", item_id: "msg", delta: "partial" }, stale]),
      text("resp_3"),
    ])
    yield* test.send([user("first")])
    const history = [user("first"), assistant("hello"), user("second")]
    const events = yield* test.send(history, "resp_1")
    expect(events.some((event) => event.type === "provider-error")).toBe(true)
    expect(test.bodies).toHaveLength(2)
    expect(test.continuation.size).toBe(0)
    yield* test.send(history, "resp_1")
    expect(test.bodies[2]).not.toHaveProperty("previous_response_id")
  }),
)

it.live("does not retry a failing full-history fallback", () =>
  Effect.gen(function* () {
    const test = yield* setup([text("resp_1"), sse([stale]), sse([stale])])
    yield* test.send([user("first")])
    const events = yield* test.send([user("first"), assistant("hello"), user("second")], "resp_1")
    expect(test.bodies).toHaveLength(3)
    expect(events.filter((event) => event.type === "provider-error")).toHaveLength(1)
    expect(test.continuation.size).toBe(0)
  }),
)

it.live("bounds retained receipts across sessions", () =>
  Effect.gen(function* () {
    const test = yield* setup(Array.from({ length: 130 }, (_, index) => text(`resp_${index}`)))
    for (let index = 0; index < 130; index++)
      yield* test.send([user("first")], undefined, { sessionID: `ses_${index}` })
    expect(test.continuation.size).toBe(128)
    expect(test.continuation.has("ses_0")).toBe(false)
    expect(test.continuation.has("ses_129")).toBe(true)
  }),
)

it.live("cancellation invalidates an in-flight receipt", () =>
  Effect.gen(function* () {
    const test = yield* setup([
      text("resp_1"),
      new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } }),
    ])
    yield* test.send([user("first")])
    yield* test
      .send([user("first"), assistant("hello"), user("second")], "resp_1")
      .pipe(Effect.timeout("100 millis"), Effect.exit)
    expect(test.bodies).toHaveLength(2)
    expect(test.continuation.size).toBe(0)
  }),
)

it.live("shared preparation strips manually configured response IDs", () =>
  Effect.gen(function* () {
    const test = yield* setup([text("resp_1")])
    yield* test.send([user("first")], "resp_untrusted", {
      model: {
        ...model,
        options: { previousResponseId: "resp_untrusted", openai: { previousResponseId: "resp_nested" } },
      },
    })
    expect(test.bodies[0]).not.toHaveProperty("previous_response_id")
  }),
)

for (const scenario of [
  "empty reasoning",
  "out-of-order parallel tools",
  "edited encrypted reasoning",
  "removed encrypted reasoning",
  "edited reasoning item id",
  "removed reasoning part",
] as const) {
  it.live(`continues real session message conversion with ${scenario}`, () =>
    Effect.gen(function* () {
      const ids = scenario === "out-of-order parallel tools" ? ["call_1", "call_2"] : ["call_1"]
      const test = yield* setup([
        sse([
          ...(scenario !== "out-of-order parallel tools"
            ? [
                {
                  type: "response.output_item.done",
                  item: { type: "reasoning", id: "rs_1", encrypted_content: "encrypted" },
                },
              ]
            : []),
          ...ids.map((id) => ({
            type: "response.output_item.added",
            item: { type: "function_call", id: `fc_${id}`, call_id: id, name: "lookup", arguments: "" },
          })),
          ...ids.toReversed().map((id) => ({
            type: "response.output_item.done",
            item: { type: "function_call", id: `fc_${id}`, call_id: id, name: "lookup", arguments: "{}" },
          })),
          completed("resp_1"),
        ]),
        text("resp_2"),
      ])
      const sessionID = SessionID.make("ses_continuation")
      const userID = MessageID.make("msg_user")
      const assistantID = MessageID.make("msg_assistant")
      const messages: MessageV2.WithParts[] = [
        {
          info: {
            id: userID,
            sessionID,
            role: "user",
            time: { created: 1 },
            agent: "build",
            model: { modelID: model.id, providerID: model.providerID },
          },
          parts: [{ id: PartID.make("prt_user"), sessionID, messageID: userID, type: "text", text: "search" }],
        },
      ]
      const events = yield* test.send(yield* MessageV2.toModelMessagesEffect(messages, model))
      const parts: MessageV2.WithParts["parts"] = []
      for (const event of events) {
        const base = { id: PartID.make(`prt_${parts.length}`), sessionID, messageID: assistantID }
        if (event.type === "reasoning-start")
          parts.push({ ...base, type: "reasoning", text: "", time: { start: 1 }, metadata: event.providerMetadata })
        if (event.type === "reasoning-end") {
          const part = parts.findLast((part) => part.type === "reasoning")
          if (part?.type === "reasoning") part.metadata = event.providerMetadata
        }
        if (event.type === "tool-input-start")
          parts.push({
            ...base,
            type: "tool",
            tool: event.name,
            callID: event.id,
            state: {
              status: "completed",
              input: {},
              output: "found",
              title: "lookup",
              metadata: {},
              time: { start: 1, end: 2 },
            },
          })
      }
      const reasoning = parts.find((part) => part.type === "reasoning")
      if (reasoning?.metadata?.openai) {
        if (scenario === "edited encrypted reasoning") reasoning.metadata.openai.reasoningEncryptedContent = "edited"
        if (scenario === "removed encrypted reasoning") delete reasoning.metadata.openai.reasoningEncryptedContent
        if (scenario === "edited reasoning item id") reasoning.metadata.openai.itemId = "rs_edited"
      }
      if (scenario === "removed reasoning part") parts.splice(0, 1)
      messages.push({
        info: {
          id: assistantID,
          sessionID,
          role: "assistant",
          parentID: userID,
          time: { created: 2 },
          agent: "build",
          mode: "build",
          providerID: model.providerID,
          modelID: model.id,
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "tool-calls",
          provider_response_id: "resp_1",
        },
        parts,
      })
      yield* test.send(yield* MessageV2.toModelMessagesEffect(messages, model), "resp_1")
      if (scenario === "empty reasoning" || scenario === "out-of-order parallel tools") {
        expect(test.bodies[1].previous_response_id).toBe("resp_1")
        expect(test.bodies[1].input).toEqual(
          ids.map((id) => ({ type: "function_call_output", call_id: id, output: "found" })),
        )
        return
      }
      expect(test.bodies[1]).not.toHaveProperty("previous_response_id")
      expect(JSON.stringify(test.bodies[1].input)).toContain("search")
    }),
  )
}

it.live("does not replay a tool call followed by a stale-response error", () =>
  Effect.gen(function* () {
    const test = yield* setup([
      text("resp_1"),
      sse([
        {
          type: "response.output_item.done",
          item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}" },
        },
        stale,
      ]),
    ])
    yield* test.send([user("first")])
    const events = yield* test.send([user("first"), assistant("hello"), user("second")], "resp_1")
    expect(test.bodies).toHaveLength(2)
    expect(events.filter((event) => event.type === "tool-call")).toHaveLength(1)
    expect(events.filter((event) => event.type === "provider-error")).toHaveLength(1)
    expect(test.continuation.size).toBe(0)
  }),
)

it.live("recovers native WebSocket continuation after reconnect with one full-history fallback", () =>
  Effect.gen(function* () {
    const requests: Array<{ connection: number; body: Record<string, unknown> }> = []
    const connections: number[] = []
    const closed = new Set<number>()
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve<{ id: number; responses: Set<string> }>({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request, server) {
            if (server.upgrade(request, { data: { id: connections.length + 1, responses: new Set() } })) return
            return new Response("WebSocket required", { status: 426 })
          },
          websocket: {
            open(socket) {
              connections.push(socket.data.id)
            },
            message(socket, message) {
              const body = JSON.parse(String(message)) as Record<string, unknown>
              requests.push({ connection: socket.data.id, body })
              if (
                typeof body.previous_response_id === "string" &&
                !socket.data.responses.has(body.previous_response_id)
              ) {
                socket.send(JSON.stringify(stale))
                return
              }
              const id = `resp_${requests.length}`
              socket.data.responses.add(id)
              socket.send(
                JSON.stringify({
                  type: "response.output_text.delta",
                  item_id: `msg_${requests.length}`,
                  delta: `answer_${requests.length}`,
                }),
              )
              socket.send(JSON.stringify(completed(id)))
            },
            close(socket) {
              closed.add(socket.data.id)
            },
          },
        }),
      ),
      (server) =>
        Effect.sync(() => {
          void server.stop(true)
        }),
    )
    const test = yield* setup([])
    const options = { transport: "websocket", baseURL: server.url.toString() }
    const history = [user("first")]
    yield* test.send(history, undefined, { options })
    history.push(assistant("answer_1"), user("second"))
    yield* test.send(history, "resp_1", { options })
    expect(requests.map((request) => request.connection)).toEqual([1, 1])
    expect(requests[1].body).toMatchObject({
      previous_response_id: "resp_1",
      input: [{ role: "user", content: [{ type: "input_text", text: "second" }] }],
    })

    // Let the real pool evict the idle socket and observe the close handshake,
    // rather than assuming a server-initiated close has reached the client.
    yield* pollWithTimeout(
      Effect.sync(() => (closed.has(1) ? true : undefined)),
      "initial WebSocket did not close",
    )
    const tools = {
      lookup: tool({
        description: "Current tools",
        inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } } }),
      }),
    }
    history.push(assistant("answer_2"), user("third"))
    const recovered = yield* test.send(history, "resp_2", { options, tools })
    expect(requests).toHaveLength(4)
    expect(requests[2]).toMatchObject({
      connection: 2,
      body: {
        previous_response_id: "resp_2",
        input: [{ role: "user", content: [{ type: "input_text", text: "third" }] }],
      },
    })
    expect(requests[3].connection).toBe(2)
    expect(requests[3].body).not.toHaveProperty("previous_response_id")
    expect(requests[3].body.input).toEqual([
      expect.objectContaining({ role: "system" }),
      { role: "user", content: [{ type: "input_text", text: "first" }] },
      { role: "assistant", content: [{ type: "output_text", text: "answer_1" }] },
      { role: "user", content: [{ type: "input_text", text: "second" }] },
      { role: "assistant", content: [{ type: "output_text", text: "answer_2" }] },
      { role: "user", content: [{ type: "input_text", text: "third" }] },
    ])
    expect(recovered.filter((event) => event.type === "provider-error")).toHaveLength(0)
    expect(recovered.filter((event) => event.type === "text-delta").map((event) => event.text)).toEqual(["answer_4"])

    history.push(assistant("answer_4"), user("fourth"))
    yield* test.send(history, "resp_4", { options, tools })
    expect(connections).toHaveLength(2)
    expect(requests.map((request) => request.connection)).toEqual([1, 1, 2, 2, 2])
    expect(requests[4].body).toMatchObject({
      previous_response_id: "resp_4",
      input: [{ role: "user", content: [{ type: "input_text", text: "fourth" }] }],
    })
    for (const request of requests) expect(request.body).toMatchObject({ type: "response.create", store: false })
    for (const request of requests.slice(2))
      expect(request.body.tools).toEqual([
        {
          type: "function",
          name: "lookup",
          description: "Current tools",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      ])
    expect(test.bodies).toHaveLength(0)
  }).pipe(Effect.timeout("10 seconds")),
)
