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
  fork_turns: Schema.optional(Schema.Union([Schema.Literals(["all", "none"]), PositiveInt])).annotate({
    description:
      "Context to give the child: 'all' (default), 'none' for a fresh session, or a positive integer for the latest user turns.",
  }),
  agent_type: Schema.optional(Schema.String).annotate({
    description: "Optional agent type. By default the child uses the current agent identity.",
  }),
})

type Metadata = {
  task_path: string
  session_id: string
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
              metadata: { task_path: result.path, session_id: result.sessionID },
              output: `task_path: ${result.path}\nsession_id: ${result.sessionID}\nstatus: pending`,
            })),
            Effect.orDie,
          ),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

export * as SpawnAgent from "./spawn_agent"
