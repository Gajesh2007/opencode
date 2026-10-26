import { describe, expect, test } from "bun:test"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { ModelSelection } from "@opencode/core/model-selection"

function model(id: string, packageName: string) {
  return { ...Model.Info.default(Provider.ID.make("test"), Model.ID.make(id)), package: packageName }
}

describe("independent model routing controls", () => {
  test("keeps custom tier headers off the provider body and supports disabled tiers", () => {
    const info = {
      ...model("gpt-6.1-sol", "@opencode/ai/providers/openai"),
      serviceTiers: {
        priority: { disabled: true },
        custom: { serviceTier: "flex", headers: { "x-test-tier": "custom" } },
      },
    }
    expect(ModelSelection.tiers(info).priority).toBeUndefined()
    expect(ModelSelection.options(info, { id: info.id, providerID: info.providerID, serviceTier: "custom" })).toEqual({
      serviceTier: "flex",
    })
    expect(ModelSelection.route(model("model", "@opencode/ai/providers/cloudflare-ai-gateway"))).toBeUndefined()
  })
  test("preserves Pro separately from tier and effort for gateway models", () => {
    const info = model("openai/gpt-5.6-sol", "@opencode/ai/providers/vercel-ai-gateway")
    expect(
      ModelSelection.options(info, {
        id: info.id,
        providerID: info.providerID,
        variant: Model.VariantID.make("max"),
        reasoningMode: "pro",
        serviceTier: "priority",
      }),
    ).toEqual({ reasoningMode: "pro", gateway: { serviceTier: "priority" } })
  })
  test("offers direct OpenAI priority and ultrafast without changing reasoning", () => {
    const info = model("gpt-6.1-sol", "@opencode/ai/providers/openai/responses")
    expect(ModelSelection.tiers(info)).toEqual({
      priority: { serviceTier: "priority" },
      ultrafast: { serviceTier: "ultrafast" },
    })
    expect(
      ModelSelection.options(info, {
        id: info.id,
        providerID: info.providerID,
        variant: Model.VariantID.make("max"),
        serviceTier: "ultrafast",
      }),
    ).toEqual({ serviceTier: "ultrafast" })
  })
  test("keeps gateway sorting and an explicit upstream pin together", () => {
    const info = model("openai/gpt-6.1-sol", "@opencode/ai/providers/vercel-ai-gateway")
    expect(
      ModelSelection.options(info, {
        id: info.id,
        providerID: info.providerID,
        serviceTier: "throughput",
        upstream: "openai",
      }),
    ).toEqual({ gateway: { sort: "tps", only: ["openai"] } })
    expect(ModelSelection.tiers(info).priority).toEqual({ gateway: { serviceTier: "priority" } })
  })
  test("routes Anthropic fast mode under the gateway upstream namespace", () => {
    const info = model("anthropic/claude-opus-5", "@opencode/ai/providers/vercel-ai-gateway")
    expect(ModelSelection.tiers(info).fast).toEqual({ upstream: { anthropic: { speed: "fast" } } })
    expect(ModelSelection.tiers(model("claude-opus-5", "@opencode/ai/providers/anthropic")).fast).toEqual({
      speed: "fast",
    })
  })
  test("uses OpenRouter's routing shape and ignores pins on direct providers", () => {
    const info = model("openai/gpt-6.1-sol", "@opencode/ai/providers/openrouter")
    expect(
      ModelSelection.options(info, {
        id: info.id,
        providerID: info.providerID,
        serviceTier: "cheapest",
        upstream: "Azure",
      }),
    ).toEqual({ provider: { sort: "price", only: ["Azure"] } })
    expect(
      ModelSelection.options(model("gpt-6.1-sol", "@opencode/ai/providers/openai"), {
        id: info.id,
        providerID: info.providerID,
        upstream: "Azure",
      }),
    ).toEqual({})
  })
})
