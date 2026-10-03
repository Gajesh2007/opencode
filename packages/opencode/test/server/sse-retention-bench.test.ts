// Run manually: OPENCODE_SSE_RETENTION_BENCH=1 bun test test/server/sse-retention-bench.test.ts
import { describe, expect } from "bun:test"
import { heapStats } from "bun:jsc"
import { randomBytes } from "node:crypto"
import { Deferred, Effect, Exit, Fiber, Layer, Queue, Schema, Scope, Stream } from "effect"
import { Bus } from "../../src/bus"
import { GlobalBus, subscribeBounded, type GlobalEvent } from "../../src/bus/global"
import { disconnectOnOverflow, SSE_QUEUE_CAPACITY } from "../../src/server/event"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Bus.layer, CrossSpawnSpawner.defaultLayer))
const count = 10_000
const Delta = { type: "message.part.delta", properties: Schema.Struct({ delta: Schema.String }) }

describe.skipIf(process.env.OPENCODE_SSE_RETENTION_BENCH !== "1")("SSE retained-payload benchmark", () => {
  it.instance(
    "compares actual native wildcard and opt-in bounded bus subscriptions in one environment",
    () =>
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        yield* bus.publish(Delta, { delta: "warmup" })
        for (const bounded of [false, true]) {
          const scope = yield* Scope.make()
          yield* Scope.provide(scope)(bus.subscribeAll(bounded ? { capacity: SSE_QUEUE_CAPACITY } : undefined))
          Bun.gc(true)
          const heap = heapStats().heapSize
          const refs: WeakRef<{ delta: string }>[] = []
          const start = performance.now()
          yield* Effect.gen(function* () {
            for (let index = 0; index < count; index++) {
              const properties = { delta: randomBytes(2048).toString("hex") }
              refs.push(new WeakRef(properties))
              yield* bus.publish(Delta, properties)
            }
          })
          const publishMs = performance.now() - start
          yield* Effect.promise(() => Bun.sleep(0))
          Bun.gc(true)
          const heapGrowth = heapStats().heapSize - heap
          const retained = refs.filter((ref) => ref.deref() !== undefined).length
          console.log(
            JSON.stringify({
              path: "instance",
              bounded,
              count,
              retained,
              payloadBytes: retained * 4096,
              heapGrowth,
              publishMs,
            }),
          )
          expect(retained).toBe(bounded ? 0 : count)
          yield* Scope.close(scope, Exit.void)
        }
      }),
    30_000,
  )

  it.live(
    "compares old global callback and bounded SSE with a stalled body writer",
    () =>
      Effect.gen(function* () {
        for (const bounded of [false, true]) {
          const scope = yield* Scope.make()
          const registered = yield* Deferred.make<void>()
          const writing = yield* Deferred.make<void>()
          const overflow = yield* Deferred.make<void>()
          const before = GlobalBus.listenerCount("event")
          const register = (handler: (event: GlobalEvent) => void) => {
            GlobalBus.on("event", handler)
            Deferred.doneUnsafe(registered, Effect.void)
            return () => {
              GlobalBus.off("event", handler)
            }
          }
          const events = bounded
            ? yield* Scope.provide(scope)(
                subscribeBounded<GlobalEvent>(register, {
                  capacity: SSE_QUEUE_CAPACITY,
                  onOverflow: () => Deferred.doneUnsafe(overflow, Effect.void),
                }),
              )
            : Stream.callback<GlobalEvent>((queue) =>
                Effect.acquireRelease(
                  Effect.sync(() => register((event) => Queue.offerUnsafe(queue, event))),
                  (cleanup) => Effect.sync(cleanup),
                ),
              )
          const consumer = yield* Scope.provide(scope)(
            (bounded ? disconnectOnOverflow(events, overflow) : events).pipe(
              Stream.runForEach(() => Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never))),
              Effect.forkScoped,
            ),
          )
          yield* Deferred.await(registered)
          GlobalBus.emit("event", { payload: { type: Delta.type, properties: { delta: "stall" } } })
          yield* Deferred.await(writing).pipe(Effect.timeout("1 second"))
          Bun.gc(true)
          const heap = heapStats().heapSize
          const refs: WeakRef<{ delta: string }>[] = []
          const start = performance.now()
          for (let index = 0; index < count; index++) {
            const properties = { delta: randomBytes(2048).toString("hex") }
            refs.push(new WeakRef(properties))
            GlobalBus.emit("event", { payload: { type: Delta.type, properties } })
          }
          const publishMs = performance.now() - start
          if (bounded) yield* Fiber.await(consumer).pipe(Effect.timeout("1 second"))
          yield* Effect.promise(() => Bun.sleep(0))
          Bun.gc(true)
          const heapGrowth = heapStats().heapSize - heap
          const retained = refs.filter((ref) => ref.deref() !== undefined).length
          console.log(
            JSON.stringify({
              path: "global",
              bounded,
              count,
              retained,
              payloadBytes: retained * 4096,
              heapGrowth,
              publishMs,
            }),
          )
          expect(retained).toBe(bounded ? 0 : count)
          expect(GlobalBus.listenerCount("event")).toBe(before + (bounded ? 0 : 1))
          yield* Scope.close(scope, Exit.void)
          expect(GlobalBus.listenerCount("event")).toBe(before)
        }
      }),
    30_000,
  )
})
