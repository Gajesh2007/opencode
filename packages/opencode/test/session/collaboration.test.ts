import { describe, expect, test } from "bun:test"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { Provider } from "../../src/provider/provider"
import { collaborationGuidance } from "../../src/session/collaboration"

const ultraModel = {
  id: ModelID.make("gpt-5.6-terra"),
  providerID: ProviderID.make("openai"),
  api: {
    id: "gpt-5.6-terra",
    url: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
  },
  name: "GPT-5.6 Terra",
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
  limit: { context: 128_000, output: 16_384 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
} satisfies Provider.Model

describe("session collaboration guidance", () => {
  test("enables proactive delegation for Ultra primary agents", () => {
    const result = collaborationGuidance({ model: ultraModel, variant: "ultra", isChild: false })

    expect(result).toContain("primary agent")
    expect(result).toContain("system/developer collaboration guidance is the source of truth")
    expect(result).toContain("remains active across turns and follow-ups")
    expect(result).toContain("Spawned agents may spawn their own well-scoped subagents")
    expect(result).toContain("All descendants share the same root collaboration control plane")
    expect(result).toContain("Proactive multi-agent delegation is active")
    expect(result).toContain("Earlier explicit-request-only restrictions no longer apply")
    expect(result).toContain("four total concurrency slots, including the root session")
  })

  test("gives Ultra team agents persistent recursive delegation guidance", () => {
    const result = collaborationGuidance({ model: ultraModel, variant: "ultra", isChild: true })

    expect(result).toContain("team agent")
    expect(result).toContain("You can spawn your own well-scoped subagents using spawn_agent")
    expect(result).toContain("Results return to your direct parent")
    expect(result).toContain("Avoid duplicating work and continue local critical-path work")
    expect(result).toContain("Proactive multi-agent delegation is active")
  })

  test("keeps delegation explicit-only for other variants of Ultra-capable team agents", () => {
    const result = collaborationGuidance({ model: ultraModel, variant: "max", isChild: true })

    expect(result).toContain("team agent")
    expect(result).toContain("Results return to your direct parent")
    expect(result).toContain("Subagent delegation is explicit-only")
    expect(result).not.toContain("Proactive multi-agent delegation is active")
  })

  test("does not add guidance for models without Ultra capability", () => {
    const result = collaborationGuidance({
      model: { ...ultraModel, api: { ...ultraModel.api, id: "gpt-5.6-luna" } },
      variant: "ultra",
      isChild: false,
    })

    expect(result).toBeUndefined()
  })
})
