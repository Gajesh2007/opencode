import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Plugin } from "../../src/plugin"
import type { Provider } from "../../src/provider/provider"
import { ProviderTransform } from "../../src/provider/transform"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { LLMRequestPrep } from "../../src/session/llm/request"
import { MessageID, SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

function model(id = "gpt-6-astra", providerID = "openai", npm = "@ai-sdk/openai"): Provider.Model {
  return {
    id: ModelID.make(id),
    providerID: ProviderID.make(providerID),
    api: { id, npm, url: "https://api.openai.com/v1" },
    name: id,
    family: "gpt",
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 1_000_000, output: 128_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-09-01",
    variants: { high: { reasoningEffort: "high" } },
  }
}

describe("Responses API Ultrafast", () => {
  test("offers the tier for supported direct API models and snapshots", () => {
    for (const id of [
      "gpt-6-astra",
      "gpt-6-astra-2026-09-01",
      "gpt-5.6-sol",
      "gpt-5.6-sol-2026-07-09",
      "gpt-6.1-sol",
      "gpt-6-1-sol",
      "gpt-6.1-sol-2026-10-01",
      "openai/gpt-6.1-sol",
    ]) {
      for (const [providerID, npm] of [
        ["openai", "@ai-sdk/openai"],
        ["custom", "@ai-sdk/openai"],
        ["azure", "@ai-sdk/azure"],
        ["azure-cognitive-services", "@ai-sdk/azure"],
      ]) {
        expect(ProviderTransform.serviceTiers(model(id, providerID, npm)).ultrafast).toEqual({
          serviceTier: "ultrafast",
        })
      }
    }
    expect(ProviderTransform.serviceTiers(model("gpt-5.6-sol"))).toMatchObject({
      priority: { serviceTier: "priority" },
      flex: { serviceTier: "flex" },
    })
  })

  test("offers only Ultrafast for Bedrock Runtime and Mantle models", () => {
    for (const npm of ["@ai-sdk/openai", "@ai-sdk/amazon-bedrock/mantle"]) {
      for (const prefix of ["", "us.", "global."]) {
        for (const id of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-sol-2026-10-01"]) {
          expect(ProviderTransform.serviceTiers(model(`${prefix}openai.${id}`, "amazon-bedrock", npm))).toEqual({
            ultrafast: { serviceTier: "ultrafast" },
          })
        }
      }
    }
  })

  test("offers opt-in Ultrafast for Codex Sol 6.1, Astra and snapshots", () => {
    for (const id of [
      "gpt-6.1-sol",
      "gpt-6-1-sol",
      "gpt-6.1-sol-2026-10-01",
      "gpt-6-astra",
      "gpt-6-astra-2026-09-01",
    ]) {
      expect(ProviderTransform.serviceTiers(model(id, "openai-codex")).ultrafast).toEqual({
        serviceTier: "ultrafast",
      })
    }
  })

  test("does not offer the tier for other protocols, subscriptions or unsupported models", () => {
    for (const id of [
      "gpt-4o",
      "gpt-5.4",
      "gpt-5.6-terra",
      "gpt-6-astra-mini",
      "gpt-6-astra-pro",
      "gpt-6.1",
      "gpt-6.1-sol-mini",
      "gpt-6.1-sol-pro",
      "us.openai.gpt-6.1-sol-pro",
    ]) {
      expect(ProviderTransform.serviceTiers(model(id)).ultrafast).toBeUndefined()
    }
    for (const [providerID, npm] of [
      ["openrouter", "@openrouter/ai-sdk-provider"],
      ["vercel", "@ai-sdk/gateway"],
      ["custom", "@ai-sdk/openai-compatible"],
      ["custom", "@ai-sdk/amazon-bedrock/mantle"],
      ["amazon-bedrock", "@ai-sdk/amazon-bedrock"],
    ]) {
      for (const id of ["gpt-6-astra", "gpt-6.1-sol", "openai.gpt-6.1-sol"]) {
        expect(ProviderTransform.serviceTiers(model(id, providerID, npm)).ultrafast).toBeUndefined()
      }
    }
    const alias = { ...model(), id: ModelID.make("my-astra") }
    expect(ProviderTransform.serviceTiers(alias).ultrafast).toEqual({ serviceTier: "ultrafast" })
    for (const id of ["gpt-6-astra-mini", "gpt-6-astra-pro", "gpt-5.6-sol", "gpt-6.1-sol-mini"]) {
      expect(ProviderTransform.serviceTiers(model(id, "openai-codex")).ultrafast).toBeUndefined()
    }
  })
})

const it = testEffect(RuntimeFlags.layer({}))

test("offers Priority alongside Ultrafast for GPT 6.1 Sol and snapshots", () => {
  for (const id of ["gpt-6.1-sol", "gpt-6-1-sol", "gpt-6.1-sol-2026-10-01", "openai/gpt-6.1-sol"]) {
    expect(ProviderTransform.serviceTiers(model(id))).toEqual({
      priority: { serviceTier: "priority" },
      ultrafast: { serviceTier: "ultrafast" },
    })
  }
  for (const id of ["gpt-6.1", "gpt-6.1-sol-mini", "gpt-6.1-sol-pro"]) {
    expect(ProviderTransform.serviceTiers(model(id)).priority).toBeUndefined()
  }
})

test("offers Priority alongside Ultrafast for GPT 6 Astra", () => {
  for (const providerID of ["openai", "openai-codex"]) {
    for (const id of ["gpt-6-astra", "gpt-6-astra-2026-09-01"]) {
      const tiers = ProviderTransform.serviceTiers(model(id, providerID))
      expect(tiers.priority).toEqual({ serviceTier: "priority" })
      expect(tiers.ultrafast).toEqual({ serviceTier: "ultrafast" })
    }
  }
  for (const id of ["gpt-6-astra-mini", "gpt-6-astra-pro"]) {
    expect(ProviderTransform.serviceTiers(model(id)).priority).toBeUndefined()
  }
})

for (const current of [
  model(),
  model("gpt-6.1-sol"),
  model("gpt-6.1-sol", "openai-codex"),
  model("gpt-6.1-sol", "custom"),
  model("gpt-6.1-sol", "azure", "@ai-sdk/azure"),
  model("us.openai.gpt-6.1-sol", "amazon-bedrock"),
  model("global.openai.gpt-6.1-sol", "amazon-bedrock"),
  model("openai.gpt-6.1-sol", "amazon-bedrock", "@ai-sdk/amazon-bedrock/mantle"),
].flatMap((current) => [
  current,
  { ...current, id: ModelID.make(`${current.id}-ultrafast`), options: { serviceTier: "ultrafast" } },
])) {
  it.effect(
    `merges Ultrafast for ${current.providerID}/${current.id} without changing reasoning or other requests`,
    () =>
      Effect.gen(function* () {
        const flags = yield* RuntimeFlags.Service
        const sessionID = SessionID.make("ses_ultrafast")
        const configured = { ...current, serviceTiers: ProviderTransform.serviceTiers(current) }
        const plugin: Plugin.Interface = {
          init: () => Effect.void,
          list: () => Effect.succeed([]),
          trigger: (_name, _input, output) => Effect.succeed(output),
        }

        for (const [selection, expected] of [
          ["ultrafast", "ultrafast"],
          ["default", current.options.serviceTier === "ultrafast" ? "default" : undefined],
          [undefined, current.options.serviceTier],
        ]) {
          for (const small of [false, true]) {
            const prepared = yield* LLMRequestPrep.prepare({
              user: {
                id: MessageID.make("msg_ultrafast"),
                sessionID,
                role: "user",
                time: { created: 1 },
                agent: "build",
                model: { providerID: current.providerID, modelID: current.id, variant: "high", serviceTier: selection },
              },
              sessionID,
              model: configured,
              agent: { name: "build", mode: "primary", permission: [], options: {} },
              system: [],
              messages: [{ role: "user", content: "hello" }],
              tools: {},
              provider: {
                id: current.providerID,
                name: "OpenAI API",
                source: "config",
                env: [],
                options: {},
                models: { [current.id]: configured },
              },
              auth: { type: "api", key: "test-key" },
              plugin,
              flags,
              isWorkflow: false,
              small,
            })
            const options = ProviderTransform.providerOptions(configured, prepared.params.options)
            expect(prepared.system.join("\n")).toContain(
              `The selected model ID is ${current.providerID}/${current.id}. The API model ID is ${current.api.id}.`,
            )
            expect(options.openai.serviceTier).toBe(small ? current.options.serviceTier : expected)
            if (current.api.npm === "@ai-sdk/azure") expect(options.azure).toEqual(options.openai)
            if (!small) expect(options.openai.reasoningEffort).toBe("high")
            expect(prepared.headers).not.toHaveProperty("OpenAI-Service-Tier")
            expect(options.openrouter).toBeUndefined()
          }
        }
      }),
  )
}
