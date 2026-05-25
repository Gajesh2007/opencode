import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./goal.txt"
import { Goal } from "../session/goal"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["create", "update", "get"]).annotate({
    description: '"create" to set a new goal, "update" to change status, "get" to retrieve current goal',
  }),
  objective: Schema.optional(Schema.String).annotate({
    description: "The task objective (required for create)",
  }),
  token_budget: Schema.optional(Schema.Number).annotate({
    description: "Optional max token budget for the goal (create only)",
  }),
  cost_budget: Schema.optional(Schema.Number).annotate({
    description: "Optional max cost budget in dollars for the goal (create only, e.g. 5.00 for $5)",
  }),
  status: Schema.optional(Schema.String).annotate({
    description: 'New status: "completed" or "blocked" (update only)',
  }),
})

type GoalMetadata = {
  action: string
  goal?: Goal.Info
}

export const GoalTool = Tool.define<typeof Parameters, GoalMetadata, Goal.Service>(
  "goal",
  Effect.gen(function* () {
    const goalSvc = yield* Goal.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<GoalMetadata>) =>
        Effect.gen(function* () {
          if (params.action === "get") {
            const current = yield* goalSvc.get(ctx.sessionID)
            if (!current) {
              return {
                title: "No active goal",
                output: "No goal is currently set for this session.",
                metadata: { action: "get" },
              }
            }
            return {
              title: current.objective.slice(0, 60),
              output: formatGoal(current),
              metadata: { action: "get", goal: current },
            }
          }

          if (params.action === "create") {
            if (!params.objective) {
              return {
                title: "Error",
                output: "An objective is required when creating a goal.",
                metadata: { action: "create" },
              }
            }

            const result = yield* goalSvc.create({
              sessionID: ctx.sessionID,
              objective: params.objective,
              tokenBudget: params.token_budget,
              costBudget: params.cost_budget,
            })

            return {
              title: result.objective.slice(0, 60),
              output: formatGoal(result),
              metadata: { action: "create", goal: result },
            }
          }

          // action === "update"
          if (params.status !== "completed" && params.status !== "blocked") {
            return {
              title: "Error",
              output: 'Goal update status must be "completed" or "blocked".',
              metadata: { action: "update" },
            }
          }

          const result = yield* goalSvc.update({
            sessionID: ctx.sessionID,
            status: params.status,
          })

          if (!result) {
            return {
              title: "No goal",
              output: "No active goal to update.",
              metadata: { action: "update" },
            }
          }

          const completionReport =
            params.status === "completed" && result.tokenBudget
              ? `\nGoal achieved. Tokens used: ${result.tokensUsed} / ${result.tokenBudget} budget.`
              : ""

          return {
            title: `Goal ${params.status}`,
            output: formatGoal(result) + completionReport,
            metadata: { action: "update", goal: result },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, GoalMetadata>
  }),
)

function formatGoal(goal: Goal.Info): string {
  const lines = [
    `Objective: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Tokens used: ${goal.tokensUsed}${goal.tokenBudget ? ` / ${goal.tokenBudget}` : ""}`,
    `Cost: $${goal.costUsed.toFixed(4)}${goal.costBudget ? ` / $${goal.costBudget.toFixed(2)} budget` : ""}`,
  ]
  return lines.join("\n")
}
