import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { testEffect } from "../lib/effect"

const azure = ["azure", "azure-cognitive-services"]
const catalog = Object.fromEntries(
  [...azure, "custom-azure"].map((id) => [
    id,
    {
      id,
      name: id,
      env: ["AZURE_ULTRAFAST_TEST_KEY"],
      npm: "@ai-sdk/azure",
      api: "https://ultrafast.openai.azure.com/openai",
      models: {
        "gpt-6.1-sol": {
          id: "gpt-6.1-sol",
          name: "Sol 6.1",
          release_date: "2026-10-01",
          attachment: true,
          reasoning: true,
          temperature: false,
          tool_call: true,
          limit: { context: 1_000_000, output: 128_000 },
        },
      },
    } satisfies ModelsDev.Provider,
  ]),
)

const it = testEffect(
  Provider.layer.pipe(
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provideMerge(Env.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Layer.mock(ModelsDev.Service, { get: () => Effect.succeed(catalog) })),
    Layer.provide(RuntimeFlags.layer({})),
  ),
)

for (const entry of [
  {
    name: "defaults to Responses with Ultrafast and an automatic alias",
    provider: undefined,
    model: undefined,
    alias: undefined,
    chat: false,
    aliasVisible: true,
  },
  {
    name: "provider Chat selection hides Ultrafast and the automatic alias",
    provider: true,
    model: undefined,
    alias: undefined,
    chat: true,
    aliasVisible: false,
  },
  {
    name: "model false overrides provider Chat without changing the automatic alias route",
    provider: true,
    model: false,
    alias: undefined,
    chat: false,
    aliasVisible: false,
  },
  {
    name: "model Chat overrides provider Responses without changing the automatic alias route",
    provider: false,
    model: true,
    alias: undefined,
    chat: true,
    aliasVisible: true,
  },
  {
    name: "explicit alias false overrides provider Chat",
    provider: true,
    model: undefined,
    alias: false,
    chat: true,
    aliasVisible: true,
  },
  {
    name: "custom Azure SDK ignores the built-in Chat selection flag",
    provider: true,
    model: true,
    alias: undefined,
    chat: false,
    aliasVisible: true,
    custom: true,
  },
]) {
  const ids = "custom" in entry ? ["custom-azure"] : azure
  it.instance(
    `Azure Ultrafast: ${entry.name}`,
    () =>
      Effect.gen(function* () {
        yield* Env.use.set("AZURE_ULTRAFAST_TEST_KEY", "test-key")
        const provider = yield* Provider.Service
        for (const id of ids) {
          const info = yield* provider.getProvider(ProviderID.make(id))
          const model = yield* provider.getModel(ProviderID.make(id), ModelID.make("gpt-6.1-sol"))
          expect((yield* provider.getLanguage(model)).provider).toBe(entry.chat ? "azure.chat" : "azure.responses")
          expect(model.serviceTiers?.ultrafast).toEqual(entry.chat ? undefined : { serviceTier: "ultrafast" })
          expect(model.options.serviceTier).toBeUndefined()
          expect(info.models["gpt-6.1-sol-ultrafast"] !== undefined).toBe(entry.aliasVisible)
          if (!entry.aliasVisible) continue
          const alias = yield* provider.getModel(ProviderID.make(id), ModelID.make("gpt-6.1-sol-ultrafast"))
          expect((yield* provider.getLanguage(alias)).provider).toBe("azure.responses")
          expect(alias.api.id).toBe("gpt-6.1-sol")
          expect(alias.options.serviceTier).toBe("ultrafast")
          expect(alias.serviceTiers?.ultrafast).toEqual({ serviceTier: "ultrafast" })
        }
      }),
    {
      config: {
        enabled_providers: ids,
        provider: Object.fromEntries(
          ids.map((id) => [
            id,
            {
              options: {
                apiKey: "test-key",
                baseURL: "https://ultrafast.openai.azure.com/openai",
                useCompletionUrls: entry.provider,
              },
              models: {
                ...(entry.model === undefined
                  ? {}
                  : { "gpt-6.1-sol": { options: { useCompletionUrls: entry.model } } }),
                ...(entry.alias === undefined
                  ? {}
                  : { "gpt-6.1-sol-ultrafast": { options: { useCompletionUrls: entry.alias } } }),
              },
            },
          ]),
        ),
      },
    },
  )
}
