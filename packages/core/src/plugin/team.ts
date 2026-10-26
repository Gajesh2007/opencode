export * as TeamPlugin from "./team.js"

import { ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Team } from "../team.js"
import { Collaboration } from "../collaboration.js"
import { Permission } from "../permission.js"

export const Plugin = define({
  id: "opencode.team",
  effect: Effect.fn("TeamPlugin")(function* (ctx) {
    const teams = yield* Team.Service
    const collaboration = yield* Collaboration.Service
    const permission = yield* Permission.Service
    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: "team_tasks",
          options: { codemode: false },
          description:
            "List, create or update the current team's shared tasks. Join a team by spawning a named subagent with team set.",
          input: Schema.Struct({
            action: Schema.Literals(["list", "create", "update"]),
            title: Schema.optionalKey(Schema.String),
            id: Schema.optionalKey(Schema.String),
            status: Schema.optionalKey(Schema.Literals(["pending", "in_progress", "done", "blocked"])),
            assignee: Schema.optionalKey(Schema.String),
            notes: Schema.optionalKey(Schema.String),
          }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const member = yield* teams.whoami(context.sessionID)
              if (!member) return yield* new ToolFailure({ message: "You are not part of a team." })
              yield* permission.assert({
                action: "team_tasks",
                resources: [member.team],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              if (input.action === "create") {
                if (!input.title?.trim()) return yield* new ToolFailure({ message: "A task title is required." })
                yield* teams.taskCreate({
                  team: member.team,
                  title: input.title,
                  assignee: input.assignee,
                  notes: input.notes,
                })
              }
              if (input.action === "update") {
                if (!input.id) return yield* new ToolFailure({ message: "A task ID is required." })
                const task = yield* teams.taskUpdate({ ...input, team: member.team, id: input.id })
                if (!task) return yield* new ToolFailure({ message: "No task with ID " + input.id })
              }
              const tasks = yield* teams.taskList(member.team)
              return {
                content: tasks.length
                  ? tasks
                      .map(
                        (task) =>
                          "- [" +
                          task.status +
                          "] " +
                          task.id +
                          " " +
                          task.title +
                          (task.assignee ? " (@" + task.assignee + ")" : "") +
                          (task.notes ? " — " + task.notes : ""),
                      )
                      .join("\n")
                  : "Shared task list is empty.",
                metadata: { team: member.team, tasks },
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Team task failed", error }),
              ),
            ),
        })
        editor.add({
          name: "inbox",
          options: { codemode: false },
          description:
            "Read messages addressed to this agent. Collaboration messages are consumed; peek leaves legacy team messages queued.",
          input: Schema.Struct({ peek: Schema.optionalKey(Schema.Boolean) }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const member = yield* teams.whoami(context.sessionID)
              const messages = yield* collaboration.wait(context.sessionID, 0)
              const legacy = member
                ? yield* teams.inbox({ team: member.team, recipient: member.name, drain: !input.peek })
                : []
              return {
                content:
                  [
                    ...messages.map((message) => message.from + ": " + message.text),
                    ...legacy.map((message) => message.from + ": " + message.message),
                  ].join("\n\n") || "No new messages.",
                metadata: { count: messages.length + legacy.length },
              }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message }))),
        })
      })
      .pipe(Effect.orDie)
  }),
})
