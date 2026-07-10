import { describe, expect, test } from "bun:test"
import { isQueuedUserMessage } from "../../src/session/queued-message"

describe("queued session messages", () => {
  test("identifies user messages queued after an unfinished assistant message", () => {
    const messages = [
      { id: "message_1", role: "user", time: {} },
      { id: "message_2", role: "assistant", time: {} },
      { id: "message_3", role: "user", time: {} },
      { id: "message_4", role: "user", time: {} },
    ] as const

    expect(isQueuedUserMessage(messages, "message_3")).toBe(true)
    expect(isQueuedUserMessage(messages, "message_4")).toBe(true)
    expect(isQueuedUserMessage(messages, "message_1")).toBe(false)
  })

  test("does not identify messages as queued once the assistant is complete", () => {
    const messages = [
      { id: "message_1", role: "user", time: {} },
      { id: "message_2", role: "assistant", time: { completed: 1 } },
      { id: "message_3", role: "user", time: {} },
    ] as const

    expect(isQueuedUserMessage(messages, "message_3")).toBe(false)
  })
})
