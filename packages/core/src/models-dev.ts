import path from "path"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Global } from "./global"
import { Flag } from "./flag/flag"
import { Flock } from "./util/flock"
import { Hash } from "./util/hash"
import { AppFileSystem } from "./filesystem"
import { InstallationChannel, InstallationVersion } from "./installation/version"
import { EventV2 } from "./event"

export const CatalogModelStatus = Schema.Literals(["alpha", "beta", "deprecated"])
export type CatalogModelStatus = typeof CatalogModelStatus.Type

const USER_AGENT = `opencode/${InstallationChannel}/${InstallationVersion}/${Flag.OPENCODE_CLIENT}`

const CostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const Cost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tiers: Schema.optional(Schema.Array(CostTier)),
  context_over_200k: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
    }),
  ),
})

export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  release_date: Schema.String,
  attachment: Schema.Boolean,
  reasoning: Schema.Boolean,
  temperature: Schema.Boolean,
  tool_call: Schema.Boolean,
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Literal(true),
      Schema.Struct({
        field: Schema.Literals(["reasoning_content", "reasoning_details"]),
      }),
    ]),
  ),
  cost: Schema.optional(Cost),
  limit: Schema.Struct({
    context: Schema.Finite,
    input: Schema.optional(Schema.Finite),
    output: Schema.Finite,
  }),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
      output: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      modes: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            cost: Schema.optional(Cost),
            provider: Schema.optional(
              Schema.Struct({
                body: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
                headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
  status: Schema.optional(CatalogModelStatus),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
})
export type Model = Schema.Schema.Type<typeof Model>

export const Provider = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.String,
  env: Schema.Array(Schema.String),
  id: Schema.String,
  npm: Schema.optional(Schema.String),
  models: Schema.Record(Schema.String, Model),
})

export type Provider = Schema.Schema.Type<typeof Provider>

