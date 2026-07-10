import { expect, test } from "bun:test"
import { getModelVariantPresentation } from "../../../src/cli/cmd/tui/component/model-variant"

test("TUI presents Ultra and retains arbitrary variant IDs", () => {
  expect([getModelVariantPresentation("ultra"), getModelVariantPresentation("custom-effort")]).toMatchInlineSnapshot(`
    [
      {
        "description": "Maximum reasoning with automatic task delegation",
        "label": "Ultra",
        "warning": "Ultra can significantly increase usage and cost. Proactive agents can increase usage further.",
      },
      {
        "label": "custom-effort",
      },
    ]
  `)
})

test("TUI includes the concurrency-specific Ultra warning when available", () => {
  expect(getModelVariantPresentation("ultra", { subagentConcurrency: 12 }).warning).toBe(
    "Ultra can significantly increase usage and cost with up to 12 concurrent agents.",
  )
})
