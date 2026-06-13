import { describe, expect, beforeAll, beforeEach, afterAll } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { EventV2 } from "@opencode-ai/core/event"
import { it } from "./lib/effect"
import { rm, writeFile, utimes, mkdir } from "fs/promises"
import path from "path"

// test/preload.ts pins OPENCODE_MODELS_PATH to a fixture so other tests can
// resolve providers without network. These tests need to drive the on-disk
// cache themselves and silence the eager refresh fork. Save/restore around
// the suite — never leak the mutation to subsequent test files in the same
// bun process.
const ORIGINAL_MODELS_PATH = Flag.OPENCODE_MODELS_PATH
const ORIGINAL_DISABLE_FETCH = Flag.OPENCODE_DISABLE_MODELS_FETCH
beforeAll(() => {
  Flag.OPENCODE_MODELS_PATH = undefined
  Flag.OPENCODE_DISABLE_MODELS_FETCH = true
})
afterAll(() => {
  Flag.OPENCODE_MODELS_PATH = ORIGINAL_MODELS_PATH
  Flag.OPENCODE_DISABLE_MODELS_FETCH = ORIGINAL_DISABLE_FETCH
})

const cacheFile = path.join(Global.Path.cache, "models.json")

const fixture: Record<string, ModelsDev.Provider> = {
  acme: {
    id: "acme",
    name: "Acme",
    env: ["ACME_API_KEY"],
    models: {
      "acme-1": {
        id: "acme-1",
        name: "Acme One",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
      },
    },
  },
}

const fixture2: Record<string, ModelsDev.Provider> = {
  beta: {
    id: "beta",
    name: "Beta",
    env: ["BETA_API_KEY"],
    models: {
      "beta-1": {
        id: "beta-1",
        name: "Beta One",
        release_date: "2026-02-01",
        attachment: false,
        reasoning: true,
        temperature: false,
        tool_call: false,
        limit: { context: 64000, output: 4096 },
      },
    },
  },
}

interface MockState {
  body: string
  status: number
  calls: Array<{ url: string; userAgent: string | null }>
}

const makeMockClient = (state: Ref.Ref<MockState>) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* Ref.update(state, (s) => ({
        ...s,
        calls: [...s.calls, { url: request.url, userAgent: request.headers["user-agent"] ?? null }],
      }))
      const s = yield* Ref.get(state)
      return HttpClientResponse.fromWeb(request, new Response(s.body, { status: s.status }))
    }),
  )

const buildLayer = (state: Ref.Ref<MockState>) =>
  // Layer.fresh is required: ModelsDev.layer is a module-level Layer constant,
  // and Effect.provide uses a process-global MemoMap by default — without fresh,
  // every test would reuse the cachedInvalidateWithTTL state from the first run.
  Layer.fresh(ModelsDev.layer).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, makeMockClient(state))),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(EventV2.defaultLayer),
  )

const writeCache = (data: object, mtimeMs?: number) =>
  Effect.promise(async () => {
    await mkdir(Global.Path.cache, { recursive: true })
    await writeFile(cacheFile, JSON.stringify(data))
    if (mtimeMs !== undefined) {
      const t = mtimeMs / 1000
      await utimes(cacheFile, t, t)
    }
  })

const provided = <A, E>(state: Ref.Ref<MockState>, eff: Effect.Effect<A, E, ModelsDev.Service>) =>
  eff.pipe(Effect.provide(buildLayer(state)))

beforeEach(async () => {
  await rm(cacheFile, { force: true })
})

afterAll(async () => {
  await rm(cacheFile, { force: true })
})

const initialState: MockState = {
  body: JSON.stringify(fixture),
  status: 200,
  calls: [],
}

