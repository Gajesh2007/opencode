import { expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import type { ModelMessage } from "ai"
import { OAUTH_DUMMY_KEY } from "@/auth"
import { CodexAuthPlugin } from "@/plugin/codex"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.poolLayer()))),
)
const model: Provider.Model = {
  id: ModelID.make("gpt-5.5"),
  providerID: ProviderID.openaiCodex,
  api: { id: "gpt-5.5", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
  name: "Codex",
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
const user = (content: string): ModelMessage => ({ role: "user", content })
const assistant = (content: string): ModelMessage => ({ role: "assistant", content })
const stale = { type: "error", code: "previous_response_not_found", param: null, message: "Expired response" }
const output = (id: string) => [
  { type: "response.output_text.delta", item_id: "msg", delta: id },
  { type: "response.completed", response: { id } },
]

const setup = Effect.fn(function* () {
  const requests: Array<{ body: Record<string, unknown>; connection: number }> = []
  const handshakes: Headers[] = []
  const http: Headers[] = []
  const control = { stale: false, partial: false, refreshes: 0 }
  const auth = {
    current: {
      type: "oauth" as const,
      access: "access-1",
      refresh: "refresh-1",
      expires: Date.now() + 60000,
      accountId: "account-1",
    },
  }
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve<{ connection: number }>({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request, server) {
          if (new URL(request.url).pathname === "/oauth/token") {
            control.refreshes++
            return Response.json({
              access_token: "access-refreshed",
              refresh_token: "refresh-2",
              expires_in: 3600,
              id_token: `e30.${Buffer.from(JSON.stringify({ chatgpt_account_id: "account-refreshed" })).toString("base64url")}.sig`,
            })
          }
          expect(new URL(request.url).pathname).toBe("/backend-api/codex/responses")
          if (request.headers.get("upgrade") === "websocket") {
            handshakes.push(request.headers)
            if (server.upgrade(request, { data: { connection: handshakes.length } })) return
          }
          http.push(request.headers)
          requests.push({ body: (await request.json()) as Record<string, unknown>, connection: 0 })
          return new Response(
            output(`resp_${requests.length}`)
              .map((item) => `data: ${JSON.stringify(item)}\n\n`)
              .join(""),
            {
              headers: { "Content-Type": "text/event-stream" },
            },
          )
        },
        websocket: {
          message(socket, message) {
            const body = JSON.parse(String(message)) as Record<string, unknown>
            requests.push({ body, connection: socket.data.connection })
            if (control.stale && body.previous_response_id) {
              if (control.partial) socket.send(JSON.stringify(output("partial")[0]))
              socket.send(JSON.stringify(stale))
              return
            }
            output(`resp_${requests.length}`).forEach((item) => socket.send(JSON.stringify(item)))
          },
        },
      }),
    ),
    (server) =>
      Effect.sync(() => {
        void server.stop(true)
      }),
  )
  const hooks = yield* Effect.promise(() =>
    CodexAuthPlugin(
      {
        client: {
          auth: {
            set: async (input: { body: typeof auth.current }) => {
              auth.current = input.body
            },
          },
        },
      } as never,
      { issuer: server.url.origin, codexApiEndpoint: `${server.url.origin}/backend-api/codex/responses` },
    ),
  )
  const options = yield* Effect.promise(() => hooks.auth!.loader!(async () => auth.current, {} as never))
  const client = yield* LLMClient.Service
  const continuation = LLMNativeRuntime.createContinuationState()
  const send = (messages: ModelMessage[], previousResponseId?: string, overrides: Record<string, unknown> = {}) => {
    const native = LLMNativeRuntime.stream({
      model,
      provider: {
        id: ProviderID.openaiCodex,
        name: "Codex",
        env: [],
        source: "config",
        models: {},
        options: { ...options, transport: "websocket", responsesContinuation: true, ...overrides },
      },
      // Deliberately a stale snapshot: the plugin, not the caller, owns fresh auth.
      auth: { type: "oauth", access: "stale", refresh: "stale", expires: 0 },
      continuation,
      sessionID: "session",
      previousResponseId,
      llmClient: client,
      messages,
      tools: {},
      headers: { Authorization: `Bearer ${OAUTH_DUMMY_KEY}`, "ChatGPT-Account-Id": "wrong" },
      providerOptions: { store: false, instructions: "Be concise" },
      abort: new AbortController().signal,
    })
    if (native.type !== "supported") throw new Error(native.reason)
    return native.stream.pipe(Stream.runCollect)
  }
  return { requests, handshakes, http, auth, control, send, continuation, options }
})

