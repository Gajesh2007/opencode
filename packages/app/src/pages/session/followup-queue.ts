export type QueuedFollowup = { id: string }

export function removeQueuedFollowup<Item extends QueuedFollowup>(items: readonly Item[], id: string) {
  return items.filter((item) => item.id !== id)
}

export function shouldSendQueuedFollowupOnEscape(input: { working: boolean; popover: boolean; shell: boolean }) {
  return input.working && !input.popover && !input.shell
}

export function queuedFollowupForEscape<Item extends QueuedFollowup>(input: {
  items: readonly Item[]
  busy: boolean
  dialogOpen: boolean
  composing: boolean
  sending: boolean
  defaultPrevented: boolean
  blocked: boolean
  consumeWhileSending?: boolean
}) {
  if (
    !input.busy ||
    input.dialogOpen ||
    input.composing ||
    (input.sending && !input.consumeWhileSending) ||
    input.defaultPrevented ||
    input.blocked
  )
    return
  return input.items[0]
}

export function createFollowupSendLock() {
  let pending = false

  return {
    pending: () => pending,
    async run(send: () => Promise<unknown>) {
      if (pending) return false
      pending = true
      try {
        await send()
        return true
      } finally {
        pending = false
      }
    },
  }
}
