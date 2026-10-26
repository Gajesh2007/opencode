export * as GoalPlugin from "./goal.js"

import { SystemPart, ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Schema, Stream } from "effect"
import { Goal } from "../goal.js"
import { Session } from "../session.js"
import { Permission } from "../permission.js"
import { AuxiliaryReview } from "../session/auxiliary-review.js"
import { Location } from "../location.js"

const Input = Schema.Struct({
  action: Schema.Literals(["create", "get", "update"]),
  objective: Schema.optionalKey(Schema.String),
  token_budget: Schema.optionalKey(Schema.Finite),
  cost_budget: Schema.optionalKey(Schema.Finite),
  status: Schema.optionalKey(Schema.Literals(["completed", "blocked", "abandoned"])),
})

export const Plugin = define({
  id: "opencode.goal",
  effect: Effect.fn("GoalPlugin")(function* (ctx) {
    const goals = yield* Goal.Service
    const permissions = yield* Permission.Service
    const reviewer = yield* AuxiliaryReview.Service
    const location = yield* Location.Service
    const sessions = yield* Session.Service
    const continueGoal = Effect.fn("GoalPlugin.continue")(function* (sessionID: Session.ID) {
      const session = yield* sessions.get(sessionID).pipe(Effect.orElseSucceed(() => undefined))
      if (
        !session ||
        session.location.directory !== location.directory ||
        session.location.workspaceID !== location.workspaceID
      )
        return
      const before = yield* goals.get(sessionID)
      const continuation = yield* goals.continuation(sessionID)
      if (continuation) {
        const reply =
          before &&
          (yield* reviewer.run({
            sessionID,
            agent: "steer",
            prompt:
              "Review progress against this objective. Return exactly GOAL_COMPLETE only when every requirement is verified. Return GOAL_BLOCKED only if no useful progress is possible without external input. Otherwise give the next concrete direction. Objective:\n" +
              before.objective,
          }))
        const next = yield* goals.steer(
          sessionID,
          continuation.id,
          reply === "GOAL_COMPLETE" ? "complete" : reply === "GOAL_BLOCKED" ? "blocked" : "continue",
          reply ?? continuation.text,
        )
        if (next) {
          yield* ctx.session.synthetic({ sessionID, ...next, metadata: { source: "goal" } }).pipe(Effect.orDie)
          yield* goals.delivered(sessionID, continuation.id)
          return
        }
      }
      if (before?.status === "active" && (yield* goals.get(sessionID))?.status === "budget_limited") {
        yield* ctx.session
          .synthetic({
            sessionID,
            resume: false,
            text: "The active goal reached its recorded usage budget. Stop substantive goal work and report progress and remaining requirements.",
            metadata: { source: "goal" },
          })
          .pipe(Effect.orDie)
      }
    })
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "session.execution.succeeded"),
      Stream.runForEach((event) =>
        continueGoal(event.data.sessionID).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Goal continuation failed", { cause })),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* goals.pending.pipe(
      Effect.flatMap((ids) =>
        Effect.forEach(ids, (id) =>
          continueGoal(id).pipe(Effect.catchCause((cause) => Effect.logWarning("Goal recovery failed", { cause }))),
        ),
      ),
      Effect.forkScoped(),
    )
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const goal = yield* goals.get(event.sessionID)
        if (goal?.status === "active") event.system.push(SystemPart.make(Goal.continuationPrompt(goal)))
      }),
    )
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name: "goal",
          options: { codemode: false },
          description:
            "Manage an explicitly requested persistent goal. Never create one unless the user asks for goal mode. Set a token or cost budget only when explicitly requested. Complete it only after verifying every requirement; mark blocked only after the same blocker persists for three continuation turns.",
          input: Input,
          output: Schema.Struct({ goal: Schema.optionalKey(Goal.Info) }),
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permissions.assert({
                action: "goal",
                resources: [input.action],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              if (input.action === "create" && !input.objective)
                return yield* new ToolFailure({ message: "An objective is required." })
              if (input.action === "update" && !input.status)
                return yield* new ToolFailure({ message: "A completed, blocked or abandoned status is required." })
              const goal =
                input.action === "create"
                  ? yield* goals.create({
                      sessionID: context.sessionID,
                      objective: input.objective!,
                      tokenBudget: input.token_budget,
                      costBudget: input.cost_budget,
                    })
                  : input.action === "update"
                    ? yield* goals.update(context.sessionID, input.status!)
                    : yield* goals.get(context.sessionID)
              return {
                output: goal ? { goal } : {},
                content: goal
                  ? `${goal.objective}\nStatus: ${goal.status}\nRecorded tokens: ${goal.tokensUsed}\nRecorded cost: $${goal.costUsed}\nUsage covers recorded root and descendant steps. Unreported retries and external-tool spend are not a guaranteed billing cap.`
                  : "No goal is set for this session.",
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to update the goal", error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
})
