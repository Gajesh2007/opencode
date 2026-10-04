import { afterEach, describe, expect } from "bun:test"
import { ConfigProvider, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { SubagentLimit } from "@/agent/subagent-limit"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = (environment = {}) =>
  SubagentLimit.layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(
      RuntimeFlags.defaultLayer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment)))),
    ),
  )

const it = testEffect(layer())

describe("agent.subagent-limit", () => {
  it.instance("allows more than 200 concurrent effects by default", () =>
    Effect.gen(function* () {
      const limit = yield* SubagentLimit.Service
      expect(yield* limit.cap).toBe(Infinity)
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const entered = new Set<number>()
      const work = yield* Effect.forEach(
        Array.from({ length: 256 }, (_, index) => index),
        (index) =>
          limit.withPermit(
            Effect.gen(function* () {
              entered.add(index)
              if (entered.size === 256) yield* Deferred.succeed(ready, undefined)
              yield* Deferred.await(release)
              return index
            }),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkScoped)

      yield* awaitWithTimeout(Deferred.await(ready), "default concurrency blocked before all 256 effects entered")
      expect(entered.size).toBe(256)
      yield* Deferred.succeed(release, undefined)
      expect(yield* awaitWithTimeout(Fiber.join(work), "unlimited work did not finish")).toHaveLength(256)
    }),
  )

  for (const settings of [
    { name: "configuration", environment: {}, cap: 3 },
    { name: "environment override", environment: { OPENCODE_SUBAGENT_CONCURRENCY: "2" }, cap: 2 },
  ]) {
    testEffect(layer(settings.environment)).instance(
      `honors an explicit ${settings.name} limit and releases completed permits`,
      () =>
        Effect.gen(function* () {
          const limit = yield* SubagentLimit.Service
          expect(yield* limit.cap).toBe(settings.cap)
          const ready = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let active = 0
          let peak = 0
          const work = yield* Effect.forEach(
            Array.from({ length: 12 }, (_, index) => index),
            (index) =>
              limit.withPermit(
                Effect.gen(function* () {
                  active += 1
                  peak = Math.max(peak, active)
                  if (active === settings.cap) yield* Deferred.succeed(ready, undefined)
                  yield* Deferred.await(release)
                  return index
                }).pipe(Effect.ensuring(Effect.sync(() => active--))),
              ),
            { concurrency: "unbounded" },
          ).pipe(Effect.forkScoped)

          yield* awaitWithTimeout(Deferred.await(ready), "configured concurrency was not reached")
          expect(active).toBe(settings.cap)
          yield* Deferred.succeed(release, undefined)
          expect(yield* awaitWithTimeout(Fiber.join(work), "queued work did not finish")).toHaveLength(12)
          expect(peak).toBe(settings.cap)
          expect(active).toBe(0)
        }),
      { config: { experimental: { subagent_concurrency: 3 } } },
    )
  }

  for (const outcome of ["success", "failure", "defect", "interruption"] as const) {
    it.instance(
      `releases a configured permit after ${outcome}`,
      () =>
        Effect.gen(function* () {
          const limit = yield* SubagentLimit.Service
          expect(yield* limit.cap).toBe(1)
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const nextEntered = yield* Deferred.make<void>()
          const first = yield* limit
            .withPermit(
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
                if (outcome === "failure") return yield* Effect.fail("failure")
                if (outcome === "defect") return yield* Effect.die("defect")
                return "first"
              }),
            )
            .pipe(Effect.forkScoped)
          yield* awaitWithTimeout(Deferred.await(entered), "first effect did not acquire a permit")
          const next = yield* limit
            .withPermit(Deferred.succeed(nextEntered, undefined).pipe(Effect.as("next")))
            .pipe(Effect.forkScoped({ startImmediately: true }))
          expect(yield* Deferred.isDone(nextEntered)).toBe(false)

          if (outcome === "interruption") yield* Fiber.interrupt(first)
          if (outcome !== "interruption") yield* Deferred.succeed(release, undefined)
          expect(Exit.isSuccess(yield* Fiber.await(first))).toBe(outcome === "success")
          expect(yield* awaitWithTimeout(Fiber.join(next), "permit was not released to queued work")).toBe("next")
        }),
      { config: { experimental: { subagent_concurrency: 1 } } },
    )
  }
})
