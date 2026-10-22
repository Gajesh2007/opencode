import type { Agent } from "./agent"
import { Plugin } from "@/plugin"
import type { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import type { SessionPrompt } from "@/session/prompt"
import { Effect } from "effect"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
  loop(input: SessionPrompt.LoopInput): Effect.Effect<MessageV2.WithParts>
}

const CONTINUE_REPLY_ATTEMPTS = 2
const CONTINUE_REPLY_PROMPT =
  "You ended your turn without writing a reply. Provide your final answer for the task above now, as a concise message for the agent that delegated it - summarize what you found or did. Do not start new work unless it is required to answer."

export function childResult(message: MessageV2.WithParts) {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  const failure = message.info.role === "assistant" ? message.info.error : undefined
  if (failure) {
    return {
      text,
      status: failure.name === "MessageAbortedError" ? ("cancelled" as const) : ("error" as const),
      error: "message" in failure.data ? String(failure.data.message) : failure.name,
    }
  }
  if (message.info.role === "assistant" && message.info.finish !== undefined && message.info.finish !== "stop") {
    return {
      text,
      status: text.trim() ? ("partial" as const) : ("error" as const),
      error: `Subagent stopped with incomplete finish reason: ${message.info.finish}`,
    }
  }
  if (message.info.role !== "assistant" || !text.trim()) {
    return { text, status: "empty" as const, error: "Subagent produced no usable assistant reply" }
  }
  return { text, status: "completed" as const }
}

export function childToolOverrides(input: { agent: Agent.Info; primaryTools?: string[]; disableTaskTools?: boolean }) {
  return {
    ...(input.agent.permission.some((rule) => rule.permission === "todowrite") ? {} : { todowrite: false }),
    ...(input.disableTaskTools === false || input.agent.permission.some((rule) => rule.permission === "task")
      ? {}
      : { task: false }),
    ...(input.disableTaskTools === false || input.agent.permission.some((rule) => rule.permission === "workflow")
      ? {}
      : { workflow: false }),
    ...Object.fromEntries((input.primaryTools ?? []).map((item) => [item, false])),
  }
}

/** Runs one child turn with the same hooks and empty-reply recovery as `task`. */
export const runChildTurn = Effect.fn("ChildSession.runTurn")(function* (input: {
  ops: TaskPromptOps
  plugin: Plugin.Interface
  parentSessionID: SessionID
  childSessionID: SessionID
  agent: Agent.Info
  description: string
  prompt: string
  model: NonNullable<SessionPrompt.PromptInput["model"]>
  variant?: string
  serviceTier?: string
  upstream?: string
  tools: Record<string, boolean>
}) {
  yield* input.plugin.trigger(
    "subagent.start",
    {
      sessionID: input.parentSessionID,
      agentSessionID: input.childSessionID,
      agent: input.agent.name,
      description: input.description,
    },
    {},
  )
  return yield* Effect.gen(function* () {
    const parts = yield* input.ops.resolvePromptParts(input.prompt)
    let result = yield* input.ops.prompt({
      messageID: MessageID.ascending(),
      sessionID: input.childSessionID,
      model: input.model,
      agent: input.agent.name,
      variant: input.variant,
      serviceTier: input.serviceTier,
      upstream: input.upstream,
      tools: input.tools,
      parts,
    })

    for (let attempt = 0; attempt < CONTINUE_REPLY_ATTEMPTS && childResult(result).status === "empty"; attempt++) {
      result = yield* input.ops.prompt({
        sessionID: input.childSessionID,
        model: input.model,
        agent: input.agent.name,
        variant: input.variant,
        serviceTier: input.serviceTier,
        upstream: input.upstream,
        tools: input.tools,
        parts: [{ type: "text", synthetic: true, text: CONTINUE_REPLY_PROMPT }],
      })
    }

    const outcome = childResult(result)
    const output = outcome.text
    if (outcome.status === "cancelled") return yield* Effect.interrupt
    if (outcome.status !== "completed") {
      yield* input.plugin.trigger(
        "subagent.stop",
        {
          sessionID: input.parentSessionID,
          agentSessionID: input.childSessionID,
          agent: input.agent.name,
          status: "error",
        },
        { output },
      )
      return yield* Effect.fail(new Error(outcome.error))
    }
    yield* input.plugin.trigger(
      "subagent.stop",
      {
        sessionID: input.parentSessionID,
        agentSessionID: input.childSessionID,
        agent: input.agent.name,
        status: "completed",
      },
      { output },
    )
    return output
  }).pipe(
    Effect.onInterrupt(() =>
      input.plugin
        .trigger(
          "subagent.stop",
          {
            sessionID: input.parentSessionID,
            agentSessionID: input.childSessionID,
            agent: input.agent.name,
            status: "interrupted",
          },
          { output: "" },
        )
        .pipe(Effect.ignore),
    ),
  )
})

export * as ChildSession from "./child-session"