// Providers and models that are live but not yet published to models.dev.
// Injected into the fetched catalog so they show up in the model picker until
// upstream adds them. Remove entries once models.dev ships them (the merge below
// never overwrites real upstream data).
const INJECTED_PROVIDERS: Record<string, Provider> = {
  sakana: {
    id: "sakana",
    name: "Sakana API",
    env: ["SAKANA_API_KEY"],
    api: "https://api.sakana.ai/v1",
    npm: "@ai-sdk/openai",
    models: {
      "fugu-mini": {
        id: "fugu-mini",
        name: "Fugu Mini",
        family: "fugu",
        release_date: "2026-06-01",
        attachment: false,
        reasoning: true,
        temperature: false,
        tool_call: true,
        cost: { input: 0, output: 0 },
        limit: { context: 1_000_000, output: 100_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
      "fugu-ultra": {
        id: "fugu-ultra",
        name: "Fugu Ultra",
        family: "fugu",
        release_date: "2026-06-01",
        attachment: false,
        reasoning: true,
        temperature: false,
        tool_call: true,
        cost: { input: 0, output: 0 },
        limit: { context: 1_000_000, output: 100_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    },
  },
}

function gpt56Model(
  id: string,
  name: string,
  input: number,
  output: number,
  options: { tiered?: boolean; inputLimit?: boolean } = {},
): Model {
  return {
    id,
    name,
    family: "gpt",
    release_date: "2026-07-09",
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    cost:
      (options.tiered ?? true)
        ? {
            input,
            output,
            cache_read: input / 10,
            cache_write: input * 1.25,
            context_over_200k: {
              input: input * 2,
              output: output * 1.5,
              cache_read: input / 5,
              cache_write: input * 2.5,
            },
            tiers: [
              {
                input: input * 2,
                output: output * 1.5,
                cache_read: input / 5,
                cache_write: input * 2.5,
                tier: { type: "context", size: 272_000 },
              },
            ],
          }
        : { input, output, cache_read: input / 10 },
    limit:
      options.inputLimit === false
        ? { context: 1_050_000, output: 128_000 }
        : { context: 1_050_000, input: 922_000, output: 128_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  }
}

const INJECTED_MODELS: Record<string, Record<string, Model>> = {
  // GPT-5.6 was announced after the latest models.dev snapshot. OpenAI uses
  // bare model ids; OpenRouter and Vercel AI Gateway use `openai/...` ids.
  openai: {
    "gpt-5.6": gpt56Model("gpt-5.6", "GPT-5.6", 5, 30),
    "gpt-5.6-sol": gpt56Model("gpt-5.6-sol", "GPT-5.6 Sol", 5, 30),
    "gpt-5.6-terra": gpt56Model("gpt-5.6-terra", "GPT-5.6 Terra", 2.5, 15),
    "gpt-5.6-luna": gpt56Model("gpt-5.6-luna", "GPT-5.6 Luna", 1, 6),
  },
  openrouter: {
    "openai/gpt-5.6-sol": gpt56Model("openai/gpt-5.6-sol", "OpenAI: GPT-5.6 Sol", 5, 30, {
      tiered: false,
      inputLimit: false,
    }),
    "openai/gpt-5.6-sol-pro": gpt56Model("openai/gpt-5.6-sol-pro", "OpenAI: GPT-5.6 Sol Pro", 5, 30, {
      tiered: false,
      inputLimit: false,
    }),
    "openai/gpt-5.6-terra": gpt56Model("openai/gpt-5.6-terra", "OpenAI: GPT-5.6 Terra", 2.5, 15, {
      tiered: false,
      inputLimit: false,
    }),
    "openai/gpt-5.6-terra-pro": gpt56Model("openai/gpt-5.6-terra-pro", "OpenAI: GPT-5.6 Terra Pro", 2.5, 15, {
      tiered: false,
      inputLimit: false,
    }),
    "openai/gpt-5.6-luna": gpt56Model("openai/gpt-5.6-luna", "OpenAI: GPT-5.6 Luna", 1, 6, {
      tiered: false,
      inputLimit: false,
    }),
    "openai/gpt-5.6-luna-pro": gpt56Model("openai/gpt-5.6-luna-pro", "OpenAI: GPT-5.6 Luna Pro", 1, 6, {
      tiered: false,
      inputLimit: false,
    }),
  },
  // MiniMax M3 on the Vercel AI Gateway (1M context, multimodal, agentic).
  // Pricing/limits mirror the Gateway listing.
  vercel: {
    "openai/gpt-5.6-sol": gpt56Model("openai/gpt-5.6-sol", "GPT-5.6 Sol", 5, 30),
    "openai/gpt-5.6-terra": gpt56Model("openai/gpt-5.6-terra", "GPT-5.6 Terra", 2.5, 15),
    "openai/gpt-5.6-luna": gpt56Model("openai/gpt-5.6-luna", "GPT-5.6 Luna", 1, 6),
    "minimax/minimax-m3": {
      id: "minimax/minimax-m3",
      name: "MiniMax M3",
      family: "minimax",
      release_date: "2026-05-28",
      attachment: true,
      reasoning: true,
      temperature: true,
      tool_call: true,
      cost: { input: 0.3, output: 1.2, cache_read: 0.06, cache_write: 0.375 },
      limit: { context: 1_000_000, output: 128_000 },
      modalities: { input: ["text", "image"], output: ["text"] },
    },
    "nvidia/nemotron-3-ultra-550b-a55b": {
      id: "nvidia/nemotron-3-ultra-550b-a55b",
      name: "Nemotron 3 Ultra",
      family: "nemotron",
      release_date: "2026-06-04",
      attachment: false,
      reasoning: true,
      temperature: true,
      tool_call: true,
      cost: { input: 0.6, output: 3.6 },
      limit: { context: 1_000_000, output: 131_072 },
      modalities: { input: ["text"], output: ["text"] },
    },
    // Kimi K2.7 Code High Speed: the latency-optimized variant of Moonshot's
    // K2.7 Code (same model, ~180-260 tps). models.dev ships the base
    // `moonshotai/kimi-k2.7-code` but not yet this Gateway-only highspeed slug.
    // Mirrors the base entry's flags (always-thinking, interleaved
    // reasoning_content, temperature locked off); pricing/release per the
    // Vercel Gateway listing ($1.90/$8.00, $0.38 cache read).
    "moonshotai/kimi-k2.7-code-highspeed": {
      id: "moonshotai/kimi-k2.7-code-highspeed",
      name: "Kimi K2.7 Code High Speed",
      family: "kimi-k2",
      release_date: "2026-06-15",
      attachment: true,
      reasoning: true,
      temperature: false,
      tool_call: true,
      interleaved: { field: "reasoning_content" },
      cost: { input: 1.9, output: 8, cache_read: 0.38 },
      limit: { context: 262_144, output: 262_144 },
      modalities: { input: ["text", "image", "video"], output: ["text"] },
    },
    "xai/grok-4.5": {
      id: "xai/grok-4.5",
      name: "Grok 4.5",
      family: "grok",
      release_date: "2026-07-08",
      attachment: true,
      reasoning: true,
      temperature: true,
      tool_call: true,
      cost: {
        input: 2,
        output: 6,
        cache_read: 0.5,
        context_over_200k: { input: 4, output: 12, cache_read: 1 },
      },
      limit: { context: 500_000, output: 500_000 },
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    },
  },
  // Claude Fable 5: Anthropic's Mythos-class frontier model, GA on Google Cloud's
  // Gemini Enterprise Agent Platform (formerly Vertex AI) since 2026-06-09. Served
  // through the Anthropic-on-Vertex SDK. Mirrors the `@default` version convention
  // models.dev uses for the newest Vertex Claude models (opus-4-8, sonnet-4-6).
  // 1M context / 128k output, vision (text+image+pdf), always-on reasoning,
  // $10/M input + $50/M output (standard Anthropic cache ratios).
  "google-vertex": {
    "claude-fable-5@default": {
      id: "claude-fable-5@default",
      name: "Claude Fable 5",
      family: "claude-fable",
      release_date: "2026-06-09",
      attachment: true,
      reasoning: true,
      temperature: false,
      tool_call: true,
      cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
      limit: { context: 1_000_000, output: 128_000 },
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
      provider: { npm: "@ai-sdk/google-vertex/anthropic" },
    },
  },
  "google-vertex-anthropic": {
    "claude-fable-5@default": {
      id: "claude-fable-5@default",
      name: "Claude Fable 5",
      family: "claude-fable",
      release_date: "2026-06-09",
      attachment: true,
      reasoning: true,
      temperature: false,
      tool_call: true,
      cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
      limit: { context: 1_000_000, output: 128_000 },
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    },
  },
}

export function injectModels(data: Record<string, Provider>) {
  for (const [providerID, injected] of Object.entries(INJECTED_PROVIDERS)) {
    const provider = data[providerID]
    if (!provider) {
      data[providerID] = injected
      continue
    }
    const additions = Object.entries(injected.models).filter(([modelID]) => !provider.models[modelID])
    if (additions.length === 0) continue
    data[providerID] = { ...provider, models: { ...provider.models, ...Object.fromEntries(additions) } }
  }

  for (const [providerID, models] of Object.entries(INJECTED_MODELS)) {
    const provider = data[providerID]
    if (!provider) continue
    const additions = Object.entries(models).filter(([modelID]) => !provider.models[modelID])
    if (additions.length === 0) continue
    data[providerID] = { ...provider, models: { ...provider.models, ...Object.fromEntries(additions) } }
  }
  return data
}

export const Event = {
  Refreshed: EventV2.define({
    type: "models-dev.refreshed",
    schema: {},
  }),
}

declare const OPENCODE_MODELS_DEV: Record<string, Provider> | undefined

export interface Interface {
  readonly get: () => Effect.Effect<Record<string, Provider>>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelsDev") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const events = yield* EventV2.Service
    const http = HttpClient.filterStatusOk(
      (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({
          retryOn: "errors-and-responses",
          times: 2,
          schedule: Schedule.exponential(200).pipe(Schedule.jittered),
        }),
      ),
    )

    const source = Flag.OPENCODE_MODELS_URL || "https://models.dev"
    const filepath = path.join(
      Global.Path.cache,
      source === "https://models.dev" ? "models.json" : `models-${Hash.fast(source)}.json`,
    )
    const ttl = Duration.minutes(5)
    const lockKey = `models-dev:${filepath}`

    const fresh = Effect.fnUntraced(function* () {
      const stat = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat) return false
      const mtime = Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
      return Date.now() - mtime < Duration.toMillis(ttl)
    })

    const fetchApi = Effect.fn("ModelsDev.fetchApi")(function* () {
      return yield* HttpClientRequest.get(`${source}/api.json`).pipe(
        HttpClientRequest.setHeader("User-Agent", USER_AGENT),
        http.execute,
        Effect.flatMap((res) => res.text),
        Effect.timeout("10 seconds"),
      )
    })

    const loadFromDisk = fs.readJson(Flag.OPENCODE_MODELS_PATH ?? filepath).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
      Effect.map((v) => v as Record<string, Provider> | undefined),
    )

    const loadSnapshot = Effect.sync(() =>
      typeof OPENCODE_MODELS_DEV === "undefined" ? undefined : OPENCODE_MODELS_DEV,
    )

    const fetchAndWrite = Effect.fn("ModelsDev.fetchAndWrite")(function* () {
      const text = yield* fetchApi()
      yield* fs.writeWithDirs(filepath, text)
      return text
    })

    const populate = Effect.gen(function* () {
      const fromDisk = yield* loadFromDisk
      if (fromDisk) return fromDisk
      const snapshot = yield* loadSnapshot
      if (snapshot) return snapshot
      if (Flag.OPENCODE_DISABLE_MODELS_FETCH) return {}
      // Flock is cross-process: concurrent opencode CLIs can race on this cache file.
      const text = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          return yield* fetchAndWrite()
        }),
      )
      return JSON.parse(text) as Record<string, Provider>
    }).pipe(Effect.map(injectModels), Effect.withSpan("ModelsDev.populate"), Effect.orDie)

    const [cachedGet, invalidate] = yield* Effect.cachedInvalidateWithTTL(populate, Duration.infinity)

    const get = (): Effect.Effect<Record<string, Provider>> => cachedGet

    const refresh = Effect.fn("ModelsDev.refresh")(function* (force = false) {
      if (!force && (yield* fresh())) return
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          // Re-check under the lock: another process may have refreshed between
          // our outer check and lock acquisition.
          if (!force && (yield* fresh())) return
          yield* fetchAndWrite()
          yield* invalidate
          yield* events.publish(Event.Refreshed, {})
        }),
      ).pipe(
        Effect.tapCause((cause) =>
          Effect.logError("Failed to fetch models.dev").pipe(Effect.annotateLogs("cause", cause)),
        ),
        Effect.ignore,
      )
    })

    if (!Flag.OPENCODE_DISABLE_MODELS_FETCH && !process.argv.includes("--get-yargs-completions")) {
      // Schedule.spaced runs the effect once, then waits between completions.
      yield* Effect.forkScoped(refresh().pipe(Effect.repeat(Schedule.spaced("60 minutes")), Effect.ignore))
    }

    return Service.of({ get, refresh })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
)

export * as ModelsDev from "./models-dev"
