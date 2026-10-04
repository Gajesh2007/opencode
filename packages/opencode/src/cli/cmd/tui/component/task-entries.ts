import type { AssistantMessage, Message, Part, Session, SessionStatus } from "@opencode-ai/sdk/v2"

type Data = {
  session: Session[]
  session_status: Record<string, SessionStatus | undefined>
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
}

export function taskEntries(data: Data) {
  const background = new Set<string>()
  const started = new Map<string, number>()
  const results = new Map<string, { state: unknown; time: number }>()

  for (const parts of Object.values(data.part)) {
    for (const part of parts ?? []) {
      if (part.type !== "tool" || part.state.status === "pending") continue
      const launch = ["task", "spawn_agent", "followup_task"].includes(part.tool)
      if (!launch && part.tool !== "task_status" && part.tool !== "interrupt_agent") continue
      const meta = part.state.metadata ?? {}
      const id = part.tool === "task_status" ? meta.task_id : (meta.sessionId ?? meta.session_id)
      if (typeof id !== "string") continue

      if (launch) {
        if (meta.background === true || part.tool !== "task") background.add(id)
        started.set(id, Math.max(started.get(id) ?? 0, part.state.time.start))
      }

      // A completed launch only acknowledges delegation, not the child's result.
      const state =
        launch && part.state.status === "error"
          ? "error"
          : !launch && part.state.status === "completed"
            ? (meta.state ?? meta.status)
            : undefined
      if (state === undefined || part.state.status === "running") continue
      if ((results.get(id)?.time ?? 0) > part.state.time.end) continue
      results.set(id, { state, time: part.state.time.end })
    }
  }

  return data.session
    .filter((session) => session.parentID !== undefined)
    .map((session) => ({
      session,
      category: taskCategory(data, session, started.get(session.id), results.get(session.id)),
      background: background.has(session.id),
    }))
    .toSorted((a, b) => {
      const running = Number(b.category === "Running") - Number(a.category === "Running")
      return running || b.session.time.updated - a.session.time.updated
    })
}

function taskCategory(data: Data, session: Session, started = 0, result?: { state: unknown; time: number }) {
  const status = data.session_status[session.id]
  if (status?.type === "busy" || status?.type === "retry") return "Running"

  const messages = data.message[session.id]
  // Ignore inherited fork history and results from a turn preceding a followup.
  const since = Math.max(session.time.created, started)
  const user = messages?.findLast((message) => {
    if (message.role !== "user" || message.time.created < since) return false
    const parts = data.part[message.id]
    // Queued mail is ignored until delivered. Unloaded parts may still contain a real prompt.
    return parts === undefined || parts.some((part) => part.type !== "text" || (!part.ignored && part.text !== ""))
  })
  const assistant = messages?.findLast(
    (message): message is AssistantMessage =>
      message.role === "assistant" && message.time.created >= Math.max(since, user?.time.created ?? 0),
  )
  const latest = Math.max(since, user?.time.created ?? 0, assistant?.time.completed ?? assistant?.time.created ?? 0)
  if (result && result.time >= latest) {
    if (result.state === "completed") return "Completed"
    if (result.state === "error") return "Failed"
    if (result.state === "cancelled" || result.state === "interrupted") return "Interrupted"
  }
  if (assistant?.error) return assistant.error.name === "MessageAbortedError" ? "Interrupted" : "Failed"
  if (
    assistant?.time.completed !== undefined &&
    assistant.finish &&
    !["tool-calls", "unknown"].includes(assistant.finish)
  )
    return "Completed"
  if (assistant) return "No final output"
  if (user || !messages) return "No output"
  return "Not started"
}
