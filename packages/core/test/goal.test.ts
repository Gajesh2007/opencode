import { expect } from "bun:test"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { Agent } from "@opencode/core/agent"
import { Goal } from "@opencode/core/goal"
import { Bus } from "@opencode/core/bus"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionExecution } from "@opencode/core/session/execution"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Money } from "@opencode/schema/money"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { promptLocationNode } from "./fixture/prompt-location"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Goal.node, Session.node, Bus.node]), [
    Bus.node.replace(Bus.configured({ persist: true })),
    Project.node.replace(globalProjectNode),
    LocationServiceMap.node.replace(promptLocationNode),
    SessionExecution.node.replace(SessionExecution.noopLayer),
  ]),
)
const model = { providerID: Provider.ID.make("test"), id: Model.ID.make("test") }

it.effect("counts auxiliary review usage and stops at its budget", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const goals = yield* Goal.Service
    const bus = yield* Bus.Service
    const root = yield* sessions.create({ location: { directory: AbsolutePath.make("/goal") } })
    const goal = yield* goals.create({ sessionID: root.id, objective: "Complete the migration", tokenBudget: 10 })
    yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID: root.id })
    const pending = yield* goals.continuation(root.id)
    if (!pending) return yield* Effect.die("Expected a continuation")
    yield* goals.recordAuxiliary({ sessionID: root.id, createdAt: goal.createdAt, tokens: 11, cost: 0.1 })
    expect(yield* goals.steer(root.id, pending.id, "continue", "Keep going")).toBeUndefined()
    expect(yield* goals.get(root.id)).toMatchObject({ status: "budget_limited", tokensUsed: 11, costUsed: 0.1 })
  }),
)

it.effect("requires three consecutive blocked verdicts and resets after progress", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const goals = yield* Goal.Service
    const bus = yield* Bus.Service
    const root = yield* sessions.create({ location: { directory: AbsolutePath.make("/goal") } })
    yield* goals.create({ sessionID: root.id, objective: "Complete the migration" })
    for (const verdict of ["blocked", "blocked", "continue", "blocked", "blocked", "blocked"] as const) {
      yield* TestClock.adjust("1 millis")
      yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID: root.id })
      const pending = yield* goals.continuation(root.id)
      if (!pending) return yield* Effect.die("Expected a continuation before the third blocked verdict")
      const next = yield* goals.steer(root.id, pending.id, verdict, "Continue")
      if (next) yield* goals.delivered(root.id, next.id)
    }
    expect((yield* goals.get(root.id))?.status).toBe("blocked")
  }),
)

const step = Effect.fn(function* (sessionID: Session.ID, output: number) {
  const bus = yield* Bus.Service
  const assistantMessageID = SessionMessage.ID.create()
  yield* bus.publish(SessionEvent.Step.Started, {
    sessionID,
    assistantMessageID,
    agent: Agent.ID.make("build"),
    model,
    started: 1,
  })
  yield* bus.publish(SessionEvent.Step.Ended, {
    sessionID,
    assistantMessageID,
    finish: "stop",
    cost: Money.USD.make(0.1),
    tokens: { input: 2, output, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  return assistantMessageID
})

it.effect("tracks only new goal attempts across the root and descendants", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const goals = yield* Goal.Service
    const root = yield* sessions.create({ location: { directory: AbsolutePath.make("/goal") } })
    yield* step(root.id, 100)
    yield* goals.create({ sessionID: root.id, objective: "Finish the full migration.", tokenBudget: 1000 })
    yield* TestClock.adjust("1 millis")
    yield* step(root.id, 10)
    const child = yield* sessions.create({ parentID: root.id })
    yield* step(child.id, 20)
    expect(yield* goals.get(root.id)).toMatchObject({ status: "active", tokensUsed: 34, costUsed: 0.2 })
    expect(yield* goals.create({ sessionID: root.id, objective: "replacement" }).pipe(Effect.flip)).toBeInstanceOf(
      Goal.Invalid,
    )
    const completed = yield* goals.update(root.id, "completed")
    yield* step(root.id, 100)
    expect((yield* goals.get(root.id))?.tokensUsed).toBe(completed?.tokensUsed)
  }),
)

it.effect("persists one continuation per clean idle transition and skips interrupted work", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const goals = yield* Goal.Service
    const bus = yield* Bus.Service
    const root = yield* sessions.create({ location: { directory: AbsolutePath.make("/goal") } })
    yield* goals.create({ sessionID: root.id, objective: "Complete the requested work." })
    yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID: root.id, reason: "user" })
    expect(yield* goals.continuation(root.id)).toBeUndefined()
    yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID: root.id })
    const first = yield* goals.continuation(root.id)
    expect(first?.text).toContain("Complete the requested work.")
    expect(yield* goals.continuation(root.id)).toEqual(first)
    if (!first) throw new Error("expected continuation")
    yield* goals.delivered(root.id, first.id)
    expect(yield* goals.continuation(root.id)).toBeUndefined()
  }),
)

it.effect("stops continuation at the recorded budget and validates explicit budgets", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const goals = yield* Goal.Service
    const bus = yield* Bus.Service
    const root = yield* sessions.create({ location: { directory: AbsolutePath.make("/goal") } })
    expect(
      yield* goals.create({ sessionID: root.id, objective: "work", tokenBudget: -1 }).pipe(Effect.flip),
    ).toBeInstanceOf(Goal.Invalid)
    yield* goals.create({ sessionID: root.id, objective: "work", tokenBudget: 10 })
    yield* TestClock.adjust("1 millis")
    yield* step(root.id, 10)
    yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID: root.id })
    expect(yield* goals.continuation(root.id)).toBeUndefined()
    expect((yield* goals.get(root.id))?.status).toBe("budget_limited")
  }),
)
