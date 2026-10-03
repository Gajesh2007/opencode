import { describe, expect } from "bun:test"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import { NodeHttpServer, NodeHttpServerRequest } from "@effect/platform-node"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createServer, type ServerResponse } from "node:http"
import { connect, type Socket } from "node:net"
import { GlobalBus, subscribeBounded, type GlobalEvent } from "../../src/bus/global"
import { disconnectOnOverflow, SSE_QUEUE_CAPACITY } from "../../src/server/event"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const subscribe = (capacity: number, onOverflow?: () => void) =>
  subscribeBounded<GlobalEvent>(
    (handler) => {
      GlobalBus.on("event", handler)
      return () => {
        GlobalBus.off("event", handler)
      }
    },
    { capacity, onOverflow },
  )

describe("bounded SSE subscriptions", () => {
  it.live("registers eagerly and preserves event ordering", () =>
    Effect.gen(function* () {
      const before = GlobalBus.listenerCount("event")
      const stream = yield* subscribe(3)
      expect(GlobalBus.listenerCount("event")).toBe(before + 1)
      GlobalBus.emit("event", { payload: { id: "first", type: "test.sse" } })
      GlobalBus.emit("event", { payload: { id: "second", type: "test.sse" } })
      expect(yield* stream.pipe(Stream.take(2), Stream.runCollect, Effect.timeout("1 second"))).toMatchObject([
        { payload: { id: "first" } },
        { payload: { id: "second" } },
      ])
      expect(GlobalBus.listenerCount("event")).toBe(before)
    }),
  )

  it.live("overflow detaches immediately even before consumption starts", () =>
    Effect.gen(function* () {
      const before = GlobalBus.listenerCount("event")
      const calls: number[] = []
      const stream = yield* subscribe(2, () => calls.push(1))
      GlobalBus.emit("event", { payload: { type: "test.sse" } })
      GlobalBus.emit("event", { payload: { type: "test.sse" } })
      expect(calls).toHaveLength(0)
      expect(GlobalBus.listenerCount("event")).toBe(before + 1)
      GlobalBus.emit("event", { payload: { type: "test.sse" } })
      expect(GlobalBus.listenerCount("event")).toBe(before)
      GlobalBus.emit("event", { payload: { type: "test.sse" } })
      expect(calls).toHaveLength(1)
      const exit = yield* stream.pipe(Stream.runDrain, Effect.exit, Effect.timeout("1 second"))
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    }),
  )

  it.live("overflow interrupts a stalled downstream body writer and runs its finalizer", () =>
    Effect.gen(function* () {
      const before = GlobalBus.listenerCount("event")
      const overflow = yield* Deferred.make<void>()
      const writing = yield* Deferred.make<void>()
      const finalized = yield* Deferred.make<void>()
      const events = yield* subscribe(2, () => Deferred.doneUnsafe(overflow, Effect.void))
      const consumer = yield* disconnectOnOverflow(events, overflow).pipe(
        Stream.runForEach(() => Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never))),
        Effect.ensuring(Deferred.succeed(finalized, undefined)),
        Effect.forkScoped,
      )
      GlobalBus.emit("event", { payload: { type: "test.sse" } })
      yield* Deferred.await(writing).pipe(Effect.timeout("1 second"))
      for (const id of ["one", "two", "overflow"]) GlobalBus.emit("event", { payload: { id, type: "test.sse" } })
      const exit = yield* Fiber.await(consumer).pipe(Effect.timeout("1 second"))
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      yield* Deferred.await(finalized)
      expect(GlobalBus.listenerCount("event")).toBe(before)
    }),
  )

  it.live("request cancellation cleans up a subscription that was never consumed", () =>
    Effect.gen(function* () {
      const before = GlobalBus.listenerCount("event")
      const scope = yield* Scope.make()
      yield* Scope.provide(scope)(subscribe(2))
      expect(GlobalBus.listenerCount("event")).toBe(before + 1)
      yield* Scope.close(scope, Exit.void)
      expect(GlobalBus.listenerCount("event")).toBe(before)
    }),
  )

  it.live("overflow before body activation interrupts instead of sending a partial backlog", () =>
    Effect.gen(function* () {
      const overflow = yield* Deferred.make<void>()
      const events = yield* subscribe(1, () => Deferred.doneUnsafe(overflow, Effect.void))
      GlobalBus.emit("event", { payload: { type: "test.sse" } })
      GlobalBus.emit("event", { payload: { type: "test.sse" } })
      const exit = yield* disconnectOnOverflow(events, overflow).pipe(Stream.runDrain, Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    }),
  )

  it.live(
    "overflow destroys a backpressured native TCP response and releases its write buffer",
    () =>
      Effect.gen(function* () {
        const before = GlobalBus.listenerCount("event")
        const native = yield* Deferred.make<{ response: ServerResponse; socket: Socket }>()
        const closed = yield* Deferred.make<void>()
        const context = yield* Layer.build(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
        const server = Context.get(context, HttpServer.HttpServer)
        yield* server.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const response = NodeHttpServerRequest.toServerResponse(request)
            const socket = NodeHttpServerRequest.toIncomingMessage(request).socket
            socket.once("close", () => Deferred.doneUnsafe(closed, Effect.void))
            yield* Deferred.succeed(native, { response, socket })
            const overflow = yield* Deferred.make<void>()
            const events = yield* subscribe(SSE_QUEUE_CAPACITY, () => Deferred.doneUnsafe(overflow, Effect.void))
            return HttpServerResponse.stream(
              Stream.make("data: connected\n\n").pipe(
                Stream.concat(events.pipe(Stream.map((event) => `data: ${JSON.stringify(event)}\n\n`))),
                Stream.encodeText,
                (stream) => disconnectOnOverflow(stream, overflow),
              ),
              { contentType: "text/event-stream" },
            )
          }),
        )
        if (server.address._tag !== "TcpAddress") return yield* Effect.die("expected TCP listener")
        const client = connect(server.address.port, "127.0.0.1")
        yield* Effect.addFinalizer(() => Effect.sync(() => client.destroy()))
        yield* Effect.callback<void, Error>((resume) => {
          client.once("data", () => {
            client.pause()
            resume(Effect.void)
          })
          client.once("error", (error) => resume(Effect.fail(error)))
          client.write("GET /event HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        }).pipe(Effect.timeout("2 seconds"))
        const state = yield* Deferred.await(native)
        // Publish until Node has an observed pending write, not an assumed timer window.
        yield* pollWithTimeout(
          Effect.sync(() => {
            if (state.response.writableLength > 0 || state.response.writableNeedDrain) return true
            GlobalBus.emit("event", { payload: { type: "large", properties: { text: "x".repeat(1024 * 1024) } } })
            return undefined
          }),
          "native response never became backpressured",
          "2 seconds",
        )
        expect(state.response.writableLength).toBeGreaterThan(0)
        yield* Effect.sync(() => {
          for (let index = 0; index < SSE_QUEUE_CAPACITY * 3; index++) {
            GlobalBus.emit("event", { payload: { type: "overflow", properties: {} } })
          }
        })
        expect(GlobalBus.listenerCount("event")).toBe(before)
        yield* Deferred.await(closed).pipe(Effect.timeout("2 seconds"))
        expect(state.response.destroyed).toBe(true)
        expect(state.socket.destroyed).toBe(true)
        expect(state.socket.writableLength).toBe(0)
        expect(state.response.writableLength).toBe(0)
        // Publishers continue synchronously while the client remains paused.
        GlobalBus.emit("event", { payload: { type: "after-overflow", properties: {} } })
        expect(GlobalBus.listenerCount("event")).toBe(before)
      }),
    10_000,
  )
})
