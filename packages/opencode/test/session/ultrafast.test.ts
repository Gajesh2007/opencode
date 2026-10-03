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

describe("OpenAI Ultrafast", () => {
  test("offers the tier for supported direct API models and snapshots", () => {
    for (const id of ["gpt-6-astra", "gpt-6-astra-2026-09-01", "gpt-5.6-sol", "gpt-5.6-sol-2026-07-09"]) {
      expect(ProviderTransform.serviceTiers(model(id)).ultrafast).toEqual({ serviceTier: "ultrafast" })
    }
    expect(ProviderTransform.serviceTiers(model("gpt-5.6-sol"))).toMatchObject({
      priority: { serviceTier: "priority" },
      flex: { serviceTier: "flex" },
    })
  })

  test("does not offer the tier for other providers or unsupported models", () => {
    for (const id of ["gpt-4o", "gpt-5.4", "gpt-5.6-terra", "gpt-6-astra-mini", "gpt-6-astra-pro"]) {
      expect(ProviderTransform.serviceTiers(model(id)).ultrafast).toBeUndefined()
    }
    for (const [providerID, npm] of [
      ["openai-codex", "@ai-sdk/openai"],
      ["openrouter", "@openrouter/ai-sdk-provider"],
      ["vercel", "@ai-sdk/gateway"],
      ["custom", "@ai-sdk/openai"],
    ]) {
      expect(ProviderTransform.serviceTiers(model("gpt-6-astra", providerID, npm)).ultrafast).toBeUndefined()
    }
    const alias = { ...model(), id: ModelID.make("my-astra") }
    expect(ProviderTransform.serviceTiers(alias).ultrafast).toEqual({ serviceTier: "ultrafast" })
  })
})

const it = testEffect(RuntimeFlags.layer({}))

it.effect("merges Ultrafast into OpenAI options without changing reasoning or opting in other requests", () =>
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const sessionID = SessionID.make("ses_ultrafast")
    const current = model()
    const configured = { ...current, serviceTiers: ProviderTransform.serviceTiers(current) }
    const plugin: Plugin.Interface = {
      init: () => Effect.void,
      list: () => Effect.succeed([]),
      trigger: (_name, _input, output) => Effect.succeed(output),
    }

    for (const selection of ["ultrafast", "default", undefined]) {
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
        expect(options.openai.serviceTier).toBe(selection === "ultrafast" && !small ? "ultrafast" : undefined)
        if (!small) expect(options.openai.reasoningEffort).toBe("high")
        expect(prepared.headers).not.toHaveProperty("OpenAI-Service-Tier")
        expect(options.openrouter).toBeUndefined()
      }
    }
  }),
)
