import { LLM, Message, type LLMRequest } from "@opencode-ai/llm"
import { OpenAI } from "@opencode-ai/llm/providers"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Auth } from "../src/auth"

// Synthetic data only. JSONL output never contains prompts, responses, credentials, or raw errors.
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null)
const records: unknown[] = []
const emit = (value: unknown) => {
  records.push(value)
  console.log(JSON.stringify(value))
}
const question = "Reply with exactly OK. Do not explain or call tools."
const tier = process.env.BENCH_TIER ?? "ultrafast"
if (!["default", "ultrafast"].includes(tier)) throw new Error("Invalid BENCH_TIER")
const prewarmTier = process.env.BENCH_PREWARM_TIER ?? tier
if (!["default", "ultrafast"].includes(prewarmTier)) throw new Error("Invalid BENCH_PREWARM_TIER")
const nativeRetryLimit = 0

async function main() {
  const model = process.env.BENCH_MODEL ?? "gpt-6.1-sol"
  const trials = Number(process.env.BENCH_TRIALS ?? 3)
  const local = process.env.BENCH_LOCAL === "1"
  const fault = process.env.BENCH_LOCAL_FAULT
  if (!["gpt-6.1-sol", "gpt-6-astra"].includes(model)) throw new Error("invalid_model")
  if (!Number.isInteger(trials) || trials < 1 || trials > 3) throw new Error("invalid_trials")
  if (fault && (!local || !["prewarm-output", "http-503"].includes(fault))) throw new Error("invalid_fault")
  const saved = local
    ? undefined
    : await Effect.runPromise(
        Effect.flatMap(Auth.Service, (service) => service.get("openai")).pipe(Effect.provide(Auth.defaultLayer)),
      )
  const apiKey = local ? "local-benchmark-only" : saved?.type === "api" ? saved.key : process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error("missing_api_key")

  const cached = new Set<string>()
  const server = local
    ? Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = record(await request.json())
          if (fault === "http-503") return new Response("fixture unavailable", { status: 503 })
          const prewarm = record(body.prompt_cache_options).prewarm === true
          const key = String(body.prompt_cache_key)
          const hit = cached.has(key)
          if (prewarm) cached.add(key)
          const output = !prewarm || fault === "prewarm-output"
          const events = [
            { type: "response.created", response: { id: "resp_fixture", model, service_tier: body.service_tier } },
            ...(output ? [{ type: "response.output_text.delta", item_id: "msg_fixture", delta: "OK" }] : []),
            {
              type: "response.completed",
              response: {
                id: "resp_fixture",
                model,
                service_tier: body.service_tier,
                status: "completed",
                output: output ? [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] : [],
                usage: {
                  input_tokens: 4100,
                  output_tokens: output ? 1 : 0,
                  input_tokens_details: { cached_tokens: hit ? 4096 : 0, cache_write_tokens: prewarm ? 4096 : 0 },
                },
              },
            },
          ]
          return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          })
        },
      })
    : undefined

  try {
    const provider = OpenAI.configure({ apiKey, baseURL: server ? `${server.url}v1` : "https://api.openai.com/v1" })
    const runID = crypto.randomUUID()
    emit({
      type: "config",
      local,
      model,
      requestedTier: tier,
      prewarmTier,
      effort: "low",
      store: false,
      maxOutputTokens: 64,
      trials,
      maxRequests: trials * 3,
      nativeRetryLimit,
      timeoutMs: 30_000,
      prefixBytes: 16_384,
      estimatedPrefixTokens: 4096,
      notes: [
        "HTTP native LLMClient; no continuation, executable tools, or application retry loop.",
        "Cold means unique prefix and cache key, not a cold TCP/TLS connection; inspect actual cache reads.",
        "Prewarm latency and usage are additional costs; compare inclusive timings, not only generation latency.",
        "Cache-write fields are null when absent; fixture timings and token counts are not provider measurements.",
      ],
    })

    for (let trial = 0; trial < trials; trial++) {
      const paths = trial % 2 === 0 ? (["cold", "warm"] as const) : (["warm", "cold"] as const)
      for (const path of paths) {
        // Nonce first prevents either arm or another run sharing an otherwise long common prefix.
        const nonce = `${runID}:${trial}:${path}`
        const header = `Synthetic isolated trial ${nonce}.\n`
        const rule =
          "You are a careful software assistant. Inspect relevant code before changing it. Preserve existing behavior. " +
          "Use focused tests and report uncertainty. Never expose credentials. Follow the user's output format.\n"
        const prefix = header + rule.repeat(Math.ceil(16_384 / rule.length)).slice(0, 16_384 - header.length)
        const cacheKey = new Bun.CryptoHasher("sha256").update(nonce).digest("hex")
        const make = (prewarm: boolean) =>
          LLM.request({
            model: provider.responses(model),
            system: [
              { type: "text", text: prefix, metadata: { openai: { promptCacheBreakpoint: { mode: "explicit" } } } },
            ],
            messages: prewarm ? [] : [Message.user(question)],
            toolChoice: "none",
            generation: { maxTokens: 64 },
            providerOptions: {
              openai: {
                store: false,
                serviceTier: prewarm ? prewarmTier : tier,
                reasoningEffort: "low",
                promptCacheKey: cacheKey,
                promptCacheOptions: { mode: "explicit", ttl: "30m", prewarm },
              },
            },
          })
        const prepare = async (request: LLMRequest, prewarm: boolean) => {
          const compiled = await Effect.runPromise(LLMClient.prepare(request))
          const expected = {
            model,
            input: [
              {
                role: "developer",
                content: [{ type: "input_text", text: prefix, prompt_cache_breakpoint: { mode: "explicit" } }],
              },
              ...(prewarm ? [] : [{ role: "user", content: [{ type: "input_text", text: question }] }]),
            ],
            tool_choice: "none",
            stream: true,
            max_output_tokens: 64,
            store: false,
            service_tier: prewarm ? prewarmTier : tier,
            reasoning: { effort: "low" },
            prompt_cache_key: cacheKey,
            prompt_cache_options: { mode: "explicit", ttl: "30m", prewarm },
          }
          if (!Bun.deepEquals(JSON.parse(JSON.stringify(compiled.body)), expected)) throw new Error("wire_mismatch")
          return compiled.body
        }
        const warmRequest = make(true)
        const generationRequest = make(false)
        const warmBody = await prepare(warmRequest, true)
        const generationBody = await prepare(generationRequest, false)
        const pairStart = performance.now()
        const prewarm = path === "warm" ? await measure(warmRequest, warmBody, true) : null
        const generationOffsetMs = performance.now() - pairStart
        const generation =
          prewarm && prewarm.status !== "ok" ? null : await measure(generationRequest, generationBody, false)
        emit({
          type: "sample",
          trial: trial + 1,
          order: paths.indexOf(path) + 1,
          path,
          model,
          requestedTier: tier,
          prefixBytes: Buffer.byteLength(prefix),
          wireVerified: true,
          prewarm,
          generation,
          inclusiveFirstTextMs:
            generation?.firstTextMs === null || !generation ? null : generationOffsetMs + generation.firstTextMs,
          inclusiveTotalMs: performance.now() - pairStart,
        })
        if ((prewarm?.status !== undefined && prewarm.status !== "ok") || generation?.status !== "ok") {
          process.exitCode = 1
          return
        }
      }
    }
  } finally {
    await server?.stop(true)
  }
}

