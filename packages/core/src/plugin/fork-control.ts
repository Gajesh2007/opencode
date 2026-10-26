export * as ForkControlPlugin from "./fork-control.js"

import { define } from "@opencode/plugin/effect/plugin"
import { ForkControl } from "@opencode/schema/fork-control"
import { Effect, Option, Schema } from "effect"
import { Workflow } from "@opencode/schema/workflow"
import { Goal } from "../goal.js"
import { MetaAgent } from "../meta-agent.js"
import { Collaboration } from "../collaboration.js"
import { Session } from "../session.js"
import { Job } from "../job.js"
import { SubagentModel } from "../subagent-model.js"
import { Agent } from "../agent.js"
import { Team } from "../team.js"

export const Plugin = define({
  id: "opencode.fork-control",
  effect: Effect.fn("ForkControlPlugin")(function* (ctx) {
    const goals = yield* Goal.Service
    const reviewer = yield* MetaAgent.Service
    const collaboration = yield* Collaboration.Service
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const teams = yield* Team.Service
    const defaults = yield* SubagentModel.Service
    const agents = yield* Agent.Service
    yield* ctx.rpc
      .register(ForkControl.Definition, {
        subagentModels: () => defaults.list,
        setSubagentModel: (input) =>
          Effect.gen(function* () {
            const agent = yield* agents.resolve(input.agent)
            if (!agent || agent.mode === "primary")
              return yield* Effect.die("Select a subagent to configure its default model.")
            yield* defaults.set(input.agent, input.model)
          }),
        state: (input) =>
          Effect.gen(function* () {
            yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            const goal = yield* goals.get(input.sessionID)
            const review = yield* reviewer.get(input.sessionID)
            const member = yield* teams.whoami(input.sessionID)
            const roster = member ? yield* teams.roster(member.team) : []
            const tasks = member ? yield* teams.taskList(member.team) : []
            const history = yield* sessions
              .messages({ sessionID: input.sessionID, order: "desc", limit: 100 })
              .pipe(Effect.orDie)
            const workflows = history.flatMap((message) =>
              message.type === "assistant"
                ? message.content.flatMap((part) => {
                    if (part.type !== "tool" || part.name !== "workflow" || part.state.status === "streaming") return []
                    const definition = Option.getOrUndefined(
                      Schema.decodeUnknownOption(Workflow.Input)(part.state.input),
                    )
                    if (!definition) return []
                    const metadata = part.state.metadata
                    return [
                      {
                        id: part.id,
                        title: definition.description,
                        status: part.state.status,
                        cells: definition.units.length * definition.passes.length,
                        completed: typeof metadata?.completed === "number" ? metadata.completed : 0,
                      },
                    ]
                  })
                : [],
            )
            return {
              ...(goal ? { goal } : {}),
              ...(review ? { reviewer: review } : {}),
              teams: member
                ? [
                    {
                      name: member.team,
                      members: roster.map((item) => ({ name: item.name, sessionID: item.sessionID })),
                      tasks: tasks.map((task) => ({
                        id: task.id,
                        title: task.title,
                        status: task.status,
                        ...(task.assignee ? { assignee: task.assignee } : {}),
                        ...(task.notes ? { notes: task.notes } : {}),
                      })),
                    },
                  ]
                : [],
              workflows,
              agents: (yield* collaboration.list(input.sessionID)).map((member) => ({
                sessionID: member.session.id,
                path: member.path,
                status: member.status,
              })),
            }
          }),
        createGoal: (input) =>
          sessions.get(input.sessionID).pipe(Effect.orDie, Effect.andThen(goals.create(input)), Effect.orDie),
        updateGoal: (input) =>
          goals.update(input.sessionID, input.status).pipe(Effect.map((goal) => (goal ? { goal } : {}))),
        setReviewer: (input) => sessions.get(input.sessionID).pipe(Effect.orDie, Effect.andThen(reviewer.set(input))),
        clearReviewer: (input) => reviewer.clear(input.sessionID),
        stopAgents: (input) =>
          Effect.gen(function* () {
            const agents = (yield* collaboration.list(input.sessionID)).filter(
              (member) => member.session.id !== member.root,
            )
            yield* Effect.forEach(
              agents,
              (member) => Effect.all([sessions.interrupt(member.session.id), jobs.cancel(member.session.id)]),
              { concurrency: "unbounded" },
            )
            return agents.length
          }),
      })
      .pipe(Effect.orDie)
  }),
})
