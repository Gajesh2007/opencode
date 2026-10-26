import { expect, test } from "bun:test"
import path from "node:path"
import { createModelPreferenceRepository, decodeModelPreference } from "../src/model-preference"
import { tmpdir } from "./fixture/fixture"

test("repairs known model preferences and preserves unrelated fields", () => {
  expect(
    decodeModelPreference({
      unrelated: { keep: true },
      recent: [{ providerID: "openai", modelID: "gpt-5", ignored: true }, null],
      favorite: "malformed",
      variant: { "openai/gpt-5": "high", default: "default", invalid: 42 },
    }),
  ).toEqual({
    unrelated: { keep: true },
    recent: [{ providerID: "openai", modelID: "gpt-5" }],
    favorite: [],
    variant: { "openai/gpt-5": "high", default: "default" },
  })
})

test("atomically serializes model preference updates", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "model.json")
  await Bun.write(file, JSON.stringify({ unrelated: "keep", favorite: [], variant: {} }))
  const repository = createModelPreferenceRepository(file)
  const openai = { providerID: "openai", modelID: "org/gpt-5" }
  const anthropic = { providerID: "anthropic", modelID: "claude/sonnet" }

  await Promise.all([
    repository.addRecent(openai),
    repository.saveVariant(openai, "high"),
    repository.saveVariant(anthropic, "low"),
  ])
  expect(await Bun.file(file).json()).toEqual({
    unrelated: "keep",
    recent: [openai],
    favorite: [],
    variant: { "openai/org/gpt-5": "high", "anthropic/claude/sonnet": "low" },
  })

  await repository.saveVariant(openai, "default")
  expect(await repository.resolveVariant(openai)).toBeUndefined()
  expect((await Bun.file(file).json()).variant).toEqual({
    "openai/org/gpt-5": "default",
    "anthropic/claude/sonnet": "low",
  })
})

test("persists service tier and upstream separately from reasoning variants", async () => {
  await using tmp = await tmpdir()
  const repository = createModelPreferenceRepository(path.join(tmp.path, "model.json"))
  const model = { providerID: "gateway", modelID: "openai/gpt-6.1-sol" }
  await Promise.all([
    repository.saveVariant(model, "max"),
    repository.saveSelection("serviceTier", model, "priority"),
    repository.saveSelection("upstream", model, "openai"),
    repository.saveSelection("reasoningMode", model, "pro"),
  ])
  expect(await repository.load()).toMatchObject({
    variant: { "gateway/openai/gpt-6.1-sol": "max" },
    serviceTier: { "gateway/openai/gpt-6.1-sol": "priority" },
    upstream: { "gateway/openai/gpt-6.1-sol": "openai" },
    reasoningMode: { "gateway/openai/gpt-6.1-sol": "pro" },
  })
  await repository.saveSelection("serviceTier", model, undefined)
  expect((await repository.load()).serviceTier).toEqual({ "gateway/openai/gpt-6.1-sol": "default" })
  expect((await repository.load()).upstream).toEqual({ "gateway/openai/gpt-6.1-sol": "openai" })
})
