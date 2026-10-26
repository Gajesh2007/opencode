export * as SubagentCompatPlugin from "./subagent-compat.js"

import { ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Session } from "../session.js"
import { Collaboration } from "../collaboration.js"
import { Permission } from "../permission.js"
import { Job } from "../job.js"
import { SubagentTool } from "../tool/plugin/subagent.js"

const Selection = {
  model: Schema.optionalKey(Schema.String),
  variant: Schema.optionalKey(Schema.String),
  reset_model: Schema.optionalKey(Schema.Boolean),
}
export const Plugin = define({
  id: "opencode.subagent-compat",
  effect: Effect.fn("SubagentCompatPlugin")(function* (ctx) {
    const sessions = yield* Session.Service
    const permission = yield* Permission.Service
    const jobs = yield* Job.Service
    const collaboration = yield* Collaboration.Service
    const tool = Effect.gen(function* () {
      const selected = (yield* ctx.tool.list()).find((item) => item.id === SubagentTool.name)
      if (!selected) return yield* new ToolFailure({ message: "The subagent tool is unavailable." })
      return selected
    })
    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: "spawn_agent",
          options: { codemode: false },
          description:
            "Spawn a named child agent in the background. Use only when delegation is authorized. Omit model and variant to inherit the current selection. fork_turns controls inherited conversation context.",
          input: Schema.Struct({
            task_name: Schema.String,
            message: Schema.String,
            fork_turns: SubagentTool.Input.fields.fork_turns,
            agent_type: Schema.optionalKey(Schema.String),
            ...Selection,
            worktree: Schema.optionalKey(Schema.Boolean),
          }),
          output: Schema.Struct({ ...SubagentTool.Output.fields, task_path: Schema.String, session_id: Session.ID }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const parent = yield* sessions.get(context.sessionID)
              yield* permission.assert({
                action: "spawn_agent",
                resources: [input.task_name],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              const subagent = yield* tool
              const result = yield* subagent.execute(
                {
                  name: input.task_name,
                  agent: input.agent_type ?? parent.agent ?? context.agent,
                  description: input.task_name,
                  prompt: input.message,
                  fork_turns: input.fork_turns,
                  model: input.model,
                  variant: input.variant,
                  reset_model: input.reset_model,
                  worktree: input.worktree,
                  background: true,
                },
                context,
              )
              const output = yield* Schema.decodeUnknownEffect(SubagentTool.Output)(result.output)
              const member = yield* collaboration.member(output.sessionID)
              return {
                ...result,
                output: { ...output, task_path: member.path, session_id: output.sessionID },
                content: output.output + "\nTask path: " + member.path,
                metadata: { ...result.metadata, task_path: member.path, session_id: output.sessionID },
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to spawn agent", error }),
              ),
            ),
        })
        editor.add({
          name: "task",
          options: { codemode: false },
          description:
            "Run a child task. Supports the fork's subagent_type, task_id, fork, background, worktree and team options.",
          input: Schema.Struct({
            description: Schema.String,
            prompt: Schema.String,
            subagent_type: Schema.optionalKey(Schema.String),
            task_id: Schema.optionalKey(Session.ID),
            fork: Schema.optionalKey(Schema.Boolean),
            background: Schema.optionalKey(Schema.Boolean),
            worktree: Schema.optionalKey(Schema.Boolean),
            team: Schema.optionalKey(Schema.String),
            name: Schema.optionalKey(Schema.String),
            ...Selection,
          }),
          output: SubagentTool.Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const parent = yield* sessions.get(context.sessionID)
              const subagent = yield* tool
              return yield* subagent.execute(
                {
                  ...input,
                  name:
                    input.name ??
                    (input.fork || input.worktree ? "task_" + context.id.replace(/[^a-zA-Z0-9_]/g, "_") : undefined),
                  agent: input.subagent_type ?? (input.fork ? (parent.agent ?? context.agent) : "general"),
                  sessionID: input.task_id,
                  fork_turns: input.fork ? "all" : "none",
                },
                context,
              )
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to run task", error }),
              ),
            ),
        })
        editor.add({
          name: "task_status",
          options: { codemode: false },
          description: "Read a child agent's current state and final output. Set wait to await completion.",
          input: Schema.Struct({ task_id: Schema.String, wait: Schema.optionalKey(Schema.Boolean) }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const member = yield* collaboration.resolve(context.sessionID, input.task_id)
              const job = input.wait
                ? (yield* jobs.wait({ id: member.session.id })).info
                : yield* jobs.get(member.session.id)
              return {
                content: job?.output ?? job?.error ?? member.status,
                metadata: { sessionID: member.session.id, status: job?.status ?? member.status },
              }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message }))),
        })
      })
      .pipe(Effect.orDie)
  }),
})
