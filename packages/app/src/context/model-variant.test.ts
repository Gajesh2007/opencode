import { describe, expect, test } from "bun:test"
import {
  cycleModelVariant,
  getConfiguredAgentVariant,
  getModelVariantPresentation,
  resolveModelVariant,
} from "./model-variant"

describe("model variant", () => {
  test("resolves configured agent variant when model matches", () => {
    const value = getConfiguredAgentVariant({
      agent: {
        model: { providerID: "openai", modelID: "gpt-5.2" },
        variant: "xhigh",
      },
      model: {
        providerID: "openai",
        modelID: "gpt-5.2",
        variants: { low: {}, high: {}, xhigh: {} },
      },
    })

    expect(value).toBe("xhigh")
  })

  test("ignores configured variant when model does not match", () => {
    const value = getConfiguredAgentVariant({
      agent: {
        model: { providerID: "openai", modelID: "gpt-5.2" },
        variant: "xhigh",
      },
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        variants: { low: {}, high: {}, xhigh: {} },
      },
    })

    expect(value).toBeUndefined()
  })

  test("prefers selected variant over configured variant", () => {
    const value = resolveModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: "high",
      configured: "xhigh",
    })

    expect(value).toBe("high")
  })

  test("lets an explicit default override the configured variant", () => {
    const value = resolveModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: null,
      configured: "xhigh",
    })

    expect(value).toBeUndefined()
  })

  test("cycles from configured variant to next", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: undefined,
      configured: "high",
    })

    expect(value).toBe("xhigh")
  })

  test("wraps from configured last variant to first", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: undefined,
      configured: "xhigh",
    })

    expect(value).toBe("low")
  })

  test("cycles from an explicit default to the first variant", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: null,
      configured: "xhigh",
    })

    expect(value).toBe("low")
  })

  test("presents Ultra with its delegation description and proactive usage warning", () => {
    expect(getModelVariantPresentation("ultra")).toMatchInlineSnapshot(`
      {
        "description": "Maximum reasoning with automatic task delegation",
        "label": "Ultra",
        "warning": "Ultra can significantly increase usage and cost. Proactive agents can increase usage further.",
      }
    `)
  })

  test("includes a concurrency-specific Ultra warning when a high cap is available", () => {
    expect(getModelVariantPresentation("ultra", { subagentConcurrency: 8 }).warning).toBe(
      "Ultra can significantly increase usage and cost with up to 8 concurrent agents.",
    )
  })

  test("preserves arbitrary variant labels and Ultra cycling order", () => {
    expect(getModelVariantPresentation("custom-effort")).toEqual({ label: "custom-effort" })
    expect(
      cycleModelVariant({
        variants: ["low", "high", "ultra"],
        selected: "high",
        configured: undefined,
      }),
    ).toBe("ultra")
    expect(
      cycleModelVariant({
        variants: ["low", "high", "ultra"],
        selected: "ultra",
        configured: undefined,
      }),
    ).toBeUndefined()
  })
})
