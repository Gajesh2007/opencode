import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type { Agent } from "@/agent/agent"
import { ChildModel } from "@/agent/child-model"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { testEffect } from "../lib/effect"

const parent = { providerID: ProviderID.make("fixture"), modelID: ModelID.make("one"), variant: "high" }
const agent: Agent.Info = { name: "general", mode: "subagent", permission: [], options: {} }
const model: Provider.Model = {
  id: parent.modelID,
  providerID: parent.providerID,
  name: "Fixture model",
  api: { id: "one", npm: "@ai-sdk/gateway", url: "https://fixture.invalid" },
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128000, output: 8192 },
  options: {},
  headers: {},
  status: "active",
  release_date: "2026-01-01",
  variants: { high: { reasoningEffort: "high" }, custom: { reasoningEffort: "low" } },
  serviceTiers: { priority: { serviceTier: "priority" } },
  upstreams: ["origin"],
}
const it = testEffect(
  Layer.mock(Provider.Service, {
    getModel: (providerID, modelID) =>
      providerID !== parent.providerID || modelID === "missing"
        ? Effect.fail(new Provider.ModelNotFoundError({ providerID, modelID }))
        : Effect.succeed({
            ...model,
            id: modelID,
            variants: modelID === "two" ? { low: { reasoningEffort: "low" } } : model.variants,
            capabilities: { ...model.capabilities, toolcall: modelID !== "no-tools" },
          }),
  }),
)

describe("agent.child-model", () => {
  it.effect("preserves the current child selection rather than newer specialist defaults", () =>
    Effect.gen(function* () {
      const current = { ...parent, variant: "default", serviceTier: "priority", upstream: "origin" }
      const result = yield* ChildModel.resolve({
        agent: { ...agent, model: { ...parent, modelID: ModelID.make("two") }, variant: "low" },
        parent,
        current,
      })
      expect(result).toEqual({
        model: { providerID: parent.providerID, modelID: parent.modelID },
        variant: "default",
        serviceTier: "priority",
        upstream: "origin",
      })
    }),
  )

  it.effect("resets to current specialist defaults rather than the child's previous model", () =>
    Effect.gen(function* () {
      const result = yield* ChildModel.resolve({
        agent: { ...agent, model: { ...parent, modelID: ModelID.make("two") }, variant: "low" },
        parent,
        current: parent,
        resetModel: true,
      })
      expect(result.model.modelID).toBe(ModelID.make("two"))
      expect(result.variant).toBe("low")
    }),
  )

  it.effect("a model switch uses destination defaults, not the old named effort", () =>
    Effect.gen(function* () {
      const result = yield* ChildModel.resolve({ agent, parent, current: parent, model: "fixture/two" })
      expect(result.model.modelID).toBe(ModelID.make("two"))
      expect(result.variant).toBe("default")
    }),
  )

  it.effect("variant-only changes accept model-specific names and keep the model", () =>
    Effect.gen(function* () {
      const result = yield* ChildModel.resolve({ agent, parent, current: parent, variant: "custom" })
      expect(result.model.modelID).toBe(ModelID.make("one"))
      expect(result.variant).toBe("custom")
    }),
  )

  it.effect("default clears configured named effort without reapplying it", () =>
    Effect.gen(function* () {
      const result = yield* ChildModel.resolve({
        agent: { ...agent, model: parent, variant: "high" },
        parent,
        variant: "default",
      })
      expect(result.variant).toBe("default")
    }),
  )

  it.effect("retains compatible named tiers and upstreams without remapping", () =>
    Effect.gen(function* () {
      const result = yield* ChildModel.resolve({
        agent,
        parent: { ...parent, serviceTier: "priority", upstream: "origin" },
        model: "fixture/two",
      })
      expect(result).toMatchObject({ variant: "default", serviceTier: "priority", upstream: "origin" })
    }),
  )

  it.effect("effort-only changes preserve existing dynamically discovered upstream pins", () =>
    Effect.gen(function* () {
      const result = yield* ChildModel.resolve({
        agent,
        parent,
        current: { ...parent, upstream: "dynamic-origin" },
        variant: "custom",
      })
      expect(result.upstream).toBe("dynamic-origin")
      expect(result.variant).toBe("custom")
    }),
  )

  it.effect("specialist defaults cannot carry an incompatible parent pin during explicit selection", () =>
    Effect.gen(function* () {
      const error = yield* ChildModel.resolve({
        agent: { ...agent, model: { ...parent, modelID: ModelID.make("two") } },
        parent: { ...parent, upstream: "dynamic-origin" },
        variant: "low",
      }).pipe(Effect.flip)
      expect(error.message).toContain("Upstream pin")
    }),
  )

  for (const input of [
    { selection: { model: "missing" }, message: /provider\/model/ },
    { selection: { model: "fixture/missing" }, message: /unavailable or disallowed/ },
    { selection: { model: "fixture/two", variant: "high" }, message: /not supported/ },
    { selection: { variant: " " }, message: /variant must/ },
    { selection: { resetModel: true, model: "fixture/two" }, message: /cannot be combined/ },
    { selection: { model: "fixture/no-tools" }, message: /tool calls/ },
  ]) {
    it.effect(`rejects invalid explicit selection ${JSON.stringify(input.selection)}`, () =>
      Effect.gen(function* () {
        const error = yield* ChildModel.resolve({ agent, parent, ...input.selection }).pipe(Effect.flip)
        expect(error.message).toMatch(input.message)
      }),
    )
  }

  it.effect("omitted legacy selections do not require provider catalog admission", () =>
    Effect.gen(function* () {
      const result = yield* ChildModel.resolve({
        agent,
        parent: { providerID: ProviderID.make("unavailable"), modelID: ModelID.make("legacy"), variant: "legacy" },
      })
      expect(result.model.providerID).toBe(ProviderID.make("unavailable"))
      expect(result.variant).toBe("legacy")
    }),
  )
})
