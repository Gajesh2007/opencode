export * as CollaborationPlugin from "./collaboration.js"

import { ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Option, Schema } from "effect"
import { Collaboration } from "../collaboration.js"
import { Session } from "../session.js"
import { Job } from "../job.js"
import { Permission } from "../permission.js"
import { SubagentTool } from "../tool/plugin/subagent.js"
import { Team } from "../team.js"

const Target = Schema.Struct({ target: Schema.String })
const Message = Schema.Struct({ target: Schema.String, message: Schema.String })
const Send = Schema.Struct({
  target: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(Schema.String),
  recipients: Schema.optionalKey(Schema.Array(Schema.String)),
  message: Schema.String,
})
const Followup = Schema.Struct({
  ...Message.fields,
  model: Schema.optionalKey(Schema.String),
  variant: Schema.optionalKey(Schema.String),
  reset_model: Schema.optionalKey(Schema.Boolean),
})
const Wait = Schema.Struct({ timeout: Schema.optionalKey(Schema.Finite) })
const List = Schema.Struct({ path_prefix: Schema.optionalKey(Schema.String) })
const Member = Schema.Struct({ path: Schema.String, sessionID: Session.ID, status: Schema.String })
const view = (member: Collaboration.Member) => ({
  path: member.path,
  sessionID: member.session.id,
  status: member.status,
})

export const Plugin = define({
  id: "opencode.collaboration",
  effect: Effect.fn("CollaborationPlugin")(function* (ctx) {
    const collaboration = yield* Collaboration.Service
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const permission = yield* Permission.Service
    const teams = yield* Team.Service
    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: "send_message",
          options: { codemode: false },
          input: Send,
          output: Schema.Struct({ recipients: Schema.Array(Schema.String) }),
          description:
            "Send a message to an agent in this session's family by canonical task path or session ID. An idle agent is not started; use followup_task to assign another turn.",
          execute: (input, context) =>
            Effect.gen(function* () {
              const targets = [
                ...new Set(input.recipients ?? (input.target ? [input.target] : input.to ? [input.to] : [])),
              ]
              if (!targets.length) return yield* new ToolFailure({ message: "Specify target, to or recipients." })
              if (!input.message.trim() || input.message.length > 64000)
                return yield* new ToolFailure({ message: "Messages must contain 1–64000 characters." })
              const delivered: string[] = []
              for (const target of targets) {
                const resolved = yield* collaboration.resolve(context.sessionID, target).pipe(Effect.option)
                yield* permission.assert({
                  action: "send_message",
                  resources: [Option.isSome(resolved) ? resolved.value.path : target],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
                if (Option.isSome(resolved)) {
                  yield* collaboration.send(context.sessionID, resolved.value.path, input.message)
                  delivered.push(resolved.value.path)
                  continue
                }
                const member = yield* teams.whoami(context.sessionID)
                if (!member || !(yield* teams.roster(member.team)).some((item) => item.name === target))
                  return yield* new ToolFailure({
                    message: "Unknown agent or teammate: " + target + ". Already delivered: " + delivered.join(", "),
                  })
                yield* teams.send({ team: member.team, from: member.name, to: target, message: input.message })
                delivered.push(target)
              }
              return { output: { recipients: delivered } }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Message delivery failed", error }),
              ),
            ),
        })
        editor.add({
          name: "list_agents",
          options: { codemode: false },
          input: List,
          output: Schema.Struct({ agents: Schema.Array(Member) }),
          description:
            "List the root and child agents in the current family with their canonical task paths, session IDs and execution states.",
          execute: (input, context) =>
            collaboration.list(context.sessionID).pipe(
              Effect.map((all) => ({
                output: {
                  agents: all
                    .filter(
                      (member) =>
                        !input.path_prefix ||
                        member.path === input.path_prefix ||
                        member.path.startsWith(input.path_prefix + "/"),
                    )
                    .map(view),
                },
              })),
            ),
        })
        editor.add({
          name: "wait_agent",
          options: { codemode: false },
          input: Wait,
          output: Schema.Struct({
            messages: Schema.Array(Schema.Struct({ from: Schema.String, text: Schema.String })),
          }),
          description:
            "Wait for a message or child completion notification, up to timeout seconds (default 30, maximum 600). Received notices are returned once.",
          execute: (input, context) =>
            collaboration.wait(context.sessionID, input.timeout ?? 30).pipe(
              Effect.map((messages) => ({ output: { messages } })),
              Effect.mapError((error) => new ToolFailure({ message: error.message })),
            ),
        })
        editor.add({
          name: "interrupt_agent",
          options: { codemode: false },
          input: Target,
          output: Member,
          description:
            "Interrupt a child agent in the current family. The root session and the calling agent cannot be interrupted with this tool.",
          execute: (input, context) =>
            Effect.gen(function* () {
              const target = yield* collaboration.resolve(context.sessionID, input.target)
              if (target.session.id === target.root || target.session.id === context.sessionID)
                return yield* new ToolFailure({ message: "Cannot interrupt the root or the calling agent." })
              yield* permission.assert({
                action: "interrupt_agent",
                resources: [target.path],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              yield* Effect.all([sessions.interrupt(target.session.id), jobs.cancel(target.session.id)])
              return { output: { ...view(target), status: "interrupted" } }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to interrupt agent", error }),
              ),
            ),
        })
        editor.add({
          name: "followup_task",
          options: { codemode: false },
          input: Followup,
          output: SubagentTool.Output,
          description:
            "Assign a new turn to an idle direct child. Omit model to preserve its latest selection; set model only at the user's explicit request.",
          execute: (input, context) =>
            Effect.gen(function* () {
              const target = yield* collaboration.resolve(context.sessionID, input.target)
              if (target.session.parentID !== context.sessionID)
                return yield* new ToolFailure({ message: "Only the direct parent may assign a follow-up task." })
              yield* permission.assert({
                action: "followup_task",
                resources: [target.path],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              if ((yield* sessions.active).has(target.session.id)) {
                if (input.model || input.variant !== undefined || input.reset_model)
                  return yield* new ToolFailure({ message: "Wait until the child is idle before changing its model." })
                yield* collaboration.send(context.sessionID, input.target, input.message)
                return {
                  output: {
                    sessionID: target.session.id,
                    status: "running" as const,
                    output: "Follow-up queued for the running agent.",
                  },
                }
              }
              const subagent = (yield* ctx.tool.list()).find((tool) => tool.id === SubagentTool.name)
              if (!subagent) return yield* new ToolFailure({ message: "The subagent tool is unavailable." })
              return yield* subagent.execute(
                {
                  agent: target.session.agent ?? "general",
                  description: target.session.title ?? input.target,
                  prompt: input.message,
                  sessionID: target.session.id,
                  background: true,
                  ...(input.model ? { model: input.model } : {}),
                  ...(input.variant !== undefined ? { variant: input.variant } : {}),
                  ...(input.reset_model ? { reset_model: true } : {}),
                },
                context,
              )
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to start follow-up", error }),
              ),
            ),
        })
      })
      .pipe(Effect.orDie)
  }),
})
