import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { LLM, LLMEvent, Message } from "../../src"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "../../src/route"
import * as OpenAI from "../../src/providers/openai"
import type { OpenAITextMetadata } from "../../src/providers/openai-options"
import * as Responses from "../../src/protocols/openai-responses"
import { it } from "../lib/effect"
import { dynamicResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const openai = { promptCacheBreakpoint: { mode: "explicit" } } satisfies OpenAITextMetadata
const completion = {
  type: "response.completed",
  response: { id: "resp_prewarm", model: "gpt-6.1-sol", output: [], usage: { input_tokens: 1024, output_tokens: 0 } },
}

describe("OpenAI Responses opt-in cache controls", () => {
  for (const transport of ["http", "websocket"] as const) {
    it.effect(`sends cache controls and accepts empty prewarm completion over ${transport}`, () =>
      Effect.gen(function* () {
        const sent: unknown[] = []
        const provider = OpenAI.configure({ apiKey: "test" })
        const request = LLM.request({
          model: transport === "http" ? provider.responses("gpt-6.1-sol") : provider.responsesWebSocket("gpt-6.1-sol"),
          system: [{ type: "text", text: "Stable instructions", metadata: { openai } }],
          messages: [
            Message.user([{ type: "text", text: "Stable reference", providerMetadata: { openai } }]),
            Message.tool({
              id: "call_1",
              name: "lookup",
              result: {
                type: "content",
                value: [{ type: "text", text: "Tool reference", providerMetadata: { openai } }],
              },
            }),
          ],
          providerOptions: { openai: { promptCacheOptions: { mode: "explicit", ttl: "30m", prewarm: true } } },
        })
        const http = dynamicResponse((input) =>
          Effect.sync(() => {
            sent.push(JSON.parse(input.text))
            return input.respond(sseEvents(completion), { headers: { "content-type": "text/event-stream" } })
          }),
        )
        const websocket = Layer.mergeAll(
          Layer.succeed(
            RequestExecutor.Service,
            RequestExecutor.Service.of({ execute: () => Effect.die("unexpected HTTP") }),
          ),
          Layer.succeed(
            WebSocketExecutor.Service,
            WebSocketExecutor.Service.of({
              open: () =>
                Effect.succeed({
                  sendText: (message) =>
                    Effect.sync(() => {
                      sent.push(JSON.parse(message))
                    }),
                  messages: Stream.make(JSON.stringify(completion)),
                  close: Effect.void,
                }),
            }),
          ),
        )
        const response =
          transport === "http"
            ? yield* LLMClient.generate(request).pipe(Effect.provide(http))
            : yield* LLMClient.generate(request).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(websocket))))
        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatchObject({
          prompt_cache_options: { mode: "explicit", ttl: "30m", prewarm: true },
          input: [
            {
              role: "developer",
              content: [
                { type: "input_text", text: "Stable instructions", prompt_cache_breakpoint: { mode: "explicit" } },
              ],
            },
            {
              role: "user",
              content: [
                { type: "input_text", text: "Stable reference", prompt_cache_breakpoint: { mode: "explicit" } },
              ],
            },
            {
              type: "function_call_output",
              output: [{ type: "input_text", text: "Tool reference", prompt_cache_breakpoint: { mode: "explicit" } }],
            },
          ],
        })
        expect(sent[0]).not.toHaveProperty("promptCacheOptions")
        expect(sent[0]).not.toHaveProperty("prewarm")
        if (transport === "websocket") {
          expect(sent[0]).toHaveProperty("type", "response.create")
          expect(sent[0]).not.toHaveProperty("stream")
        }
        expect(response.text).toBe("")
        const finish = response.events.filter(LLMEvent.is.finish)
        expect(finish).toHaveLength(1)
        expect(finish[0]).toMatchObject({ reason: "stop", providerMetadata: { openai: { modelId: "gpt-6.1-sol" } } })
      }),
    )
  }

  it.effect("accounts for cache writes separately from fresh and cached input", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({
          model: OpenAI.responses("gpt-6.1-sol"),
          prompt: "Hello",
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.succeed(
              input.respond(
                sseEvents({
                  ...completion,
                  response: {
                    ...completion.response,
                    usage: {
                      input_tokens: 1500,
                      output_tokens: 0,
                      input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 300 },
                    },
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              ),
            ),
          ),
        ),
      )
      expect(response.usage).toMatchObject({
        inputTokens: 1500,
        nonCachedInputTokens: 200,
        cacheReadInputTokens: 1000,
        cacheWriteInputTokens: 300,
      })
    }),
  )

  it.effect("keeps default wire bodies unchanged for older and newer models", () =>
    Effect.gen(function* () {
      for (const id of ["gpt-4.1", "gpt-5.6", "gpt-6.1-sol"]) {
        const request = LLM.request({ model: OpenAI.responses(id), system: "Stable", prompt: "Hello" })
        const prepared = yield* LLMClient.prepare<Responses.OpenAIResponsesBody>(request)
        expect(prepared.body).not.toHaveProperty("prompt_cache_options")
        expect(prepared.body.input).toEqual([
          { role: "system", content: "Stable" },
          { role: "user", content: [{ type: "input_text", text: "Hello" }] },
        ])
      }
    }),
  )

  for (const options of [{ mode: "automatic" }, { ttl: "24h" }, { prewarm: "true" }, { preWarm: true }, null]) {
    it.effect(`rejects malformed promptCacheOptions ${JSON.stringify(options)}`, () =>
      Effect.gen(function* () {
        const error = yield* LLMClient.prepare(
          LLM.request({
            model: OpenAI.responses("gpt-6.1-sol"),
            prompt: "Hello",
            providerOptions: { openai: { promptCacheOptions: options } },
          }),
        ).pipe(Effect.flip)
        expect(error.reason._tag).toBe("InvalidRequest")
      }),
    )
  }

  for (const breakpoint of [{ mode: "implicit" }, true, null, { mode: "explicit", ttl: "30m" }]) {
    it.effect(`rejects malformed promptCacheBreakpoint ${JSON.stringify(breakpoint)}`, () =>
      Effect.gen(function* () {
        const error = yield* LLMClient.prepare(
          LLM.request({
            model: OpenAI.responses("gpt-6.1-sol"),
            messages: [
              Message.user([
                { type: "text", text: "Hello", providerMetadata: { openai: { promptCacheBreakpoint: breakpoint } } },
              ]),
            ],
          }),
        ).pipe(Effect.flip)
        expect(error.reason._tag).toBe("InvalidRequest")
      }),
    )
  }

  it.effect("rejects breakpoints on assistant output instead of silently dropping them", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({
          model: OpenAI.responses("gpt-6.1-sol"),
          messages: [Message.assistant([{ type: "text", text: "Hello", providerMetadata: { openai } }])],
        }),
      ).pipe(Effect.flip)
      expect(error.reason._tag).toBe("InvalidRequest")
    }),
  )

  for (const options of [{ mode: "implicit" }, { prewarm: false }, { ttl: "30m" }, {}] as const) {
    it.effect(`preserves valid partial options ${JSON.stringify(options)}`, () =>
      Effect.gen(function* () {
        const prepared = yield* LLMClient.prepare<Responses.OpenAIResponsesBody>(
          LLM.request({
            model: OpenAI.configure({ providerOptions: { openai: { promptCacheOptions: options } } }).responses(
              "gpt-6.1-sol",
            ),
            prompt: "Hello",
          }),
        )
        expect(prepared.body.prompt_cache_options).toEqual(options)
      }),
    )
  }
})
