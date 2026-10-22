import path from "node:path"
import os from "node:os"
import { parse } from "jsonc-parser"
import { Effect } from "effect"
import { mergeDeep } from "remeda"
import { Auth } from "../src/auth"
import { ConfigVariable } from "../src/config/variable"
import { sse } from "./bench-bedrock-report"

// Synthetic requests only. Never log credentials, request headers, or raw errors.
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const auth = await Effect.runPromise(
  Effect.flatMap(Auth.Service, (service) => service.all()).pipe(Effect.provide(Auth.defaultLayer)),
)
const configFiles = [path.join(os.homedir(), ".config/opencode/opencode.json"), process.env.OPENCODE_CONFIG].filter(
  (file): file is string => !!file,
)
const configs = await Promise.all(
  configFiles.map(async (file) =>
    record(
      parse(
        await ConfigVariable.substitute({
          text: await Bun.file(file)
            .text()
            .catch(() => "{}"),
          type: "path",
          path: file,
        }),
      ),
    ),
  ),
)
const config = mergeDeep(
  configs.reduce((result, value) => mergeDeep(result, value), {} as Record<string, unknown>),
  record(parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}")),
)
const providers = record(config.provider)
const options = (id: string) => record(record(providers[id]).options)
const key = (id: string, env: string) => {
  const saved = auth[id]
  const configured = options(id).apiKey
  if (process.env.BENCH_AUTH_SOURCE === "env") return process.env[env]
  if (process.env.BENCH_AUTH_SOURCE === "stored") return saved?.type === "api" ? saved.key : undefined
  if (process.env.BENCH_AUTH_SOURCE === "config") return typeof configured === "string" ? configured : undefined
  // Match Provider's saved-key precedence instead of letting a stale env key mask it.
  if (typeof configured !== "string" && id === "openai" && saved?.type === "api") return saved.key
  return typeof configured === "string"
    ? configured
    : (process.env[env] ?? (saved?.type === "api" ? saved.key : undefined))
}
const codex = auth["openai-codex"]
const credentials = {
  openai: key("openai", "OPENAI_API_KEY"),
  codex: codex?.type === "oauth" && codex.expires > Date.now() ? codex.access : undefined,
  bedrock: key("amazon-bedrock", "AWS_BEARER_TOKEN_BEDROCK"),
}
if (process.env.BENCH_INSPECT === "1") {
  console.log(
    JSON.stringify(
      {
        model: config.model,
        native: process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM,
        credentials: Object.fromEntries(Object.entries(credentials).map(([id, value]) => [id, Boolean(value)])),
        openaiSources: {
          environment: !!process.env.OPENAI_API_KEY,
          stored: auth.openai?.type === "api",
          configured: typeof options("openai").apiKey === "string",
          environmentMatchesStored: auth.openai?.type === "api" && auth.openai.key === process.env.OPENAI_API_KEY,
        },
        codexExpired: codex?.type === "oauth" ? codex.expires <= Date.now() : undefined,
        providers: Object.fromEntries(
          ["openai", "openai-codex", "amazon-bedrock"].map((id) => [
            id,
            {
              options: Object.fromEntries(
                ["region", "transport", "responsesContinuation"].map((name) => [name, options(id)[name]]),
              ),
              models: Object.fromEntries(
                Object.entries(record(record(providers[id]).models))
                  .filter(([id]) => /astra|6[.-]1.*sol/.test(id))
                  .map(([id, model]) => [
                    id,
                    {
                      id: record(model).id,
                      options: Object.fromEntries(
                        ["serviceTier", "reasoningEffort", "textVerbosity", "transport", "responsesContinuation"].map(
                          (name) => [name, record(record(model).options)[name]],
                        ),
                      ),
                    },
                  ]),
              ),
            },
          ]),
        ),
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

const runs = Number(process.env.BENCH_RUNS ?? 1)
const cap = Number(process.env.BENCH_OUTPUT_TOKENS ?? 768)
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("BENCH_RUNS must be 1-10")
if (!Number.isInteger(cap) || cap < 32 || cap > 2048) throw new Error("BENCH_OUTPUT_TOKENS must be 32-2048")
const probe = process.env.BENCH_PROBE === "1"
const cache = process.env.BENCH_CACHE
if (cache && cache !== "implicit" && cache !== "explicit") throw new Error("BENCH_CACHE must be implicit or explicit")
const context = cache
  ? `Cache experiment ${cache}:\n` + Array.from({ length: 512 }, (_, i) => `const item_${i} = ${i};`).join("\n")
  : undefined
const transport = process.env.BENCH_TRANSPORT ?? "http"
if (transport !== "http" && transport !== "websocket") throw new Error("Unknown BENCH_TRANSPORT")
const region = process.env.BENCH_OPENAI_REGION ?? "global"
if (!["global", "us", "eu"].includes(region)) throw new Error("BENCH_OPENAI_REGION must be global, us, or eu")
const sockets = new Map<string, WebSocket>()
const matrix = ["gpt-6.1-sol", "gpt-6-astra"].flatMap((model) => [
  ...["default", "priority", "ultrafast"].map((tier) => ({
    name: `openai-${model}-${tier}`,
    provider: "openai" as const,
    url: `https://${region === "global" ? "" : `${region}.`}api.openai.com/v1/responses`,
    model,
    tier,
  })),
  ...["default", "priority", "fast", "ultrafast"].map((tier) => ({
    name: `codex-${model}-${tier}`,
    provider: "codex" as const,
    url: "https://chatgpt.com/backend-api/codex/responses",
    model,
    tier,
  })),
  ...["default", "ultrafast"].map((tier) => ({
    name: `bedrock-${model}-${tier}`,
    provider: "bedrock" as const,
    url: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses",
    model: `us.openai.${model}`,
    tier,
  })),
  ...["default", "ultrafast"].map((tier) => ({
    name: `mantle-${model}-${tier}`,
    provider: "bedrock" as const,
    url: `https://bedrock-mantle.${model === "gpt-6.1-sol" ? "us-east-1" : "us-west-2"}.api.aws/openai/v1/responses`,
    model: `openai.${model}`,
    tier,
  })),
])
const filter = process.env.BENCH_PATHS?.split(",")
if (filter?.some((name) => !matrix.some((entry) => entry.name === name))) throw new Error("Unknown BENCH_PATHS entry")
if (process.env.BENCH_OUTPUT && (await Bun.file(process.env.BENCH_OUTPUT).exists()))
  throw new Error("Refusing to overwrite BENCH_OUTPUT")
const selected = matrix.filter((entry) => (!filter || filter.includes(entry.name)) && credentials[entry.provider])
if (transport === "websocket" && selected.some((entry) => entry.provider === "bedrock"))
  throw new Error("This benchmark only tests documented OpenAI/Codex WebSockets")
const prompt = probe
  ? "Reply with exactly OK."
  : "Write exactly 24 single-line TypeScript functions named add1 through add24. Each takes x: number and returns x plus the number in its name. Return code only, no comments or explanation."
const startedAt = new Date().toISOString()
const samples: Awaited<ReturnType<typeof measure>>[] = []

async function measure(entry: (typeof matrix)[number], trial: number) {
  const start = performance.now()
  const timing = { headersMs: 0, firstByteMs: 0, firstTextMs: 0, lastTextMs: 0, chunks: 0 }
  const network: { edge?: string; processingMs?: number } = {}
  const state = { status: "unfinished", model: "", tier: "", usage: {} as Record<string, unknown>, error: "" }
  const body = JSON.stringify({
    model: entry.model,
    stream: true,
    store: false,
    service_tier: entry.tier,
    instructions: "Follow the user's formatting instructions precisely.",
    input: [
      {
        role: "user",
        content: [
          ...(context
            ? [
                {
                  type: "input_text",
                  text: context,
                  ...(cache === "explicit" ? { prompt_cache_breakpoint: { mode: "explicit" } } : {}),
                },
              ]
            : []),
          { type: "input_text", text: cache ? `${prompt} Trial ${trial}: ignore the sample context.` : prompt },
        ],
      },
    ],
    ...(cache ? { prompt_cache_options: { mode: cache } } : {}),
    reasoning: { effort: "low" },
    ...(entry.provider === "codex" ? {} : { max_output_tokens: probe ? 64 : cap }),
  })
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials[entry.provider]}`,
    "Content-Type": "application/json",
  }
  if (entry.provider === "codex" && codex?.type === "oauth" && codex.accountId)
    headers["ChatGPT-Account-Id"] = codex.accountId
  if (entry.provider === "codex" && process.env.BENCH_CODEX_ROUTING === "1") {
    headers["x-codex-routing-hint"] = `model=${entry.model};tier=${entry.tier}`
    headers.originator = "opencode"
  }
  const observe = (event: Record<string, unknown>) => {
    const response = record(event.response)
    if (typeof response.model === "string") state.model = response.model
    if (typeof response.service_tier === "string") state.tier = response.service_tier
    if (event.type === "response.output_text.delta" && event.delta) {
      timing.lastTextMs = performance.now() - start
      timing.firstTextMs ||= timing.lastTextMs
      timing.chunks++
    }
    if (["response.completed", "response.incomplete", "response.failed"].includes(String(event.type))) {
      state.status = String(event.type)
      state.usage = record(response.usage)
    }
    if (event.type === "error") state.status = "stream-error"
  }
  const result = await (async () => {
    if (transport === "websocket") {
      await new Promise<void>((resolve, reject) => {
        const cached = sockets.get(entry.name)
        const existing = cached?.readyState === WebSocket.OPEN ? cached : undefined
        if (cached && !existing) cached.close()
        // Bun supports handshake headers; the DOM constructor declaration does not.
        const Socket = WebSocket as unknown as {
          new (url: string, options: { headers: Record<string, string> }): WebSocket
        }
        const socket =
          existing ??
          new Socket(entry.url.replace(/^https:/, "wss:"), {
            headers: { ...headers, "OpenAI-Beta": "responses_websockets=2026-02-06" },
          })
        const cleanup = () => {
          clearTimeout(timer)
          socket.removeEventListener("message", message)
          socket.removeEventListener("error", error)
          socket.removeEventListener("close", error)
          socket.removeEventListener("open", open)
        }
        const error = () => {
          cleanup()
          sockets.delete(entry.name)
          socket.close()
          reject(new Error("WebSocket failed"))
        }
        const message = (message: MessageEvent) => {
          timing.firstByteMs ||= performance.now() - start
          try {
            const event = record(JSON.parse(String(message.data)))
            observe(event)
            if (state.status !== "unfinished") {
              cleanup()
              resolve()
            }
          } catch {
            error()
          }
        }
        const open = () => {
          timing.headersMs = performance.now() - start
          sockets.set(entry.name, socket)
          const request = JSON.parse(body)
          delete request.stream
          socket.send(JSON.stringify({ type: "response.create", ...request }))
        }
        const timer = setTimeout(error, 45_000)
        socket.addEventListener("message", message)
        socket.addEventListener("error", error)
        socket.addEventListener("close", error)
        if (existing?.readyState === WebSocket.OPEN) open()
        else socket.addEventListener("open", open, { once: true })
      })
      return
    }
    const response = await fetch(entry.url, { method: "POST", headers, body, signal: AbortSignal.timeout(45_000) })
    timing.headersMs = performance.now() - start
    network.edge = response.headers.get("cf-ray")?.split("-").at(-1)
    const processing = response.headers.get("openai-processing-ms")
    if (processing !== null && Number.isFinite(Number(processing))) network.processingMs = Number(processing)
    if (!response.ok) {
      const error = record(record(await response.json().catch(() => ({}))).error)
      // Only identifier-like fields are retained, not server messages which may echo input.
      state.error = [error.type, error.code, error.param]
        .filter((v) => typeof v === "string" && /^[\w.-]+$/.test(v))
        .join(":")
      state.status = `http-${response.status}`
      return
    }
    const accept = sse(observe)
    const decoder = new TextDecoder()
    if (!response.body) throw new Error("Missing body")
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      timing.firstByteMs ||= performance.now() - start
      accept(decoder.decode(value, { stream: true }))
    }
    accept(decoder.decode())
  })().then(
    () => undefined,
    () => "transport-or-parse-error",
  )
  const totalMs = performance.now() - start
  const output = Number(state.usage.output_tokens ?? 0)
  const reasoning = Number(record(state.usage.output_tokens_details).reasoning_tokens ?? 0)
  return {
    path: entry.name,
    endpoint: entry.url,
    trial,
    transport,
    status: result ?? state.status,
    error: state.error || undefined,
    requestedModel: entry.model,
    returnedModel: state.model,
    requestedTier: entry.tier,
    returnedTier: state.tier,
    tierMatched:
      state.tier === entry.tier || (entry.provider === "openai" && entry.tier === "priority" && state.tier === "fast"),
    ...timing,
    ...network,
    totalMs,
    inputTokens: state.usage.input_tokens,
    cachedTokens: record(state.usage.input_tokens_details).cached_tokens,
    cacheWriteTokens: record(state.usage.input_tokens_details).cache_write_tokens,
    outputTokens: output,
    reasoningTokens: reasoning,
    visibleTokensPerSecond: output ? ((output - reasoning) * 1000) / totalMs : undefined,
  }
}
for (const socket of sockets.values()) socket.close()

for (let trial = 0; trial < runs; trial++) {
  for (let offset = 0; offset < selected.length; offset++) {
    const sample = await measure(selected[(trial + offset) % selected.length], trial + 1)
    samples.push(sample)
    console.log(JSON.stringify(sample))
  }
}
const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
}
const summary = selected.map((entry) => {
  const attempted = samples.filter((sample) => sample.path === entry.name)
  const valid = attempted.filter(
    (sample) => sample.status === "response.completed" && sample.tierMatched && sample.firstTextMs,
  )
  return {
    path: entry.name,
    attempted: attempted.length,
    completedWithMatchingTier: valid.length,
    firstTextMs: median(valid.map((sample) => sample.firstTextMs)),
    totalMs: median(valid.map((sample) => sample.totalMs)),
    visibleTokensPerSecond: median(valid.map((sample) => sample.visibleTokensPerSecond ?? 0)),
  }
})
console.log(JSON.stringify({ summary }, null, 2))
if (process.env.BENCH_OUTPUT) {
  await Bun.write(
    process.env.BENCH_OUTPUT,
    JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        probe,
        cache,
        runs,
        cap,
        prompt,
        transport,
        codexRoutingHint: process.env.BENCH_CODEX_ROUTING === "1",
        reasoningEffort: "low",
        concurrency: 1,
        measurement:
          "Raw Responses API, not full harness; no retries. Trial 1 includes cold connections. No history continuation.",
        summary,
        samples,
      },
      null,
      2,
    ) + "\n",
  )
}
// This standalone benchmark owns its process; do not wait for socket close handshakes.
process.exit(0)
