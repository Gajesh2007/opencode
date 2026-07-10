import { expect, test } from "bun:test"
import { dict } from "@/i18n/en"

test("offers chat-only and full restore", () => {
  expect({
    chat: dict["session.revertDock.restoreChat"],
    code: dict["session.revertDock.restoreCode"],
  }).toMatchInlineSnapshot(`
    {
      "chat": "Restore chat",
      "code": "Restore code + conversation",
    }
  `)
})
