import { SubagentRun } from "@/agent/subagent-run"
import { MAX_MAILBOX_PAYLOAD_CHARS } from "@/agent/collaboration"
import { PositiveInt } from "@opencode-ai/core/schema"
import * as Tool from "@/tool/tool"
import { Effect, Schema } from "effect"
import DESCRIPTION from "./spawn_agent.txt"

export const Parameters = Schema.Struct({
  task_name: Schema.String.check(Schema.isPattern(/^[a-z0-9_]+$/)).annotate({
    description: "A unique lowercase task name using only letters, digits, and underscores.",
  }),
  message: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_MAILBOX_PAYLOAD_CHARS)).annotate({
    description: `A complete, concrete task for an independent child agent (maximum ${MAX_MAILBOX_PAYLOAD_CHARS.toLocaleString()} characters).`,
  }),
  fork_turns: Schema.optional(Schema.Union([Schema.Literals(["none", "all"]), PositiveInt])).annotate({
    description:
      "Context to give the child: 'none' (default) for a fresh session, 'all' for the complete conversation, or a positive integer for the latest user turns. Prefer a complete message over 'all', which copies all chat history and can encourage recursive subchat loops.",
    default: "none",
  }),
  agent_type: Schema.optional(Schema.String).annotate({
    description: "Optional agent type. By default the child uses the current agent identity.",
  }),
})

type Metadata = {
  task_path: string
  session_id: string
  taskPath: string
  sessionId: string
  parentSessionId: string
  background: true
}

export const SpawnAgentTool = Tool.define(
  "spawn_agent",
  Effect.gen(function* () {
    const run = yield* SubagentRun.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        run
          .run({
            context: ctx,
            taskName: params.task_name,
            message: params.message,
            forkTurns: params.fork_turns,
            agentType: params.agent_type,
          })
          .pipe(
            Effect.map((result) => ({
              title: params.task_name,
              metadata: {
                task_path: result.path,
                session_id: result.sessionID,
                taskPath: result.path,
                sessionId: result.sessionID,
                parentSessionId: ctx.sessionID,
                background: true as const,
              },
              output: `task_path: ${result.path}\nsession_id: ${result.sessionID}\nstatus: pending\n\nUse task_status with task_id=${result.sessionID} to read this agent's output at any time.`,
            })),
            Effect.orDie,
          ),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

export * as SpawnAgent from "./spawn_agent"
