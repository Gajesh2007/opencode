import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./team_tasks.txt"
import { Team } from "../agent/team"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "create", "update"]).annotate({ description: "What to do with the shared task list" }),
  title: Schema.optional(Schema.String).annotate({ description: "Task title (for action=create)" }),
  id: Schema.optional(Schema.String).annotate({ description: "Task id (for action=update)" }),
  status: Schema.optional(Schema.Literals(["pending", "in_progress", "done", "blocked"])).annotate({
    description: "New status (for action=update)",
  }),
  assignee: Schema.optional(Schema.String).annotate({ description: "Teammate name to assign the task to" }),
  notes: Schema.optional(Schema.String).annotate({ description: "Free-form notes on the task" }),
})

type TeamTasksMetadata = { team?: string; id?: string }

export const TeamTasksTool = Tool.define<typeof Parameters, TeamTasksMetadata, Team.Service>(
  "team_tasks",
  Effect.gen(function* () {
    const team = yield* Team.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const me = yield* team.whoami(ctx.sessionID)
          if (!me) return { title: "team_tasks", metadata: {}, output: "You are not part of a team." }

          if (params.action === "create") {
            if (!params.title) return { title: "team_tasks", metadata: { team: me.team }, output: "create requires a title." }
            const task = yield* team.taskCreate({
              team: me.team,
              title: params.title,
              ...(params.assignee ? { assignee: params.assignee } : {}),
              ...(params.notes ? { notes: params.notes } : {}),
            })
            return { title: `created ${task.id}`, metadata: { team: me.team, id: task.id }, output: render(yield* team.taskList(me.team)) }
          }

          if (params.action === "update") {
            if (!params.id) return { title: "team_tasks", metadata: { team: me.team }, output: "update requires an id." }
            const task = yield* team.taskUpdate({
              team: me.team,
              id: params.id,
              ...(params.status ? { status: params.status } : {}),
              ...(params.assignee !== undefined ? { assignee: params.assignee } : {}),
              ...(params.notes !== undefined ? { notes: params.notes } : {}),
            })
            if (!task) return { title: "team_tasks", metadata: { team: me.team }, output: `No task with id ${params.id}.` }
            return { title: `updated ${task.id}`, metadata: { team: me.team, id: task.id }, output: render(yield* team.taskList(me.team)) }
          }

          return { title: "tasks", metadata: { team: me.team }, output: render(yield* team.taskList(me.team)) }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, TeamTasksMetadata>
  }),
)

function render(tasks: { id: string; title: string; status: string; assignee?: string; notes?: string }[]) {
  if (tasks.length === 0) return "Shared task list is empty."
  return tasks
    .map((t) => `- [${t.status}] ${t.id} ${t.title}${t.assignee ? ` (@${t.assignee})` : ""}${t.notes ? ` — ${t.notes}` : ""}`)
    .join("\n")
}
