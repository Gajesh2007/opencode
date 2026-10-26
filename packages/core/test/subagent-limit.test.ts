import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Document, Info } from "@opencode/schema/config"
import { Config } from "@opencode/core/config"
import { SubagentLimit } from "@opencode/core/subagent-limit"
import { testEffect } from "./lib/effect"

const it = testEffect(
  LayerNode.compile(SubagentLimit.node, {
    replacements: [
      Config.node.replace(
        Config.testLayer([
          new Document({
            type: "document",
            info: Schema.decodeUnknownSync(Info)({ experimental: { subagent_concurrency: 1 } }),
          }),
        ]),
      ),
    ],
  }),
)
it.effect("shares the configured concurrency permit across child jobs", () =>
  Effect.gen(function* () {
    const limits = yield* SubagentLimit.Service
    const permit = yield* limits.semaphore
    if (!permit) return yield* Effect.die("Expected configured limiter")
    expect(yield* limits.semaphore).toBe(permit)
    const first = yield* Deferred.make<void>()
    const second = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const one = yield* permit
      .withPermit(Deferred.succeed(first, undefined).pipe(Effect.andThen(Deferred.await(release))))
      .pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Deferred.await(first)
    const two = yield* permit
      .withPermit(Deferred.succeed(second, undefined))
      .pipe(Effect.forkScoped({ startImmediately: true }))
    expect(yield* Deferred.isDone(second)).toBe(false)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(one)
    yield* Fiber.join(two)
    expect(yield* Deferred.isDone(second)).toBe(true)
  }),
)
