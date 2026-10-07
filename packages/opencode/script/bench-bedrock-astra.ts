import { createOpenAI } from "@ai-sdk/openai"
import { streamText } from "ai"
import { Effect } from "effect"
import { Auth } from "../src/auth"

// Billable, synthetic-output benchmark. Credentials and generated content are never logged.
const runs = Number(process.env.BENCH_RUNS ?? 5)
const tokens = Number(process.env.BENCH_OUTPUT_TOKENS ?? 768)
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("BENCH_RUNS must be between 1 and 10")
if (!Number.isInteger(tokens) || tokens < 256 || tokens > 4096)
  throw new Error("BENCH_OUTPUT_TOKENS must be between 256 and 4096")

const auth = await Effect.runPromise(
  Effect.flatMap(Auth.Service, (service) => service.get("amazon-bedrock")).pipe(Effect.provide(Auth.defaultLayer)),
)
const apiKey = process.env.AWS_BEARER_TOKEN_BEDROCK ?? (auth?.type === "api" ? auth.key : undefined)
if (!apiKey) throw new Error("Configure a Bedrock API key before running this benchmark")

const paths = [
  {
    name: "runtime-standard",
    baseURL: "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1",
    model: "us.openai.gpt-6-astra",
    tier: "default",
  },
  {
    name: "runtime-ultrafast",
    baseURL: "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1",
    model: "us.openai.gpt-6-astra",
    tier: "ultrafast",
  },
  {
    name: "mantle-standard",
    baseURL: "https://bedrock-mantle.us-west-2.api.aws/openai/v1",
    model: "openai.gpt-6-astra",
    tier: "default",
  },
]
const prompt =
  "Write a TypeScript utility module with at least 100 small, independent string and array helper functions. " +
  "Include a brief doc comment before each function. Return only code, without Markdown fences or explanation. " +
  "Keep generating functions until you reach the output limit; do not summarize or abbreviate."

async function measure(path: (typeof paths)[number], trial: number, cap: number) {
  const timing = { headers: 0, first: 0, last: 0, chunks: 0, requests: 0 }
  const start = performance.now()
  const result = streamText({
    model: createOpenAI({
      apiKey,
      baseURL: path.baseURL,
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          timing.requests++
          const response = await fetch(input, init)
          timing.headers = performance.now() - start
          if (!response.ok) {
            await response.body?.cancel()
            throw new Error(`${path.name}: HTTP ${response.status}`)
          }
          return response
        },
        { preconnect: fetch.preconnect },
      ),
    }).responses(path.model),
    prompt,
    maxOutputTokens: cap,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(90_000),
    providerOptions: {
      openai: {
        forceReasoning: true,
        reasoningEffort: "low",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
        store: false,
        serviceTier: path.tier,
      },
    },
    onError() {},
  })
  for await (const event of result.fullStream) {
    if (event.type === "error") throw new Error(`${path.name}: stream failed; no sample recorded`)
    if (event.type !== "text-delta" || !event.text) continue
    timing.last = performance.now() - start
    if (!timing.first) timing.first = timing.last
    timing.chunks++
  }
  const total = performance.now() - start
  const usage = await result.usage
  const tier = (await result.providerMetadata)?.openai?.serviceTier
  if (tier !== path.tier) throw new Error(`${path.name}: server returned tier ${tier}, expected ${path.tier}`)
  if (!timing.first || !usage.outputTokens || timing.requests !== 1)
    throw new Error(`${path.name}: missing output or unexpected retry`)
  const reasoning = usage.outputTokenDetails.reasoningTokens ?? 0
  const visible = usage.outputTokens - reasoning
  return {
    path: path.name,
    trial,
    tier,
    finishReason: await result.finishReason,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
    outputTokens: usage.outputTokens,
    reasoningTokens: reasoning,
    visibleOutputTokens: visible,
    textChunks: timing.chunks,
    headersMs: timing.headers,
    firstTextMs: timing.first,
    lastTextMs: timing.last,
    totalMs: total,
    // Delivery rate is not engine throughput: buffered SSE can inflate it.
    // End-to-end throughput remains comparable when text arrives in bursts.
    postFirstTextTokensPerSecond: (visible * 1000) / (total - timing.first),
    endToEndTokensPerSecond: (visible * 1000) / total,
  }
}

function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b)
  return {
    median: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
    min: sorted[0],
    max: sorted.at(-1),
  }
}

const startedAt = new Date().toISOString()
const samples: Awaited<ReturnType<typeof measure>>[] = []
const warmups: Awaited<ReturnType<typeof measure>>[] = []
for (const path of paths) {
  const sample = await measure(path, 0, 256)
  warmups.push(sample)
  console.log(JSON.stringify({ warmup: true, ...sample }))
}
for (let trial = 1; trial <= runs; trial++) {
  // Rotate serial requests to limit ordering bias without creating artificial concurrency.
  for (let offset = 0; offset < paths.length; offset++) {
    const sample = await measure(paths[(trial - 1 + offset) % paths.length], trial, tokens)
    samples.push(sample)
    console.log(JSON.stringify(sample))
  }
}
const summary = paths.map((path) => {
  const selected = samples.filter((sample) => sample.path === path.name)
  return {
    ...path,
    samples: selected.length,
    firstTextMs: distribution(selected.map((sample) => sample.firstTextMs)),
    headersMs: distribution(selected.map((sample) => sample.headersMs)),
    totalMs: distribution(selected.map((sample) => sample.totalMs)),
    postFirstTextTokensPerSecond: distribution(selected.map((sample) => sample.postFirstTextTokensPerSecond)),
    endToEndTokensPerSecond: distribution(selected.map((sample) => sample.endToEndTokensPerSecond)),
    visibleOutputTokens: distribution(selected.map((sample) => sample.visibleOutputTokens)),
  }
})
const report = {
  startedAt,
  finishedAt: new Date().toISOString(),
  region: "us-west-2",
  reasoningEffort: "low",
  outputTokenCap: tokens,
  trialsPerPath: runs,
  concurrency: 1,
  prompt,
  measurement: "Client-observed streaming API timings, not full OpenCode startup/tool-loop timings",
  throughput: "(output_tokens - reasoning_tokens) / seconds from first text delta to stream completion",
  caveat: "Post-first-text delivery rates can be inflated by buffering; use end-to-end throughput for comparisons",
  summary,
  warmups,
  samples,
}
console.log(JSON.stringify({ summary }, null, 2))
if (process.env.BENCH_OUTPUT) await Bun.write(process.env.BENCH_OUTPUT, JSON.stringify(report, null, 2) + "\n")
