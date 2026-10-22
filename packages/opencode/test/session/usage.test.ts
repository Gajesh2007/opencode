import { expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { Usage, type LLMEvent } from "@opencode-ai/llm"
import { Session } from "@/session/session"
import { SessionUsage } from "@/session/usage"
import { Goal } from "@/session/goal"
import { MessageID, PartID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import type { Provider } from "@/provider/provider"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Goal.defaultLayer))
const tokens = { input: 10, output: 3, reasoning: 2, cache: { read: 4, write: 1 } }
const model: Provider.Model = {
  id: ModelID.make("test"),
  providerID: ProviderID.openai,
  name: "test",
  api: { id: "test", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: false,
    toolcall: true,
    interleaved: false,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
  },
  cost: { input: 1, output: 2, cache: { read: 0.1, write: 1 } },
  limit: { context: 10000, output: 1000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}
const finish: LLMEvent = {
  type: "step-finish",
  index: 0,
  reason: "stop",
  usage: new Usage({
    inputTokens: 15,
    outputTokens: 5,
    reasoningTokens: 2,
    cacheReadInputTokens: 4,
    cacheWriteInputTokens: 1,
    totalTokens: 20,
  }),
}

it.instance(
  "live goal totals include all steps, descendants and known failed/cancelled usage, not copied history",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const goals = yield* Goal.Service
      const root = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: root.id })
      const old = {
        id: "old",
        sessionID: root.id,
        startedAt: Date.now(),
        data: { kind: "assistant" as const, tokens, cost: 1, pricing: "catalog_estimate" as const },
      }
      yield* SessionUsage.record(old)
      yield* goals.create({ sessionID: root.id, objective: "new work" })
      const before = yield* goals.get(root.id)
      expect(before?.tokensUsed).toBe(0)
      for (const sessionID of [root.id, root.id, child.id]) {
        yield* SessionUsage.record({
          id: crypto.randomUUID(),
          sessionID,
          startedAt: Date.now(),
          data: {
            kind: "assistant",
            tokens,
            cost: 1,
            pricing: "catalog_estimate",
          },
        })
      }
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: root.id,
        role: "user",
        agent: "build",
        model: { providerID: model.providerID, modelID: model.id },
        time: { created: Date.now() },
      })
      const message = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: root.id,
        role: "assistant",
        parentID: user.id,
        agent: "build",
        mode: "build",
        modelID: model.id,
        providerID: model.providerID,
        path: { cwd: (yield* TestInstance).directory, root: (yield* TestInstance).directory },
        time: { created: Date.now() },
        tokens,
        cost: 50,
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: message.id,
        sessionID: root.id,
        type: "step-finish",
        reason: "stop",
        tokens,
        cost: 50,
      })
      const fork = yield* sessions.fork({ sessionID: root.id, parentID: root.id })
      expect(SessionUsage.summarize(fork.id).tokens).toBe(0)
      expect((yield* goals.get(root.id))?.tokensUsed).toBe(60)
      expect((yield* goals.get(root.id))?.costUsed).toBe(3)
      expect(SessionUsage.summarize(root.id).tokens).toBe(80)
      expect(SessionUsage.summarize(child.id).tokens).toBe(20)
      expect(SessionUsage.summarize(child.id, undefined, true).tokens).toBe(80)
      yield* sessions.remove(child.id)
      expect((yield* goals.get(root.id))?.tokensUsed).toBe(60)
      expect(SessionUsage.summarize(root.id).tokens).toBe(80)
    }),
)