describe("ModelsDev.injectModels", () => {
  const withVercel = (models: Record<string, ModelsDev.Model> = {}): Record<string, ModelsDev.Provider> => ({
    vercel: { id: "vercel", name: "Vercel AI Gateway", env: ["AI_GATEWAY_API_KEY"], npm: "@ai-sdk/gateway", models },
  })

  const withSakana = (models: Record<string, ModelsDev.Model> = {}): Record<string, ModelsDev.Provider> => ({
    sakana: {
      id: "sakana",
      name: "Upstream Sakana",
      env: ["UPSTREAM_SAKANA_API_KEY"],
      api: "https://upstream.sakana.example/v1",
      npm: "@ai-sdk/openai-compatible",
      models,
    },
  })

  it.live("adds MiniMax M3 to the Vercel AI Gateway when missing", () =>
    Effect.sync(() => {
      const result = ModelsDev.injectModels(withVercel())
      const model = result.vercel.models["minimax/minimax-m3"]
      expect(model?.name).toBe("MiniMax M3")
      expect(model?.tool_call).toBe(true)
      expect(model?.limit.context).toBe(1_000_000)
      expect(model?.cost?.input).toBe(0.3)
    }),
  )

  it.live("adds Nemotron 3 Ultra to the Vercel AI Gateway when missing", () =>
    Effect.sync(() => {
      const result = ModelsDev.injectModels(withVercel())
      const model = result.vercel.models["nvidia/nemotron-3-ultra-550b-a55b"]
      expect(model?.name).toBe("Nemotron 3 Ultra")
      expect(model?.tool_call).toBe(true)
      expect(model?.reasoning).toBe(true)
      expect(model?.limit.context).toBe(1_000_000)
      expect(model?.cost?.input).toBe(0.6)
      expect(model?.cost?.output).toBe(3.6)
    }),
  )

  it.live("adds Sakana Fugu provider when missing", () =>
    Effect.sync(() => {
      const result = ModelsDev.injectModels({})
      const provider = result.sakana
      expect(provider?.name).toBe("Sakana API")
      expect(provider?.env).toEqual(["SAKANA_API_KEY"])
      expect(provider?.api).toBe("https://api.sakana.ai/v1")
      expect(provider?.npm).toBe("@ai-sdk/openai")
      expect(provider?.models["fugu-mini"]?.name).toBe("Fugu Mini")
      expect(provider?.models["fugu-mini"]?.reasoning).toBe(true)
      expect(provider?.models["fugu-mini"]?.tool_call).toBe(true)
      expect(provider?.models["fugu-mini"]?.limit.context).toBe(1_000_000)
      expect(provider?.models["fugu-ultra"]?.name).toBe("Fugu Ultra")
      expect(provider?.models["fugu-ultra"]?.limit.context).toBe(1_000_000)
    }),
  )

  it.live("does not overwrite an existing upstream MiniMax M3", () =>
    Effect.sync(() => {
      const upstream: ModelsDev.Model = {
        id: "minimax/minimax-m3",
        name: "Upstream Wins",
        release_date: "2026-06-01",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 200_000, output: 8192 },
      }
      const result = ModelsDev.injectModels(withVercel({ "minimax/minimax-m3": upstream }))
      expect(result.vercel.models["minimax/minimax-m3"].name).toBe("Upstream Wins")
    }),
  )

  it.live("does not overwrite an existing upstream Sakana provider or model", () =>
    Effect.sync(() => {
      const upstream: ModelsDev.Model = {
        id: "fugu-mini",
        name: "Upstream Fugu Mini",
        release_date: "2026-06-01",
        attachment: false,
        reasoning: false,
        temperature: false,
        tool_call: false,
        limit: { context: 128_000, output: 4096 },
      }
      const result = ModelsDev.injectModels(withSakana({ "fugu-mini": upstream }))
      expect(result.sakana.name).toBe("Upstream Sakana")
      expect(result.sakana.env).toEqual(["UPSTREAM_SAKANA_API_KEY"])
      expect(result.sakana.api).toBe("https://upstream.sakana.example/v1")
      expect(result.sakana.npm).toBe("@ai-sdk/openai-compatible")
      expect(result.sakana.models["fugu-mini"].name).toBe("Upstream Fugu Mini")
      expect(result.sakana.models["fugu-ultra"].name).toBe("Fugu Ultra")
    }),
  )

  it.live("preserves unrelated catalog entries while adding injected providers", () =>
    Effect.sync(() => {
      const result = ModelsDev.injectModels(structuredClone(fixture))
      expect(result.acme).toEqual(fixture.acme)
      expect(result.sakana).toBeDefined()
    }),
  )
})

describe("ModelsDev Service", () => {
  const injected = (data: Record<string, ModelsDev.Provider>) => ModelsDev.injectModels(structuredClone(data))

  it.live("get() returns providers from disk when cache file exists", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result).toEqual(injected(fixture))
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("get() returns injected providers when disk empty, fetch disabled, and no bundled snapshot is injected", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(Object.keys(result)).toEqual(["sakana"])
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("get() is single-flight under concurrent calls", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make(initialState)
      const results = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          return yield* Effect.all([svc.get(), svc.get(), svc.get(), svc.get(), svc.get()], {
            concurrency: "unbounded",
          })
        }),
      )
      for (const result of results) expect(result).toEqual(injected(fixture))
    }),
  )

  it.live("get() caches across calls (later disk writes are ignored until invalidate)", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make(initialState)
      const first = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          const a = yield* svc.get()
          // mutate disk between calls — cache should mask the change
          yield* writeCache(fixture2)
          const b = yield* svc.get()
          return { a, b }
        }),
      )
      expect(first.a).toEqual(injected(fixture))
      expect(first.b).toEqual(injected(fixture))
    }),
  )

  it.live("refresh(true) fetches via HttpClient and updates the cache", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          const before = yield* svc.get()
          yield* svc.refresh(true)
          const after = yield* svc.get()
          return { before, after }
        }),
      )
      expect(result.before).toEqual(injected(fixture))
      expect(result.after).toEqual(injected(fixture2))
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBe(1)
      expect(final.calls[0].url).toContain("/api.json")
      expect(final.calls[0].userAgent).toContain("/cli")
    }),
  )

  it.live("refresh(false) skips fetch when on-disk file is fresh", () =>
    Effect.gen(function* () {
      // Fresh: mtime within the 5-minute TTL.
      yield* writeCache(fixture, Date.now() - 1000)
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      yield* provided(
        state,
        ModelsDev.Service.use((s) => s.refresh(false)),
      )
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("refresh(false) fetches when on-disk file is stale", () =>
    Effect.gen(function* () {
      // Stale: mtime 10 minutes ago, beyond the 5-minute TTL.
      yield* writeCache(fixture, Date.now() - 10 * 60 * 1000)
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      const after = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          yield* svc.refresh(false)
          return yield* svc.get()
        }),
      )
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBe(1)
      expect(after).toEqual(injected(fixture2))
    }),
  )

  it.live("refresh swallows HTTP errors and leaves cache intact", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make({ ...initialState, status: 500, body: "boom" })
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          yield* svc.refresh(true)
          return yield* svc.get()
        }),
      )
      expect(result).toEqual(injected(fixture))
      // retryTransient retries 5xx, so calls may be > 1.
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBeGreaterThanOrEqual(1)
    }),
  )
})
