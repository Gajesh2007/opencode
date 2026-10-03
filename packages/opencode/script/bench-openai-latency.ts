import { createOpenAI } from "@ai-sdk/openai"
import { streamText, type ModelMessage } from "ai"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import type { Provider } from "../src/provider/provider"
import { ModelID, ProviderID } from "../src/provider/schema"
import { LLMNativeRuntime } from "../src/session/llm/native-runtime"

// Sends synthetic context only; never reads a workspace or auth file.
const id = process.env.BENCH_MODEL ?? "gpt-5.2"
const turns = Number(process.env.BENCH_TURNS ?? 6)
if (!Number.isInteger(turns) || turns < 2 || turns > 30) throw new Error("BENCH_TURNS must be between 2 and 30")
const local = process.env.BENCH_LOCAL === "1"
const apiKey = local ? "local-benchmark-only" : process.env.OPENAI_API_KEY
if (!apiKey) throw new Error("OPENAI_API_KEY is required; this benchmark makes billable requests")
let sequence = 0
function response() {
  const responseId = `resp_${++sequence}`
  const item = { id: `msg_${sequence}`, type: "message", role: "assistant", content: [] }
  return [
    { type: "response.created", response: { id: responseId, model: id, created_at: 1 } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "OK" },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...item, content: [{ type: "output_text", text: "OK" }] },
    },
    {
      type: "response.completed",
      response: { id: responseId, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } },
    },
  ]
}
const server = local
  ? Bun.serve<{ previous?: string }>({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request, server) {
        if (server.upgrade(request, { data: {} })) return
        await request.json()
        return new Response(
          response()
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          {
            headers: { "content-type": "text/event-stream" },
          },
        )
      },
      websocket: {
        message(ws, message) {
          const request = JSON.parse(String(message))
          if (request.previous_response_id && request.previous_response_id !== ws.data.previous) {
            ws.send(
              JSON.stringify({ type: "error", code: "previous_response_not_found", message: "Missing socket state" }),
            )
            return
          }
          const events = response()
          ws.data.previous = events[0].response?.id
          for (const event of events) ws.send(JSON.stringify(event))
        },
      },
    })
  : undefined
const baseURL = server ? `${server.url}v1` : "https://api.openai.com/v1"
const options = { store: false, reasoningEffort: "low", textVerbosity: "low" }
const model: Provider.Model = {
  id: ModelID.make(id),
  providerID: ProviderID.openai,
  api: { id, npm: "@ai-sdk/openai", url: baseURL },
  name: id,
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
  limit: { context: 128_000, output: 512 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}
type Sample = { firstTextMs: number; totalMs: number; bytes: number; requests: number; incremental: boolean }
const modes = ["ai-sdk-http", "native-http", "native-ws", "native-ws-continuation"] as const
const states = modes.map((mode) => ({
  mode,
  messages: [
    { role: "system", content: "This is a latency test. Always reply with exactly OK. Do not reason or explain." },
    {
      role: "user",
      content: Array.from({ length: 256 }, (_, i) => `const item_${i} = ${i}; // synthetic benchmark context`).join(
        "\n",
      ),
    },
  ] as ModelMessage[],
  responseId: undefined as string | undefined,
  samples: [] as Sample[],
}))
const measure = { bytes: 0, requests: 0, incremental: false }
function sent(body: string) {
  measure.bytes += Buffer.byteLength(body)
  measure.requests++
  measure.incremental ||= typeof JSON.parse(body).previous_response_id === "string"
}
const measuredFetch: typeof fetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") sent(init.body)
    if (init?.body instanceof Uint8Array) sent(new TextDecoder().decode(init.body))
    return fetch(input, init)
  },
  { preconnect: fetch.preconnect },
)
const pool = WebSocketExecutor.pool()
const socket = WebSocketExecutor.Service.of({
  open: (request) =>
    pool.open(request).pipe(
      Effect.map((connection) => ({
        ...connection,
        sendText: (body) => Effect.sync(() => sent(body)).pipe(Effect.andThen(connection.sendText(body))),
      })),
    ),
})
const layers = LLMClient.layer.pipe(
  Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, Layer.succeed(WebSocketExecutor.Service, socket))),
)
const sdk = createOpenAI({ apiKey, baseURL, fetch: measuredFetch }).responses(id)
const continuation = LLMNativeRuntime.createContinuationState()