it.instance(
  "attempt upserts and fresh goal service reads are durable and replacement excludes old/in-flight work",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const goals = yield* Goal.Service
      const root = yield* sessions.create({})
      const attempt = { id: crypto.randomUUID(), sessionID: root.id, startedAt: Date.now() }
      yield* SessionUsage.record({ ...attempt, data: { kind: "assistant", pricing: "unknown" } })
      yield* goals.create({ sessionID: root.id, objective: "first" })
      yield* SessionUsage.record({
        ...attempt,
        data: { kind: "assistant", tokens, cost: 1, pricing: "catalog_estimate" },
      })
      expect((yield* goals.get(root.id))?.tokensUsed).toBe(0)
      const current = { ...attempt, id: crypto.randomUUID(), startedAt: Date.now() }
      yield* SessionUsage.record({ ...current, data: { kind: "assistant", pricing: "unknown" } })
      expect((yield* goals.get(root.id))?.usage?.unknownAttempts).toBe(1)
      yield* goals.update({ sessionID: root.id, status: "completed" })
      for (let i = 0; i < 3; i++)
        yield* SessionUsage.record({
          ...current,
          data: { kind: "assistant", tokens, cost: 2, pricing: "catalog_estimate" },
        })
      // Late cleanup must not replace a known finish with unknown/zero usage.
      yield* SessionUsage.record({ ...current, data: { kind: "assistant", pricing: "unknown" } })
      const reloaded = yield* Effect.gen(function* () {
        return yield* (yield* Goal.Service).get(root.id)
      }).pipe(Effect.provide(Goal.defaultLayer))
      expect(reloaded?.tokensUsed).toBe(20)
      expect(reloaded?.costUsed).toBe(2)
      yield* SessionUsage.record({
        ...current,
        id: crypto.randomUUID(),
        data: { kind: "assistant", tokens, cost: 3, pricing: "catalog_estimate" },
      })
      expect((yield* goals.get(root.id))?.tokensUsed).toBe(20)
      yield* goals.create({ sessionID: root.id, objective: "replacement" })
      expect((yield* goals.get(root.id))?.tokensUsed).toBe(0)
      expect(
        yield* goals.update({ sessionID: root.id, status: "completed", createdAt: reloaded?.createdAt }),
      ).toBeUndefined()
      expect(yield* goals.setBudgetLimited(root.id, reloaded?.createdAt)).toBeUndefined()
      expect(yield* goals.incrementBlockedTurns(root.id, reloaded?.createdAt)).toBe(0)
      expect(yield* goals.claimTurn(root.id, MessageID.ascending(), reloaded?.createdAt)).toBeUndefined()
      expect(SessionUsage.summarize(root.id).tokens).toBe(60)
      const messageID = MessageID.ascending()
      const claims = yield* Effect.all([goals.claimTurn(root.id, messageID), goals.claimTurn(root.id, messageID)], {
        concurrency: "unbounded",
      })
      expect(claims.filter(Boolean)).toHaveLength(1)
      const again = yield* Effect.gen(function* () {
        return yield* (yield* Goal.Service).claimTurn(root.id, messageID)
      }).pipe(Effect.provide(Goal.defaultLayer))
      expect(again).toBeUndefined()
      const acquired = claims.find((claim) => claim !== undefined)
      if (!acquired) throw new Error("missing claim")
      yield* goals.releaseTurn(root.id, acquired.token, false)
      const retried = yield* goals.claimTurn(root.id, messageID)
      if (!retried) throw new Error("released claim was not recoverable")
      yield* goals.releaseTurn(root.id, acquired.token, true)
      expect((yield* goals.getTurn(root.id))?.token).toBe(retried.token)
      yield* goals.releaseTurn(root.id, retried.token, true)
      expect(yield* goals.claimTurn(root.id, messageID)).toBeUndefined()
      yield* goals.clear(root.id)
      yield* goals.create({ sessionID: root.id, objective: "after reset" })
      expect((yield* goals.get(root.id))?.tokensUsed).toBe(0)
    }),
)

it.instance("stream tracking counts normalized reasoning/cache exactly once and retains usage across failure", () =>
  Effect.gen(function* () {
    const root = yield* (yield* Session.Service).create({})
    const goals = yield* Goal.Service
    yield* goals.create({ sessionID: root.id, objective: "track" })
    const events: LLMEvent[] = [finish, { type: "step-start", index: 1 }, { ...finish, index: 1 }]
    yield* Stream.fromIterable(events).pipe(
      SessionUsage.track({ sessionID: root.id, kind: "assistant", model }),
      Stream.runDrain,
    )
    expect((yield* goals.get(root.id))?.tokensUsed).toBe(40)
    yield* Stream.concat(Stream.succeed(finish), Stream.fail("failed after finish")).pipe(
      SessionUsage.track({ sessionID: root.id, kind: "reviewer", model }),
      Stream.runDrain,
      Effect.ignore,
    )
    yield* Stream.fail("abandoned").pipe(
      SessionUsage.track({ sessionID: root.id, kind: "steering", model }),
      Stream.runDrain,
      Effect.ignore,
    )
    yield* Stream.fromEffect(Effect.interrupt).pipe(
      SessionUsage.track({ sessionID: root.id, kind: "assistant", model }),
      Stream.runDrain,
      Effect.exit,
    )
    const summary = SessionUsage.summarize(root.id)
    expect(summary.tokens).toBe(60)
    expect(summary.attempts).toBe(5)
    expect(summary.unknownAttempts).toBe(2)
    expect(summary.external).toBe("unknown")
  }),
)

