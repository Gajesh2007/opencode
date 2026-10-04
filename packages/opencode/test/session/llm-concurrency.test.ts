import { afterAll, beforeAll, describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import type { LLMEvent } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { withTmpdirInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

const previous = Flag.OPENCODE_DISABLE_MODELS_FETCH
beforeAll(() => {
  Flag.OPENCODE_DISABLE_MODELS_FETCH = true
})
afterAll(() => {
  Flag.OPENCODE_DISABLE_MODELS_FETCH = previous
})

const providers = {
  openai: { model: "gpt-concurrency-test", npm: "@ai-sdk/openai", path: "responses", sdk: "openai.responses" },
  openrouter: {
    model: "openai/gpt-concurrency-test",
    npm: "@openrouter/ai-sdk-provider",
    path: "chat/completions",
    sdk: "openrouter",
  },
}
type ProviderName = keyof typeof providers

// Explicitly select AI SDK even when the developer has opted into the native runtime.
const it = testEffect(
  Layer.mergeAll(
    Provider.defaultLayer,
    LLM.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Auth.defaultLayer,
          Config.defaultLayer,
          Provider.defaultLayer,
          Plugin.defaultLayer,
          RuntimeFlags.layer({ experimentalNativeLlm: false }),
          LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
        ),
      ),
    ),
  ),
)

function chunks(provider: ProviderName, id: string) {
  const head = `begin:${id}|`
  const tail = `end:${id}`
  const encode = (events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
  if (provider === "openrouter") {
    const chunk = (delta: Record<string, string>, finish_reason: string | null = null) => ({
      id: `chatcmpl_${id}`,
      object: "chat.completion.chunk",
      created: 1,
      model: providers[provider].model,
      choices: [{ index: 0, delta, finish_reason }],
    })
    return {
      head: encode([chunk({ role: "assistant", content: head })]),
      tail: encode([chunk({ content: tail }), chunk({}, "stop")]) + "data: [DONE]\n\n",
    }
  }
  return {
    head: encode([
      {
        type: "response.created",
        response: { id: `resp_${id}`, created_at: 1, model: providers[provider].model, service_tier: null },
      },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: `msg_${id}` } },
      { type: "response.output_text.delta", item_id: `msg_${id}`, delta: head, logprobs: null },
    ]),
    tail: encode([
      { type: "response.output_text.delta", item_id: `msg_${id}`, delta: tail, logprobs: null },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: `msg_${id}` } },
      {
        type: "response.completed",
        response: {
          incomplete_details: null,
          service_tier: null,
          usage: { input_tokens: 1, output_tokens: 2, input_tokens_details: null, output_tokens_details: null },
        },
      },
    ]),
  }
}

