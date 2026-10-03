import { afterEach, describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Bus } from "../../src/bus"
import { Event as ServerEvent, SSE_QUEUE_CAPACITY } from "../../src/server/event"
import { GlobalBus } from "../../src/bus/global"
import { Server } from "../../src/server/server"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"

void Log.init({ print: false })

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})

const readEvent = (reader: ReadableStreamDefaultReader<Uint8Array>) =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(() => reader.read()).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for event")),
      }),
    )
    if (result.done || !result.value) return yield* Effect.fail(new Error("event stream closed"))
    return Schema.decodeUnknownSync(EventData)(
      JSON.parse(new TextDecoder().decode(result.value).replace(/^data: /, "")),
    )
  })

const openEventStream = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(async () =>
      Server.Default().app.request(EventPaths.event, { headers: { "x-opencode-directory": directory } }),
    )
    if (!response.body) return yield* Effect.die("missing SSE response body")
    const reader = response.body.getReader()
    yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel().catch(() => undefined)))
    return { response, reader }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffectShared(Bus.defaultLayer)

describe("event HttpApi", () => {
  it.instance(
    "serves event stream",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { response, reader } = yield* openEventStream(directory)

        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("text/event-stream")
        expect(response.headers.get("cache-control")).toBe("no-cache, no-transform")
        expect(response.headers.get("x-accel-buffering")).toBe("no")
        expect(response.headers.get("x-content-type-options")).toBe("nosniff")
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keeps the event stream open after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        // If no second event arrives within 250ms, the stream is still open.
        const status = yield* Effect.promise(() => reader.read()).pipe(
          Effect.map((result) => (result.done ? ("closed" as const) : ("event" as const))),
          Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.succeed("open" as const) }),
        )
        expect(status).toBe("open")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "delivers instance bus events after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        yield* Bus.use.publish(ServerEvent.Connected, {})
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "disconnects an instance SSE reader that stops draining its body",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected" })
        const closed = reader.closed.then(
          () => true,
          () => true,
        )
        // The body pump can already hold a full batch in addition to the subscription queue.
        yield* Effect.replicateEffect(Bus.use.publish(ServerEvent.Connected, {}), SSE_QUEUE_CAPACITY * 3)
        expect(yield* Effect.promise(() => closed).pipe(Effect.timeout("2 seconds"))).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.live("global SSE overflow closes the body and detaches its listener", () =>
    Effect.gen(function* () {
      const before = GlobalBus.listenerCount("event")
      const response = yield* Effect.promise(async () => Server.Default().app.request("/global/event"))
      if (!response.body) return yield* Effect.die("missing global SSE response body")
      const reader = response.body.getReader()
      yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel().catch(() => undefined)))
      const initial = yield* Effect.promise(() => reader.read())
      expect(new TextDecoder().decode(initial.value)).toContain("server.connected")
      expect(GlobalBus.listenerCount("event")).toBe(before + 1)
      const closed = reader.closed.then(
        () => true,
        () => true,
      )
      for (let index = 0; index < SSE_QUEUE_CAPACITY + 16; index++) {
        GlobalBus.emit("event", { payload: { type: "test.sse", properties: {} } })
      }
      expect(GlobalBus.listenerCount("event")).toBe(before)
      expect(yield* Effect.promise(() => closed).pipe(Effect.timeout("2 seconds"))).toBe(true)
    }),
  )
})
