import { Effect, Option, References, Scope } from "effect"
import type { TaskPromptOps } from "@/agent/child-session"
import type { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import type { MessageV2 } from "@/session/message-v2"
import type { MessageID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { SessionStatus } from "@/session/status"

export type Deps = {
  sessions: Session.Interface
  status: SessionStatus.Interface
  bus: Bus.Interface
  /** Outlives the caller; the idle watcher and resumed loop run here. */
  scope: Scope.Scope
}

export type Toast = {
  title: string
  message: string
  variant: "info" | "success" | "warning" | "error"
}

export type DeliverInput = {
  ops: TaskPromptOps
  sessionID: SessionID
  /** Fallbacks for a session that has no agent or user model of its own yet. */
  agent: string
  model?: MessageV2.User["model"]
  text: string
  /** Lets clients render the notice; `source` identifies the producer ("shell" or "subagent"). */
  metadata: Record<string, unknown>
  /** Resume the session's loop once it is idle, announcing it with this toast. Omit to only record the notice. */
  wake?: Toast
}

/**
 * Records a background completion notice as a synthetic user message. A busy session sees it at
 * its next step. With `wake`, an idle session also starts a new turn to handle it, unless a newer
 * user message has superseded the notice or the user explicitly stopped the session. Subagent
 * sessions are never woken: their parent has already received their final reply.
 */
export const deliver = Effect.fn("BackgroundNotify.deliver")(function* (deps: Deps, input: DeliverInput) {
  const session = yield* deps.sessions.get(input.sessionID)
  // Recording a message commits a staged undo, which deletes the undone messages for good. A notice about
  // work from an undone turn must not do that behind the user's back, so it is dropped.
  if (session.revert) return
  const latest = yield* deps.sessions.findMessage(input.sessionID, (item) => item.info.role === "user")
  // A notice must not undo a model or agent selection changed after the work was launched.
  const model = Option.isSome(latest) && latest.value.info.role === "user" ? latest.value.info.model : input.model
  const message = yield* input.ops.prompt({
    sessionID: input.sessionID,
    noReply: true,
    agent: session.agent ?? input.agent,
    model: model ? { providerID: model.providerID, modelID: model.modelID } : undefined,
    variant: model?.variant ?? "default",
    reasoningMode: model?.reasoningMode,
    serviceTier: model?.serviceTier,
    upstream: model?.upstream,
    parts: [{ type: "text", synthetic: true, text: input.text, metadata: input.metadata }],
  })
  if (input.wake && !session.parentID)
    yield* resumeWhenIdle(deps, { ops: input.ops, sessionID: input.sessionID, userID: message.info.id, toast: input.wake })
      .pipe(Effect.ignore, Effect.forkIn(deps.scope, { startImmediately: true }), detach)
  return message
})

const resumeWhenIdle = Effect.fn("BackgroundNotify.resumeWhenIdle")(function* (
  deps: Deps,
  input: { ops: TaskPromptOps; sessionID: SessionID; userID: MessageID; toast: Toast },
) {
  while ((yield* deps.status.get(input.sessionID)).type !== "idle") yield* Effect.sleep("300 millis")
  const messages = yield* deps.sessions.messages({ sessionID: input.sessionID, limit: 1 })
  // Anything newer than the notice means its turn already saw it: a newer user message starts its own
  // turn, and a newer reply means the busy turn picked the notice up.
  if (messages[0]?.info.id !== input.userID) return
  // A session the user stopped (e.g. interrupted while subagents kept running) would not resume, so it is not
  // announced; the notice waits for the next turn.
  if (input.ops.stopped && (yield* input.ops.stopped(input.sessionID))) return
  yield* deps.bus.publish(TuiEvent.ToastShow, { ...input.toast, duration: 5000 })
  yield* input.ops
    .loop({ sessionID: input.sessionID })
    .pipe(Effect.ignore, Effect.forkIn(deps.scope, { startImmediately: true }), detach)
})

// Forked work outlives the caller. Drop its lazy stack frames, which retain the caller's arguments (for
// tools, the whole conversation).
function detach<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.provideService(References.CurrentStackFrame, undefined))
}

export * as BackgroundNotify from "./notify"
