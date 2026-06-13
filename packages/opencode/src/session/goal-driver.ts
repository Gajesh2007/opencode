import { Effect, Layer, Context, Stream } from "effect"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { Goal } from "./goal"
import { Steering } from "./steering"
import * as Session from "./session"
import { SessionPrompt } from "./prompt"
import { SessionStatus } from "./status"
import { MessageV2 } from "./message-v2"
import { MessageID, PartID, type SessionID } from "./schema"
import GOAL_CONTINUATION from "./prompt/goal-continuation.txt"
import GOAL_BUDGET_LIMIT from "./prompt/goal-budget-limit.txt"
import * as Log from "@opencode-ai/core/util/log"

// Event-driven goal harness. Goal auto-continuation used to live inline in the
// session turn loop (session/prompt.ts); it now lives here, decoupled. When a
// session goes idle (SessionStatus.Event.Idle) and a goal is still active, the
// driver accounts the finished turn's usage, enforces the budget, asks the
// steering agent whether to stop or continue, and — on continue — injects a
// synthetic user message and resumes the session (a fresh prompt run). The next
// turn ends in another idle and re-enters here, until the goal is completed,
// blocked, or budget-limited. This is opencode's own equivalent of an on-stop
// hook, riding the existing event bus.

const log = Log.create({ service: "session.goal-driver" })

// Consecutive "blocked" steering verdicts before the goal is marked blocked.
const MAX_BLOCKED_TURNS = 3

export interface Interface {
  // Per-instance setup: subscribe to session.idle for the current instance. Lazy
  // and idempotent (cached per instance); invoked by InstanceBootstrap.
  readonly init: () => Effect.Effect<void>
  // Evaluate one idle transition for a session: account usage, gate on budget,
  // steer, and resume if the goal is still active. A no-op when the session has
  // no active goal. Exposed for testing; the subscription wires it to session.idle.
  readonly onIdle: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GoalDriver") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const goals = yield* Goal.Service
    const steering = yield* Steering.Service
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service

    // Append a synthetic user message carrying the continuation/budget prompt,
    // reusing the session's last-user agent/model so the next turn runs identically.
    const inject = Effect.fn("GoalDriver.inject")(function* (
      sessionID: SessionID,
      lastUser: MessageV2.User,
      text: string,
    ) {
      const msg = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        agent: lastUser.agent,
        model: lastUser.model,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID,
        type: "text",
        text,
        synthetic: true,
      })
    })

    const onIdle = Effect.fn("GoalDriver.onIdle")(function* (sessionID: SessionID) {
      const goal = yield* goals.get(sessionID)
      if (!goal || goal.status !== "active") return

      // Only drive top-level sessions; a subagent/child session self-stops.
      const session = yield* sessions.get(sessionID).pipe(Effect.orElseSucceed(() => undefined))
      if (!session || session.parentID) return

      const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
      const { user: lastUser, assistant: lastAssistant } = MessageV2.latest(msgs)
      if (!lastUser) return
      // Only continue after a clean assistant turn responded to the latest user
      // message. Skips aborts/errors and idle transitions with no fresh turn
      // (e.g. a manual cancel), mirroring the old inline `!error` guard.
      if (!lastAssistant || lastAssistant.error || lastAssistant.id < lastUser.id) return

      // Account the finished turn's tokens and cost.
      yield* goals.addUsage({
        sessionID,
        tokens: lastAssistant.tokens.input + lastAssistant.tokens.output,
        cost: lastAssistant.cost,
      })
      const updated = yield* goals.get(sessionID)
      if (!updated || updated.status !== "active") return

      // Budget gate: inject the budget-limit prompt and stop (no resume).
      const overTokenBudget = updated.tokenBudget !== undefined && updated.tokensUsed >= updated.tokenBudget
      const overCostBudget = updated.costBudget !== undefined && updated.costUsed >= updated.costBudget
      if (overTokenBudget || overCostBudget) {
        yield* goals.setBudgetLimited(sessionID)
        yield* inject(sessionID, lastUser, renderGoalPrompt(GOAL_BUDGET_LIMIT, updated))
        return
      }

      // Ask the steering agent whether the objective is met, blocked, or should
      // continue. Falls back to a template continuation if steering errors.
      const steer = yield* steering
        .steer({
          sessionID,
          goal: updated,
          providerID: lastUser.model.providerID,
          modelID: lastUser.model.modelID,
        })
        .pipe(Effect.catch(() => Effect.succeed(undefined)))

      if (steer?.type === "complete") {
        yield* goals.update({ sessionID, status: "completed" })
        return
      }
      if (steer?.type === "blocked") {
        // Give up after MAX_BLOCKED_TURNS consecutive blocked verdicts. The counter
        // is only reset on a non-blocked turn (below), so it accumulates correctly.
        const turns = yield* goals.incrementBlockedTurns(sessionID)
        if (turns >= MAX_BLOCKED_TURNS) {
          yield* goals.update({ sessionID, status: "blocked" })
          return
        }
      } else {
        yield* goals.resetBlockedTurns(sessionID)
      }

      const continuationText =
        steer?.message && steer.message.length > 0
          ? [
              "<goal_context>",
              `<steering_direction>${steer.message}</steering_direction>`,
              "",
              renderGoalPrompt(GOAL_CONTINUATION, updated),
              "</goal_context>",
            ].join("\n")
          : renderGoalPrompt(GOAL_CONTINUATION, updated)
      yield* inject(sessionID, lastUser, continuationText)

      // Resume the session. The turn ends in another idle, re-entering this
      // driver. SessionRunState dedupes if a run is already in progress.
      yield* prompt.loop(new SessionPrompt.LoopInput({ sessionID }))
    })

    // The bus is per-instance, so the subscription must be created inside an
    // instance context (lazily, cached per instance) rather than at layer build.
    // InstanceBootstrap calls init() once per instance. Each onIdle is forked so
    // one session's continuation never blocks another, and per-event failures are
    // swallowed so a single bad turn can't tear down the subscription.
    const initState = yield* InstanceState.make(
      Effect.fn("GoalDriver.initState")(function* () {
        yield* (yield* bus.subscribe(SessionStatus.Event.Idle)).pipe(
          Stream.runForEach((evt) =>
            onIdle(evt.properties.sessionID).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() =>
                  log.error("onIdle failed", { sessionID: evt.properties.sessionID, cause: String(cause) }),
                ),
              ),
              Effect.forkScoped,
            ),
          ),
          Effect.forkScoped,
        )
      }),
    )

    const init = Effect.fn("GoalDriver.init")(function* () {
      yield* InstanceState.get(initState)
    })

    return Service.of({ init, onIdle })
  }),
)

// Render a goal prompt template with the goal's objective and budget usage.
// (Moved from session/prompt.ts when goal mode became event-driven.)
function renderGoalPrompt(template: string, goal: Goal.Info): string {
  const budgetStr = goal.costBudget
    ? `$${goal.costBudget.toFixed(2)}`
    : goal.tokenBudget
      ? `${goal.tokenBudget} tokens`
      : "unlimited"
  const usedStr = goal.costBudget ? `$${goal.costUsed.toFixed(4)}` : `${goal.tokensUsed} tokens`
  return [
    "<goal_context>",
    template
      .replace("${objective}", goal.objective)
      .replace("${tokensUsed}", usedStr)
      .replace("${tokenBudget}", budgetStr),
    "</goal_context>",
  ].join("\n")
}

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.defaultLayer),
  Layer.provide(Goal.defaultLayer),
  Layer.provide(Steering.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
)

export * as GoalDriver from "./goal-driver"
