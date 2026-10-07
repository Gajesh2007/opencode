import { expect } from "bun:test"
import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { jsonSchema, type Tool } from "ai"
import { Context, Effect, Layer, Stream } from "effect"
import { LLMClient } from "@opencode-ai/llm/route"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { LLM } from "@/session/llm"
import { BedrockRetry } from "@/session/llm/bedrock-retry"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const selected: Provider.Model = {
  id: ModelID.make("scripted-bedrock-wiring"),
  providerID: ProviderID.make("amazon-bedrock"),
  api: {
    id: "scripted-bedrock-wiring",
    npm: "@ai-sdk/amazon-bedrock",
    url: "https://bedrock-runtime.us-east-1.amazonaws.com",
  },
  name: "Scripted Bedrock wiring",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, output: 32_000 },
  status: "active",
  options: { marker: "model-options" },
  headers: { "x-scripted": "preserved" },
  release_date: "2026-01-01",
}

for (const scenario of [
  { name: "Bedrock native SDK", api: selected.api, options: {}, hosted: false, guarded: true },
  {
    name: "known AWS OpenAI adapter",
    api: { ...selected.api, npm: "@ai-sdk/openai", url: "https://bedrock-mantle.us-east-1.api.aws/v1" },
    options: {},
    hosted: false,
    guarded: true,
  },
  { name: "explicit optout", api: selected.api, options: { noOutputRetries: false }, hosted: false, guarded: false },
  { name: "provider-hosted tool exclusion", api: selected.api, options: {}, hosted: true, guarded: false },
  {
    name: "non-AWS OpenAI adapter exclusion",
    api: { ...selected.api, npm: "@ai-sdk/openai", url: "https://offline.invalid/v1" },
    options: {},
    hosted: false,
    guarded: false,
  },
  {
    name: "native SDK custom baseURL exclusion",
    api: selected.api,
    options: { baseURL: "https://offline.invalid/v1" },
    hosted: false,
    guarded: false,
  },
  {
    name: "native SDK custom model URL exclusion",
    api: { ...selected.api, url: "https://offline.invalid/v1" },
    options: {},
    hosted: false,
    guarded: false,
  },
  {
    name: "AWS OpenAI region template",
    api: { ...selected.api, npm: "@ai-sdk/openai", url: "https://bedrock-mantle.${AWS_REGION}.api.aws/v1" },
    options: {},
    hosted: false,
    guarded: true,
  },
  {
    name: "empty baseURL preserves AWS model URL fallback",
    api: { ...selected.api, npm: "@ai-sdk/openai", url: "https://bedrock-mantle.us-east-1.api.aws/v1" },
    options: { baseURL: "" },
    hosted: false,
    guarded: true,
  },
]) {
  it.live(`actual LLM.service preserves ${scenario.name} wiring`, () =>
    Effect.gen(function* () {
      const state = BedrockRetry.state()
      const calls: LanguageModelV3CallOptions[] = []
      const model = { ...selected, api: scenario.api }
      const language: LanguageModelV3 = {
        specificationVersion: "v3",
        provider: "amazon-bedrock",
        modelId: model.id,
        supportedUrls: {},
        doGenerate: async () => {
          throw new Error("stream-only fixture")
        },
        doStream: async (params) => {
          calls.push(params)
          expect(params.abortSignal?.aborted).toBe(false)
          if (!scenario.guarded && calls.length === 1)
            throw new APICallError({
              message: "scripted SDK retry",
              url: "https://offline.invalid",
              requestBodyValues: {},
              statusCode: 429,
              responseHeaders: { "retry-after-ms": "0" },
              isRetryable: true,
            })
          return {
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] })
                controller.enqueue({ type: "response-metadata", id: "scripted-response" })
                controller.enqueue({ type: "text-start", id: "text" })
                controller.enqueue({
                  type: "text-delta",
                  id: "text",
                  delta: "answer",
                  providerMetadata: { bedrock: { fixture: true } },
                })
                controller.enqueue({ type: "text-end", id: "text" })
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop", raw: "stop" },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                })
                controller.close()
              },
            }),
          }
        },
      }
      const provider: Provider.Info = {
        id: model.providerID,
        name: "Scripted Bedrock",
        source: "config",
        env: [],
        options: scenario.options,
        models: { [model.id]: model },
      }
      const services = yield* Layer.build(
        LLM.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Auth.Service, { get: () => Effect.succeed(undefined) }),
              Layer.mock(Config.Service, { get: () => Effect.succeed({}) }),
              Layer.mock(Provider.Service, {
                getLanguage: () => Effect.succeed(language),
                getProvider: () => Effect.succeed(provider),
              }),
              Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
              Layer.mock(LLMClient.Service, {}),
              RuntimeFlags.layer({ experimentalNativeLlm: false }),
            ),
          ),
        ),
      )
      const sessionID = SessionID.make("ses_bedrock_wiring")
      const tools: Record<string, Tool> = scenario.hosted
        ? {
            hosted: {
              type: "provider",
              id: "bedrock.hosted",
              args: { marker: "untouched" },
              inputSchema: jsonSchema({ type: "object", properties: {} }),
            },
          }
        : {}
      const events = yield* Context.get(services, LLM.Service)
        .stream({
          sessionID,
          user: {
            id: MessageID.make("msg_bedrock_wiring"),
            sessionID,
            role: "user",
            time: { created: 1 },
            agent: "build",
            model: { providerID: model.providerID, modelID: model.id },
          },
          model,
          agent: { name: "build", mode: "primary", permission: [], options: {}, temperature: 0.25 },
          system: [],
          messages: [{ role: "user", content: "offline only" }],
          tools,
          retries: 1,
          bedrockRetry: state,
        })
        .pipe(Stream.runCollect)

      expect(calls).toHaveLength(scenario.guarded ? 1 : 2)
      expect(state.active).toBe(scenario.guarded)
      expect(state.attempts).toBe(scenario.guarded ? 1 : 0)
      expect(state.committed).toBe(scenario.guarded)
      expect(state.error).toBeUndefined()
      expect(state.unknownUsageAttempts).toBe(0)
      expect(events).toContainEqual(expect.objectContaining({ type: "text-delta", text: "answer" }))
      for (const call of calls) {
        expect(call.headers).toMatchObject({ "x-scripted": "preserved", "x-session-affinity": sessionID })
        expect(call.temperature).toBe(0.25)
        expect(call.prompt).toContainEqual({ role: "user", content: [{ type: "text", text: "offline only" }] })
        expect(call.abortSignal).toBeDefined()
        expect(call.abortSignal?.aborted).toBe(true)
      }
      if (!scenario.guarded) expect(calls[0].abortSignal).toBe(calls[1].abortSignal)
      if (scenario.hosted)
        expect(calls[1].tools).toEqual([
          { type: "provider", name: "hosted", id: "bedrock.hosted", args: { marker: "untouched" } },
        ])
    }),
  )
}
