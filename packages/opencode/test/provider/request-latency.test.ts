import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Provider.defaultLayer, CrossSpawnSpawner.defaultLayer))

for (const store of [false, true]) {
  it.live(`OpenAI wire request preserves content and ${store ? "keeps" : "strips"} item IDs`, () =>
    Effect.gen(function* () {
      const bodies: Array<{ input: Array<Record<string, unknown>> }> = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          bodies.push(await request.json())
          return new Response('data: {"type":"response.completed","response":{"id":"resp_test","output":[]}}\n\n', {
            headers: { "content-type": "text/event-stream" },
          })
        },
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const model = yield* provider.getModel(ProviderID.openai, ModelID.make("gpt-5.2"))
            const language = yield* provider.getLanguage(model)
            const content = "A repeatable synthetic code context.\n".repeat(16_384)
            for (const ids of [false, true]) {
              const samples: number[] = []
              const count = process.env.OPENCODE_BENCHMARK ? 105 : 1
              for (let i = 0; i < count; i++) {
                const start = performance.now()
                const result = yield* Effect.promise(() =>
                  language.doStream({
                    prompt: [
                      { role: "user", content: [{ type: "text", text: content }] },
                      {
                        role: "assistant",
                        content: [
                          {
                            type: "text",
                            text: "Prior answer",
                            ...(ids ? { providerOptions: { openai: { itemId: "msg_previous" } } } : {}),
                          },
                        ],
                      },
                      { role: "user", content: [{ type: "text", text: "Continue" }] },
                    ],
                    providerOptions: { openai: { store } },
                  }),
                )
                yield* Effect.promise(async () => {
                  const reader = result.stream.getReader()
                  while (!(await reader.read()).done) {}
                  reader.releaseLock()
                })
                if (i >= 5) samples.push(performance.now() - start)
                const body = bodies.pop()
                if (!body) throw new Error("Request did not reach the local server")
                expect(body.input[0]).toEqual({ role: "user", content: [{ type: "input_text", text: content }] })
                expect(body.input[1]).toEqual(
                  ids && store
                    ? { type: "item_reference", id: "msg_previous" }
                    : {
                        role: "assistant",
                        content: [{ type: "output_text", text: "Prior answer" }],
                      },
                )
              }
              if (samples.length) {
                samples.sort((a, b) => a - b)
                console.log(
                  JSON.stringify({
                    benchmark: "openai-http-preparation-and-loopback",
                    store,
                    ids,
                    contextBytes: Buffer.byteLength(content),
                    samples: samples.length,
                    p50Ms: samples[Math.floor(samples.length * 0.5)],
                    p95Ms: samples[Math.floor(samples.length * 0.95)],
                  }),
                )
              }
            }
          }),
        {
          config: {
            provider: {
              openai: { options: { apiKey: "local-test-only", baseURL: `${server.url}v1` } },
            },
          },
        },
      )
    }),
  )
}
