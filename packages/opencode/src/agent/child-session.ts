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

export function childToolOverrides(input: {
  agent: Agent.Info
  primaryTools?: string[]
  disableTaskTools?: boolean
}) {
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

    const text = (message: typeof result) => message.parts.findLast((item) => item.type === "text")?.text ?? ""
    for (
      let attempt = 0;
      attempt < CONTINUE_REPLY_ATTEMPTS &&
      (result.info.role !== "assistant" || result.info.error === undefined) &&
      text(result).trim() === "";
      attempt++
    ) {
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

    const output = text(result)
    const failure = result.info.role === "assistant" ? result.info.error : undefined
    if (failure?.name === "MessageAbortedError") return yield* Effect.interrupt
    if (failure) {
      const reason = (failure.data as { message?: string } | undefined)?.message ?? failure.name
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
      return yield* Effect.fail(new Error(reason || "Subagent stopped due to an error"))
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