describe("session.llm local provider concurrency", () => {
  for (const scenario of [
    { name: "50 OpenAI Responses streams", provider: "openai", cancel: false },
    { name: "50 OpenRouter chat streams", provider: "openrouter", cancel: false },
    { name: "cancel 10 of 50 OpenAI Responses streams", provider: "openai", cancel: true },
    { name: "cancel 10 of 50 OpenRouter chat streams", provider: "openrouter", cancel: true },
    { name: "25 OpenAI and 25 OpenRouter streams", provider: "mixed", cancel: false },
  ] as const) {
    it.live(
      scenario.name,
      () =>
        Effect.gen(function* () {
          const jobs = yield* Effect.forEach(
            Array.from({ length: 50 }, (_, index) => index),
            (index) =>
              Effect.gen(function* () {
                const provider =
                  scenario.provider === "mixed" ? (index % 2 === 0 ? "openai" : "openrouter") : scenario.provider
                return {
                  provider,
                  id: SessionID.make(`session-${provider}-${index}`),
                  cancel: scenario.cancel && index % 5 === 0,
                  ready: yield* Deferred.make<void, unknown>(),
                  disconnected: Promise.withResolvers<void>(),
                  aborted: Promise.withResolvers<void>(),
                  events: [] as LLMEvent[],
                }
              }),
          )
          const release = Promise.withResolvers<void>()
          const active = new Set<string>()
          const canceled = new Set<string>()
          const hits = new Map<
            string,
            { body: string; url: string; key: string | null; connection: number | undefined }
          >()
          const stats = { peak: 0 }
          const errors: string[] = []
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                async fetch(req, server) {
                  const job = jobs.find((job) => job.id === req.headers.get("x-session-affinity"))
                  if (!job || hits.has(job.id) || req.method !== "POST") {
                    errors.push("unexpected or duplicate request")
                    return new Response("unexpected request", { status: 400 })
                  }
                  hits.set(job.id, {
                    body: await req.text(),
                    url: new URL(req.url).pathname,
                    key: req.headers.get("authorization"),
                    connection: server.requestIP(req)?.port,
                  })
                  active.add(job.id)
                  stats.peak = Math.max(stats.peak, active.size)
                  req.signal.addEventListener("abort", () => job.aborted.resolve(), { once: true })
                  const data = chunks(job.provider, job.id)
                  return new Response(
                    new ReadableStream<Uint8Array>({
                      start(controller) {
                        controller.enqueue(new TextEncoder().encode(data.head))
                        void release.promise.then(() => {
                          if (!active.delete(job.id)) return
                          controller.enqueue(new TextEncoder().encode(data.tail))
                          controller.close()
                        })
                      },
                      cancel() {
                        active.delete(job.id)
                        canceled.add(job.id)
                        job.disconnected.resolve()
                      },
                    }),
                    { headers: { "Content-Type": "text/event-stream", Connection: "close" } },
                  )
                },
              }),
            ),
            (server) =>
              Effect.promise(async () => {
                release.resolve()
                await server.stop(true)
              }),
          )
          const origin = server.url.origin

          // This is a guard, not a transport mock: allowed calls use the real Bun fetch and TCP server.
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const original = globalThis.fetch
              globalThis.fetch = Object.assign(
                (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                  const url = new URL(input instanceof Request ? input.url : input)
                  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
                  const provider = jobs.find(
                    (job) => url.pathname === `/${job.provider}/v1/${providers[job.provider].path}`,
                  )?.provider
                  if (
                    url.origin !== origin ||
                    !provider ||
                    headers.get("authorization") !== `Bearer fake-${provider}-key`
                  ) {
                    errors.push(`blocked non-local URL or non-test credentials: ${url.origin}${url.pathname}`)
                    return Promise.reject(new Error(errors[errors.length - 1]))
                  }
                  return original(input, { ...init, redirect: "error" })
                },
                original,
              )
              return original
            }),
            (original) =>
              Effect.sync(() => {
                globalThis.fetch = original
              }),
          )

          yield* Effect.gen(function* () {
            const llm = yield* LLM.Service
            const provider = yield* Provider.Service
            const models = yield* Effect.forEach([...new Set(jobs.map((job) => job.provider))], (name) =>
              provider.getModel(ProviderID.make(name), ModelID.make(providers[name].model)),
            )
            const workers = yield* Effect.forEach(jobs, (job) =>
              Effect.gen(function* () {
                const model = models.find((model) => model.providerID === job.provider)
                if (!model) return yield* Effect.die("missing test model")
                expect(model.api.npm).toBe(providers[job.provider].npm)
                const fiber = yield* llm
                  .stream({
                    sessionID: job.id,
                    model,
                    user: {
                      id: MessageID.make(`msg_${job.id}`),
                      sessionID: job.id,
                      role: "user",
                      time: { created: 1 },
                      agent: "concurrency-test",
                      model: { providerID: model.providerID, modelID: model.id },
                    },
                    agent: { name: "concurrency-test", mode: "primary", options: {}, permission: [] },
                    system: [],
                    messages: [{ role: "user", content: `prompt:${job.id}` }],
                    tools: {},
                    retries: 0,
                  })
                  .pipe(
                    Stream.runForEach((event) => {
                      job.events.push(event)
                      return event.type === "text-delta" ? Deferred.succeed(job.ready, undefined) : Effect.void
                    }),
                    Effect.tapCause((cause) => Deferred.failCause(job.ready, cause)),
                    Effect.forkScoped,
                  )
                return { ...job, fiber }
              }),
            )

            // Client-observed first tokens prove 50 live response bodies, not just 50 scheduled tasks.
            yield* awaitWithTimeout(
              Effect.forEach(workers, (job) => Deferred.await(job.ready), { concurrency: "unbounded" }),
              "not all 50 clients received a token before release",
              "10 seconds",
            )
            expect(errors).toEqual([])
            expect(hits.size).toBe(50)
            expect(active.size).toBe(50)
            expect(server.pendingRequests).toBe(50)
            expect(stats.peak).toBe(50)
            expect(new Set([...hits.values()].map((hit) => hit.connection)).size).toBe(50)
            for (const job of workers) {
              const hit = hits.get(job.id)
              expect(hit?.url).toBe(`/${job.provider}/v1/${providers[job.provider].path}`)
              expect(hit?.key).toBe(`Bearer fake-${job.provider}-key`)
              expect(hit?.connection).toBeNumber()
              expect(JSON.parse(hit?.body ?? "null")).toMatchObject({
                model: providers[job.provider].model,
                stream: true,
              })
              expect(hit?.body).toContain(`prompt:${job.id}`)
              expect(
                job.events
                  .filter((event) => event.type === "text-delta")
                  .map((event) => event.text)
                  .join(""),
              ).toBe(`begin:${job.id}|`)
              expect(job.events.some((event) => event.type === "finish")).toBe(false)
            }
            for (const model of models) {
              const language = yield* provider.getLanguage(model)
              expect(language.provider).toBe(
                model.providerID === "openai" ? providers.openai.sdk : providers.openrouter.sdk,
              )
            }

            const interrupted = workers.filter((job) => job.cancel)
            yield* awaitWithTimeout(
              Fiber.interruptAll(interrupted.map((job) => job.fiber)),
              "canceled stream fibers did not stop",
              "5 seconds",
            )
            yield* awaitWithTimeout(
              Effect.promise(() =>
                Promise.all(interrupted.flatMap((job) => [job.disconnected.promise, job.aborted.promise])),
              ),
              "canceled streams did not cancel server response bodies and abort requests before peer release",
              "5 seconds",
            )
            expect(canceled).toEqual(new Set(interrupted.map((job) => job.id)))
            expect(active.size).toBe(50 - interrupted.length)
            // Bun updates its native counter after the request/stream callbacks return.
            yield* pollWithTimeout(
              Effect.sync(() => (server.pendingRequests === 50 - interrupted.length ? true : undefined)),
              "canceled requests remained pending on the server",
            )
            expect(workers.every((job) => !job.events.some((event) => event.type === "finish"))).toBe(true)

            release.resolve()
            const exits = yield* awaitWithTimeout(
              Effect.forEach(workers, (job) => Fiber.await(job.fiber), { concurrency: "unbounded" }),
              "released streams did not finish",
              "5 seconds",
            )
            workers.forEach((job, index) => {
              const exit = exits[index]
              if (job.cancel) {
                expect(Exit.isFailure(exit)).toBe(true)
                if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
                expect(job.events.some((event) => event.type === "finish")).toBe(false)
                expect(
                  job.events
                    .filter((event) => event.type === "text-delta")
                    .map((event) => event.text)
                    .join(""),
                ).toBe(`begin:${job.id}|`)
                return
              }
              expect(Exit.isSuccess(exit)).toBe(true)
              expect(
                job.events
                  .filter((event) => event.type === "text-delta")
                  .map((event) => event.text)
                  .join(""),
              ).toBe(`begin:${job.id}|end:${job.id}`)
              expect(job.events.filter((event) => event.type === "finish")).toMatchObject([{ reason: "stop" }])
            })
            yield* pollWithTimeout(
              Effect.sync(() => (server.pendingRequests === 0 ? true : undefined)),
              "completed streams left requests pending on the server",
            )
            expect(active.size).toBe(0)
            expect(hits.size).toBe(50)
            expect(errors).toEqual([])
          }).pipe(
            withTmpdirInstance({
              config: {
                enabled_providers: [...new Set(jobs.map((job) => job.provider))],
                model: `${jobs[0].provider}/${providers[jobs[0].provider].model}`,
                small_model: `${jobs[0].provider}/${providers[jobs[0].provider].model}`,
                plugin: [],
                share: "disabled",
                autoupdate: false,
                experimental: { openTelemetry: false },
                provider: Object.fromEntries(
                  [...new Set(jobs.map((job) => job.provider))].map((name) => [
                    name,
                    {
                      env: [],
                      npm: providers[name].npm,
                      api: `${origin}/${name}/v1`,
                      whitelist: [providers[name].model],
                      models: {
                        [providers[name].model]: {
                          name: "Local concurrency test",
                          limit: { context: 8192, output: 1024 },
                        },
                      },
                      options: { apiKey: `fake-${name}-key`, baseURL: `${origin}/${name}/v1` },
                    },
                  ]),
                ),
              } satisfies Partial<Config.Info>,
            }),
          )
        }),
      30_000,
    )
  }
})