it.live(
  "Codex OAuth uses fresh handshake auth, reuses sockets, and invalidates ownership after refresh/account changes",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const history = [user("first")]
      yield* test.send(history)
      history.push(assistant("resp_1"), user("second"))
      yield* test.send(history, "resp_1")
      expect(test.requests.map((item) => item.connection)).toEqual([1, 1])
      expect(test.requests[1].body.previous_response_id).toBe("resp_1")
      expect(test.handshakes[0].get("authorization")).toBe("Bearer access-1")
      expect(test.handshakes[0].get("chatgpt-account-id")).toBe("account-1")
      expect(test.handshakes[0].get("openai-beta")).toBe("responses_websockets=2026-02-06")
      test.auth.current = { ...test.auth.current, expires: 0 }
      history.push(assistant("resp_2"), user("third"))
      yield* test.send(history, "resp_2")
      expect(test.control.refreshes).toBe(1)
      expect(test.handshakes[1].get("authorization")).toBe("Bearer access-refreshed")
      expect(test.handshakes[1].get("chatgpt-account-id")).toBe("account-refreshed")
      expect(test.requests[2].body).not.toHaveProperty("previous_response_id")
      expect(test.requests[2].body.input).toHaveLength(5)
      test.auth.current = { ...test.auth.current, accountId: "switched-account" }
      history.push(assistant("resp_3"), user("fourth"))
      yield* test.send(history, "resp_3")
      expect(test.handshakes[2].get("chatgpt-account-id")).toBe("switched-account")
      expect(test.requests[3].body).not.toHaveProperty("previous_response_id")
      expect(test.requests[3].body.input).toHaveLength(7)
      expect(test.http).toHaveLength(0)
      expect(JSON.stringify(test.requests)).not.toContain(OAUTH_DUMMY_KEY)
    }),
)

it.live("Codex stale continuation retries full context once, but never retries after output", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    const history = [user("first")]
    yield* test.send(history)
    history.push(assistant("resp_1"), user("second"))
    test.control.stale = true
    yield* test.send(history, "resp_1")
    expect(test.requests).toHaveLength(3)
    expect(test.requests[1].body.previous_response_id).toBe("resp_1")
    expect(test.requests[2].body).not.toHaveProperty("previous_response_id")
    expect(test.requests[2].body.instructions).toBe("Be concise")
    expect(test.requests[2].body.input).toHaveLength(3)
    history.push(assistant("resp_3"), user("third"))
    test.control.partial = true
    const events = yield* test.send(history, "resp_3")
    expect(test.requests).toHaveLength(4)
    expect(events.some((event) => event.type === "provider-error")).toBe(true)
    expect(test.continuation.size).toBe(0)
  }),
)

it.live("Codex HTTP fallback keeps fresh OAuth headers and refuses untrusted endpoints", () =>
  Effect.gen(function* () {
    const test = yield* setup()
    test.auth.current = { ...test.auth.current, expires: 0 }
    yield* test.send([user("http")], undefined, { transport: undefined })
    expect(test.http).toHaveLength(1)
    expect(test.http[0].get("authorization")).toBe("Bearer access-refreshed")
    expect(test.http[0].get("chatgpt-account-id")).toBe("account-refreshed")
    expect(test.handshakes).toHaveLength(0)
    const failed = yield* test
      .send([user("untrusted")], undefined, { baseURL: "https://untrusted.invalid/v1" })
      .pipe(Effect.exit)
    expect(failed._tag).toBe("Failure")
    expect(test.http).toHaveLength(1)
    expect(test.handshakes).toHaveLength(0)
    const fetch = test.options.fetch as typeof globalThis.fetch
    yield* Effect.promise(async () => {
      await expect(
        fetch("https://untrusted.invalid/v1/responses", { headers: { authorization: OAUTH_DUMMY_KEY } }),
      ).rejects.toThrow("untrusted endpoint")
    })
  }),
)
