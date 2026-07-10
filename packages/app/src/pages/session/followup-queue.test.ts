import { describe, expect, test } from "bun:test"
import {
  createFollowupSendLock,
  queuedFollowupForEscape,
  removeQueuedFollowup,
  shouldSendQueuedFollowupOnEscape,
} from "./followup-queue"

const items = [
  { id: "message_1", text: "first" },
  { id: "message_2", text: "second" },
  { id: "message_3", text: "third" },
]

describe("queued followups", () => {
  test("retracts an item while preserving remaining queue order", () => {
    expect(removeQueuedFollowup(items, "message_2")).toEqual([items[0], items[2]])
  })

  test("sends the earliest queued item for focused composer Escape and preserves remaining order", async () => {
    const first = queuedFollowupForEscape({
      items,
      busy: true,
      dialogOpen: false,
      composing: false,
      sending: false,
      defaultPrevented: false,
      blocked: false,
    })

    const sent: string[] = []
    const lock = createFollowupSendLock()
    await lock.run(async () => {
      sent.push(first!.id)
    })

    expect(first).toEqual(items[0])
    expect(sent).toEqual(["message_1"])
    expect(removeQueuedFollowup(items, first!.id)).toEqual([items[1], items[2]])
  })

  test("lets a focused composer consume Escape while the queued send is in flight", () => {
    expect(
      queuedFollowupForEscape({
        items,
        busy: true,
        dialogOpen: false,
        composing: false,
        sending: true,
        defaultPrevented: false,
        blocked: false,
        consumeWhileSending: true,
      }),
    ).toEqual(items[0])
  })

  test("leaves Escape available to abort when the focused composer has no queued followup", () => {
    const queued = queuedFollowupForEscape({
      items: [],
      busy: true,
      dialogOpen: false,
      composing: false,
      sending: false,
      defaultPrevented: false,
      blocked: false,
    })

    expect(queued).toBeUndefined()
  })

  test("leaves Escape for prompt popovers and shell mode before queue dispatch", () => {
    expect(shouldSendQueuedFollowupOnEscape({ working: true, popover: true, shell: false })).toBe(false)
    expect(shouldSendQueuedFollowupOnEscape({ working: true, popover: false, shell: true })).toBe(false)
    expect(shouldSendQueuedFollowupOnEscape({ working: true, popover: false, shell: false })).toBe(true)
  })

  test("does not dispatch Escape from a blocked question", () => {
    expect(
      queuedFollowupForEscape({
        items,
        busy: true,
        dialogOpen: false,
        composing: false,
        sending: false,
        defaultPrevented: false,
        blocked: true,
      }),
    ).toBeUndefined()
  })

  test("selects the oldest queued item for an outside-focus Escape", () => {
    expect(
      queuedFollowupForEscape({
        items,
        busy: true,
        dialogOpen: false,
        composing: false,
        sending: false,
        defaultPrevented: false,
        blocked: false,
      }),
    ).toEqual(items[0])
  })

  test("does not take a queued item when Escape is guarded", () => {
    for (const input of [
      { busy: false, dialogOpen: false, composing: false, sending: false, defaultPrevented: false, blocked: false },
      { busy: true, dialogOpen: true, composing: false, sending: false, defaultPrevented: false, blocked: false },
      { busy: true, dialogOpen: false, composing: true, sending: false, defaultPrevented: false, blocked: false },
      { busy: true, dialogOpen: false, composing: false, sending: true, defaultPrevented: false, blocked: false },
      { busy: true, dialogOpen: false, composing: false, sending: false, defaultPrevented: true, blocked: false },
      { busy: true, dialogOpen: false, composing: false, sending: false, defaultPrevented: false, blocked: true },
      {
        busy: true,
        dialogOpen: false,
        composing: false,
        sending: false,
        defaultPrevented: false,
        blocked: false,
        items: [],
      },
    ]) {
      expect(queuedFollowupForEscape({ items, ...input })).toBeUndefined()
    }
  })

  test("does not send a second followup while the first is pending", async () => {
    const lock = createFollowupSendLock()
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let sends = 0

    const first = lock.run(async () => {
      sends += 1
      await pending
    })
    const second = await lock.run(async () => {
      sends += 1
    })

    expect(lock.pending()).toBe(true)
    expect(second).toBe(false)
    expect(sends).toBe(1)

    release!()
    expect(await first).toBe(true)
    expect(lock.pending()).toBe(false)
  })
})
