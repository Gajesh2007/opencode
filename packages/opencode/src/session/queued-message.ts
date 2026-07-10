type SessionMessage =
  | { id: string; role: "user"; time: unknown }
  | { id: string; role: "assistant"; time: { completed?: number } }

export function isQueuedUserMessage(messages: readonly SessionMessage[], messageID: string) {
  const message = messages.find((message) => message.id === messageID)
  if (message?.role !== "user") return false

  const pending = messages.findLast((message) => message.role === "assistant" && !message.time.completed)
  return !!pending && message.id > pending.id
}