const exit = await Effect.runPromiseExit(
  Effect.gen(function* () {
    const client = yield* LLMClient.Service
    for (let turn = 0; turn < turns; turn++) {
      // Rotate order to reduce systematic cache/server-load bias between modes.
      for (let offset = 0; offset < states.length; offset++) {
        const state = states[(turn + offset) % states.length]
        state.messages.push({ role: "user", content: `Turn ${turn}: acknowledge with OK.` })
        Object.assign(measure, { bytes: 0, requests: 0, incremental: false })
        const start = performance.now()
        const output = { text: "", first: 0 }
        const abort = AbortSignal.timeout(60_000)
        if (state.mode === "ai-sdk-http") {
          const result = streamText({
            onError() {},
            model: sdk,
            messages: state.messages,
            providerOptions: { openai: options },
            maxOutputTokens: 512,
            maxRetries: 0,
            abortSignal: abort,
          })
          yield* Effect.promise(async () => {
            for await (const event of result.fullStream) {
              if (event.type === "error") throw event.error
              if (event.type !== "text-delta") continue
              if (!output.first) output.first = performance.now() - start
              output.text += event.text
            }
          })
        } else {
          const result = LLMNativeRuntime.stream({
            model,
            provider: {
              id: ProviderID.openai,
              name: "OpenAI",
              source: "config",
              env: [],
              models: {},
              options: {
                apiKey,
                baseURL,
                transport: state.mode === "native-http" ? "http" : "websocket",
                responsesContinuation: state.mode === "native-ws-continuation",
              },
            },
            auth: undefined,
            llmClient: client,
            continuation,
            sessionID: state.mode,
            previousResponseId: state.responseId,
            messages: state.messages,
            tools: {},
            providerOptions: options,
            maxOutputTokens: 512,
            headers: { "x-session-affinity": state.mode },
            abort,
          })
          if (result.type !== "supported") throw new Error(result.reason)
          yield* result.stream.pipe(
            Stream.provideService(FetchHttpClient.Fetch, measuredFetch),
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event.type === "provider-error") throw new Error(event.message)
                if (event.type === "text-delta") {
                  if (!output.first) output.first = performance.now() - start
                  output.text += event.text
                }
                if (event.type === "finish") {
                  const responseId = event.providerMetadata?.openai?.responseId
                  if (typeof responseId === "string") state.responseId = responseId
                }
              }),
            ),
            Effect.timeout("60 seconds"),
          )
        }
        if (!output.text) throw new Error(`${state.mode} returned no text; cannot measure first-text latency`)
        state.messages.push({ role: "assistant", content: output.text })
        const sample = { firstTextMs: output.first, totalMs: performance.now() - start, ...measure }
        state.samples.push(sample)
        console.log(JSON.stringify({ mode: state.mode, local, turn, model: id, ...sample }))
      }
    }
    for (const state of states) {
      const warm = state.samples.slice(1)
      const sorted = warm.map((sample) => sample.firstTextMs).sort((a, b) => a - b)
      console.log(
        JSON.stringify({
          summary: state.mode,
          local,
          model: id,
          warmSamples: warm.length,
          firstRequestTextMs: state.samples[0].firstTextMs,
          warmP50FirstTextMs: sorted[Math.floor(sorted.length * 0.5)],
          warmP95FirstTextMs: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
          meanRequestBytes: warm.reduce((sum, sample) => sum + sample.bytes, 0) / warm.length,
          incrementalRequests: warm.filter((sample) => sample.incremental).length,
        }),
      )
    }
  }).pipe(Effect.provide(layers)),
)
server?.stop(true)
// The benchmark owns the process; do not wait for idle pooled sockets to expire.
if (exit._tag === "Failure") {
  // Do not dump SDK request objects or authentication headers on failure.
  const { Cause } = await import("effect")
  console.error(Cause.pretty(exit.cause))
  process.exit(1)
}
process.exit(0)