async function measure(request: LLMRequest, expected: unknown, prewarm: boolean) {
  const start = performance.now()
  const state = {
    status: "ok",
    requests: 0,
    httpStatus: null as number | null,
    errorCode: null as string | null,
    errorParam: null as string | null,
    firstTextMs: null as number | null,
    servedTier: null as string | null,
    servedModel: null as string | null,
    finishReason: null as string | null,
    inputTokens: null as number | null,
    outputTokens: null as number | null,
    cacheReadInputTokens: null as number | null,
    cacheWriteInputTokens: null as number | null,
    rawUsage: {} as Record<string, number | null>,
  }
  const observe = (frame: string) => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
    if (!data || data === "[DONE]") return
    const event = record(JSON.parse(data))
    const response = record(event.response)
    if (typeof response.service_tier === "string") state.servedTier = response.service_tier
    if (typeof response.model === "string") state.servedModel = response.model
    if (
      prewarm &&
      (String(event.type).startsWith("response.output_") ||
        String(event.type).startsWith("response.reasoning") ||
        String(event.type).startsWith("response.function_call") ||
        (Array.isArray(response.output) && response.output.length > 0))
    )
      state.status = "prewarm_output"
    if (event.type !== "response.completed" && event.type !== "response.incomplete") return
    const usage = record(response.usage)
    const details = record(usage.input_tokens_details)
    state.rawUsage = Object.fromEntries([
      ["input_tokens", number(usage.input_tokens)],
      ["output_tokens", number(usage.output_tokens)],
      ["input_tokens_details.cached_tokens", number(details.cached_tokens)],
      ["input_tokens_details.cache_write_tokens", number(details.cache_write_tokens)],
      ["input_tokens_details.cache_creation_tokens", number(details.cache_creation_tokens)],
      ["cache_write_input_tokens", number(usage.cache_write_input_tokens)],
      ["cache_creation_input_tokens", number(usage.cache_creation_input_tokens)],
    ])
    state.cacheWriteInputTokens =
      number(details.cache_write_tokens) ??
      number(details.cache_creation_tokens) ??
      number(usage.cache_write_input_tokens) ??
      number(usage.cache_creation_input_tokens)
    if (prewarm && (number(usage.output_tokens) ?? 0) > 0) state.status = "prewarm_output"
  }
  const measuredFetch: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      state.requests++
      if (state.requests !== 1) throw new Error("unexpected_retry")
      const outgoing = new Request(input, init)
      if (!Bun.deepEquals(await outgoing.clone().json(), JSON.parse(JSON.stringify(expected)))) {
        state.status = "wire_mismatch"
        throw new Error("wire_mismatch")
      }
      const response = await fetch(outgoing)
      state.httpStatus = response.status
      if (!response.ok) {
        const error = record(
          record(
            await response
              .clone()
              .json()
              .catch(() => ({})),
          ).error,
        )
        if (typeof error.code === "string" && /^[\w.-]+$/.test(error.code)) state.errorCode = error.code
        if (typeof error.param === "string" && /^[\w.-]+$/.test(error.param)) state.errorParam = error.param
      }
      if (!response.ok || !response.body) return response
      const decoder = new TextDecoder()
      let pending = ""
      const inspect = (text: string) => {
        pending += text
        if (pending.length > 1_048_576) throw new Error("oversized_frame")
        const frames = pending.split(/\r?\n\r?\n/)
        pending = frames.pop() ?? ""
        frames.forEach(observe)
        if (state.status === "prewarm_output") throw new Error("prewarm_output")
      }
      return new Response(
        response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              inspect(decoder.decode(chunk, { stream: true }))
              controller.enqueue(chunk)
            },
            flush() {
              inspect(decoder.decode())
              if (pending.trim()) observe(pending)
            },
          }),
        ),
        { status: response.status, headers: response.headers },
      )
    },
    { preconnect: fetch.preconnect },
  )
  const result = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const client = yield* LLMClient.Service
      yield* client.stream(request).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "provider-error") state.status = "provider_error"
            if (
              prewarm &&
              [
                "text-start",
                "text-delta",
                "reasoning-start",
                "reasoning-delta",
                "tool-input-start",
                "tool-call",
                "tool-result",
              ].includes(event.type)
            ) {
              state.status = "prewarm_output"
              throw new Error("prewarm_output")
            }
            if (event.type === "text-delta" && event.text && state.firstTextMs === null)
              state.firstTextMs = performance.now() - start
            if (event.type !== "finish") return
            state.finishReason = event.reason
            state.inputTokens = event.usage?.inputTokens ?? null
            state.outputTokens = event.usage?.outputTokens ?? null
            state.cacheReadInputTokens = event.usage?.cacheReadInputTokens ?? null
            state.cacheWriteInputTokens ??= event.usage?.cacheWriteInputTokens ?? null
          }),
        ),
      )
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.provideService(RequestExecutor.RetryLimit, nativeRetryLimit),
      Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer))),
      Effect.provideService(FetchHttpClient.Fetch, measuredFetch),
    ),
  )
  if (result._tag === "Failure" && state.status === "ok") state.status = "request_failed"
  if (state.status === "ok" && !state.finishReason) state.status = "missing_finish"
  if (state.status === "ok" && state.servedTier !== record(expected).service_tier) state.status = "tier_mismatch"
  if (state.status === "ok" && state.servedModel !== record(expected).model) state.status = "model_mismatch"
  if (state.status === "ok" && prewarm && state.finishReason !== "stop") state.status = "invalid_prewarm_finish"
  if (state.status === "ok" && !prewarm && state.firstTextMs === null) state.status = "missing_text"
  return { ...state, totalMs: performance.now() - start }
}

if (process.env.BENCH_OUTPUT && (await Bun.file(process.env.BENCH_OUTPUT).exists()))
  throw new Error("Refusing to overwrite BENCH_OUTPUT")
await main().catch(() => {
  emit({
    type: "error",
    status: "benchmark_failed",
    note: "Check model/trial settings, saved API key, and local fixture configuration. Raw errors are suppressed.",
  })
  process.exitCode = 1
})
if (process.env.BENCH_OUTPUT) await Bun.write(process.env.BENCH_OUTPUT, JSON.stringify({ records }, null, 2) + "\n")