it.instance("premium tier costs remain explicitly unverified unless the provider reports cost", () =>
  Effect.gen(function* () {
    const root = yield* (yield* Session.Service).create({})
    yield* Stream.succeed(finish).pipe(
      SessionUsage.track({ sessionID: root.id, kind: "assistant", model, serviceTier: "ultrafast" }),
      Stream.runDrain,
    )
    expect(SessionUsage.summarize(root.id).pricing).toBe("tier_unverified")
    expect(SessionUsage.summarize(root.id).unknownCosts).toBe(1)
    yield* Stream.succeed({ ...finish, providerMetadata: { gateway: { cost: "0.25" } } }).pipe(
      SessionUsage.track({ sessionID: root.id, kind: "assistant", model, serviceTier: "ultrafast" }),
      Stream.runDrain,
    )
    expect(SessionUsage.summarize(root.id).unknownCosts).toBe(1)
    expect(SessionUsage.summarize(root.id).cost).toBeGreaterThan(0.25)
  }),
)

for (const pricing of [
  { name: "missing prices defaulted to zero", costKnown: false, expected: "unknown" },
  { name: "legacy zero prices without provenance", costKnown: undefined, expected: "unknown" },
  { name: "explicitly free model", costKnown: true, expected: "catalog_estimate" },
] as const) {
  it.instance(`pricing distinguishes ${pricing.name}`, () =>
    Effect.gen(function* () {
      const root = yield* (yield* Session.Service).create({})
      yield* Stream.succeed(finish).pipe(
        SessionUsage.track({
          sessionID: root.id,
          kind: "assistant",
          model: {
            ...model,
            costKnown: pricing.costKnown,
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        }),
        Stream.runDrain,
      )
      const summary = SessionUsage.summarize(root.id)
      expect(summary.tokens).toBe(20)
      expect(summary.cost).toBe(0)
      expect(summary.pricing).toBe(pricing.expected)
      expect(summary.unknownCosts).toBe(pricing.costKnown === true ? 0 : 1)
    }),
  )
}

it.instance("gateway billing rejects null blank negative and nonnumeric costs", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    for (const raw of [null, "", " ", -1, "-1", "invalid", 0, "0", 0.25]) {
      const root = yield* sessions.create({})
      const reported = typeof raw === "number" ? raw >= 0 : raw === "0"
      yield* Stream.succeed({ ...finish, providerMetadata: { gateway: { cost: raw } } }).pipe(
        SessionUsage.track({ sessionID: root.id, kind: "assistant", model: { ...model, costKnown: false } }),
        Stream.runDrain,
      )
      const summary = SessionUsage.summarize(root.id)
      expect(summary.pricing).toBe(reported ? "provider_reported" : "unknown")
      expect(summary.unknownCosts).toBe(reported ? 0 : 1)
    }
  }),
)

it.instance("empty usage stays unknown, restarted steps are separate attempts, and finish-only usage is retained", () =>
  Effect.gen(function* () {
    const root = yield* (yield* Session.Service).create({})
    const events: LLMEvent[] = [
      { type: "step-start", index: 0 },
      { type: "step-start", index: 0 },
      { ...finish, usage: new Usage({}) },
    ]
    yield* Stream.fromIterable(events).pipe(
      SessionUsage.track({ sessionID: root.id, kind: "assistant", model }),
      Stream.runDrain,
    )
    expect(SessionUsage.summarize(root.id).attempts).toBe(2)
    expect(SessionUsage.summarize(root.id).unknownAttempts).toBe(2)
    const final: LLMEvent = {
      type: "finish",
      reason: "stop",
      usage: new Usage({ totalTokens: 39 }),
      providerMetadata: { gateway: { cost: "0.5" } },
    }
    yield* Stream.succeed(final).pipe(
      SessionUsage.track({ sessionID: root.id, kind: "auxiliary", model }),
      Stream.runDrain,
    )
    expect(SessionUsage.summarize(root.id).tokens).toBe(39)
    expect(SessionUsage.summarize(root.id).cost).toBe(0.5)
    expect(SessionUsage.summarize(root.id).unknownCosts).toBe(2)
  }),
)
