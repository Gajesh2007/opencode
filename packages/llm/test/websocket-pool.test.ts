import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import { pool, type WebSocketConnection } from "../src/route/transport/websocket"
import { it } from "./lib/effect"

const server = Effect.acquireRelease(
  Effect.sync(() => {
    const opened: Array<{ id: number; headers: globalThis.Headers }> = []
    const closed: number[] = []
    const listener = Bun.serve<{ id: number; cache: Set<string> }>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        const id = opened.length + 1
        const headers = new globalThis.Headers(request.headers)
        if (server.upgrade(request, { data: { id, cache: new Set() } })) {
          opened.push({ id, headers })
          return undefined
        }
        return new Response("Upgrade required", { status: 426 })
      },
      websocket: {
        message(socket, message) {
          const text = String(message)
          if (text === "disconnect") {
            socket.close(1011)
            return
          }
          if (text.startsWith("save:")) socket.data.cache.add(text.slice(5))
          socket.send(
            text.startsWith("load:")
              ? `${socket.data.id}:${socket.data.cache.has(text.slice(5))}`
              : `${socket.data.id}:${text}`,
          )
        },
        close(socket) {
          closed.push(socket.data.id)
        },
      },
    })
    return { url: `ws://127.0.0.1:${listener.port}/responses`, opened, closed, listener }
  }),
  ({ listener }) =>
    Effect.sync(() => {
      // Bun can leave stop() pending after a server-initiated abnormal close.
      void listener.stop(true)
    }),
)

const exchange = (connection: WebSocketConnection, message: string) =>
  connection
    .sendText(message)
    .pipe(Effect.andThen(connection.messages.pipe(Stream.take(1), Stream.runCollect)), Effect.timeout("2 seconds"))

const waitFor = (predicate: () => boolean) =>
  Effect.gen(function* () {
    while (!predicate()) yield* Effect.sleep("5 millis")
  }).pipe(Effect.timeout("2 seconds"))

describe("WebSocket pool (local server)", () => {
  it.live("reuses a connection and its cache across sequential leases", () =>
    Effect.gen(function* () {
      const local = yield* server
      const executor = pool({ idleTtlMillis: 100 })
      const input = { url: local.url, headers: Headers.fromInput({ "x-session-affinity": "one" }) }
      const first = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      expect(yield* exchange(first, "save:response-one")).toEqual(["1:save:response-one"])
      yield* first.close
      const second = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      expect(yield* exchange(second, "load:response-one")).toEqual(["1:true"])
      yield* second.close
      expect(local.opened).toHaveLength(1)
      yield* waitFor(() => local.closed.length === 1)
    }),
  )

  it.live("isolates session caches and normalizes header order and casing", () =>
    Effect.gen(function* () {
      const local = yield* server
      const executor = pool({ idleTtlMillis: 100 })
      const first = yield* Effect.acquireRelease(
        executor.open({
          url: local.url,
          headers: Headers.fromInput({ Authorization: "Bearer test", "X-Session-Affinity": "one" }),
        }),
        (connection) => connection.close,
      )
      expect(yield* exchange(first, "save:response-one")).toEqual(["1:save:response-one"])
      yield* first.close
      const second = yield* Effect.acquireRelease(
        executor.open({
          url: local.url,
          headers: Headers.fromInput({ authorization: "Bearer test", "x-session-affinity": "two" }),
        }),
        (connection) => connection.close,
      )
      expect(yield* exchange(second, "load:response-one")).toEqual(["2:false"])
      yield* second.close
      const third = yield* Effect.acquireRelease(
        executor.open({
          url: local.url,
          headers: Headers.fromInput({ "x-session-affinity": "one", authorization: "Bearer test" }),
        }),
        (connection) => connection.close,
      )
      expect(yield* exchange(third, "load:response-one")).toEqual(["1:true"])
      expect(local.opened.map((entry) => entry.headers.get("x-session-affinity"))).toEqual(["one", "two"])
    }),
  )

  it.live("does not reuse a handshake when organization, beta, auth, or URL changes", () =>
    Effect.gen(function* () {
      const local = yield* server
      const executor = pool({ idleTtlMillis: 100 })
      const headers = { authorization: "Bearer test", "openai-organization": "one", "openai-beta": "a" }
      const inputs = [
        { url: local.url, headers },
        { url: local.url, headers: { ...headers, "openai-organization": "two" } },
        { url: local.url, headers: { ...headers, "openai-beta": "b" } },
        { url: local.url, headers: { ...headers, authorization: "Bearer other" } },
        { url: `${local.url}?other=true`, headers },
      ]
      for (const [index, input] of inputs.entries()) {
        const connection = yield* Effect.acquireRelease(
          executor.open({ ...input, headers: Headers.fromInput(input.headers) }),
          (connection) => connection.close,
        )
        expect(yield* exchange(connection, "hello")).toEqual([`${index + 1}:hello`])
        yield* connection.close
      }
      expect(local.opened).toHaveLength(5)
    }),
  )

  it.live("keeps overlapping leases alive and closes the temporary socket on release", () =>
    Effect.gen(function* () {
      const local = yield* server
      const executor = pool({ idleTtlMillis: 100 })
      const input = { url: local.url, headers: Headers.empty }
      const first = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      const second = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      expect(yield* exchange(second, "two")).toEqual(["2:two"])
      expect(yield* exchange(first, "one")).toEqual(["1:one"])
      expect(local.closed).toHaveLength(0)
      yield* second.close
      yield* waitFor(() => local.closed.includes(2))
      yield* first.close
      const third = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      expect(yield* exchange(third, "three")).toEqual(["1:three"])
      expect(local.opened).toHaveLength(2)
    }),
  )

  it.live("late and repeated releases cannot evict or unlock another lease", () =>
    Effect.gen(function* () {
      const local = yield* server
      const executor = pool({ idleTtlMillis: 100 })
      const input = { url: local.url, headers: Headers.empty }
      const first = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      const second = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      yield* first.close
      const third = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      yield* second.close
      yield* first.close
      const fourth = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      expect(yield* exchange(third, "three")).toEqual(["1:three"])
      expect(yield* exchange(fourth, "four")).toEqual(["3:four"])
      yield* fourth.close
      yield* third.close
      const fifth = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      expect(yield* exchange(fifth, "five")).toEqual(["1:five"])
      expect(local.opened).toHaveLength(3)
    }),
  )

  it.live("allows simultaneous handshakes without displacing the primary connection", () =>
    Effect.gen(function* () {
      const local = yield* server
      const executor = pool({ idleTtlMillis: 100 })
      const input = { url: local.url, headers: Headers.empty }
      const connections = yield* Effect.forEach(
        [0, 1, 2],
        () => Effect.acquireRelease(executor.open(input), (connection) => connection.close),
        { concurrency: "unbounded" },
      )
      const replies = yield* Effect.forEach(connections, (connection) => exchange(connection, "ping"), {
        concurrency: "unbounded",
      })
      expect(replies).toEqual(expect.arrayContaining([["1:ping"], ["2:ping"], ["3:ping"]]))
      expect(local.closed).toHaveLength(0)
      yield* Effect.forEach(connections, (connection) => connection.close)
      yield* waitFor(() => local.closed.length === 2)
      const next = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      expect(yield* exchange(next, "next")).toEqual(["1:next"])
      expect(local.opened).toHaveLength(3)
    }),
  )

  it.live("releases an interrupted stream and attaches fresh listeners on reuse", () =>
    Effect.gen(function* () {
      const local = yield* server
      const executor = pool({ idleTtlMillis: 100 })
      const input = { url: local.url, headers: Headers.empty }
      yield* Effect.gen(function* () {
        const first = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
        expect(yield* exchange(first, "save:response-one")).toEqual(["1:save:response-one"])
        yield* first.messages.pipe(Stream.runDrain)
      }).pipe(Effect.scoped, Effect.timeout("100 millis"), Effect.flip)
      const next = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      expect(yield* exchange(next, "load:response-one")).toEqual(["1:true"])
      expect(local.opened).toHaveLength(1)
    }),
  )

  it.live("replaces a server-closed connection without a late release deleting the replacement", () =>
    Effect.gen(function* () {
      const local = yield* server
      const executor = pool({ idleTtlMillis: 100 })
      const input = { url: local.url, headers: Headers.empty }
      const first = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      yield* first.sendText("disconnect")
      const error = yield* first.messages.pipe(Stream.runCollect, Effect.flip, Effect.timeout("2 seconds"))
      expect(error.message).toContain("1011")
      yield* first.close
      const second = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      yield* first.close
      expect(yield* exchange(second, "two")).toEqual(["2:two"])
      yield* second.close
      const third = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      expect(yield* exchange(third, "three")).toEqual(["2:three"])
      expect(local.opened).toHaveLength(2)
    }),
  )

  it.live("does not expire a busy lease, then closes it after its idle TTL", () =>
    Effect.gen(function* () {
      const local = yield* server
      const executor = pool({ idleTtlMillis: 20 })
      const input = { url: local.url, headers: Headers.empty }
      const first = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      yield* first.close
      const second = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      yield* Effect.sleep("50 millis")
      expect(local.closed).toHaveLength(0)
      expect(yield* exchange(second, "still busy")).toEqual(["1:still busy"])
      yield* second.close
      yield* waitFor(() => local.closed.length === 1)
      const third = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      expect(yield* exchange(third, "new")).toEqual(["2:new"])
    }),
  )

  it.live("retires an aged connection on release without interrupting its busy lease", () =>
    Effect.gen(function* () {
      const local = yield* server
      const executor = pool({ idleTtlMillis: 100, maxAgeMillis: 20 })
      const input = { url: local.url, headers: Headers.empty }
      const first = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      yield* Effect.sleep("50 millis")
      expect(yield* exchange(first, "still busy")).toEqual(["1:still busy"])
      yield* first.close
      yield* waitFor(() => local.closed.length === 1)
      const next = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      expect(yield* exchange(next, "new")).toEqual(["2:new"])
      expect(local.opened).toHaveLength(2)
    }),
  )

  it.live("bounds idle retention by release recency without evicting active leases", () =>
    Effect.gen(function* () {
      const local = yield* server
      const executor = pool({ idleTtlMillis: 10_000, maxIdleConnections: 2 })
      const open = (session: string) =>
        Effect.acquireRelease(
          executor.open({ url: local.url, headers: Headers.fromInput({ "x-session-affinity": session }) }),
          (connection) => connection.close,
        )
      const active = yield* open("active")
      const first = yield* open("first")
      expect(yield* exchange(first, "save:cached")).toEqual(["2:save:cached"])
      yield* first.close
      const second = yield* open("second")
      yield* second.close
      const reused = yield* open("first")
      expect(yield* exchange(reused, "load:cached")).toEqual(["2:true"])
      yield* reused.close
      const third = yield* open("third")
      yield* third.close

      yield* waitFor(() => local.closed.includes(3))
      expect(local.closed).toEqual([3])
      expect(yield* exchange(active, "still active")).toEqual(["1:still active"])
      expect(local.opened.length - local.closed.length).toBe(3)
      yield* active.close
      yield* waitFor(() => local.closed.includes(2))
      expect(local.opened.length - local.closed.length).toBe(2)

      // Releasing an evicted lease again must not disturb its replacement.
      const replacement = yield* open("first")
      yield* first.close
      expect(yield* exchange(replacement, "new")).toEqual(["5:new"])
      yield* replacement.close
      yield* waitFor(() => local.closed.includes(4))
      expect(local.opened.length - local.closed.length).toBe(2)
    }),
  )

  it.live("supports disabling idle retention without closing a busy socket", () =>
    Effect.gen(function* () {
      const local = yield* server
      const executor = pool({ idleTtlMillis: 10_000, maxIdleConnections: 0 })
      const input = { url: local.url, headers: Headers.empty }
      const first = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      expect(yield* exchange(first, "active")).toEqual(["1:active"])
      expect(local.closed).toHaveLength(0)
      yield* first.close
      yield* waitFor(() => local.closed.length === 1)
      const next = yield* Effect.acquireRelease(executor.open(input), (connection) => connection.close)
      expect(yield* exchange(next, "new")).toEqual(["2:new"])
      yield* next.close
      yield* waitFor(() => local.closed.length === 2)
    }),
  )

  it.live("keeps idle capacity and eviction local to each pool", () =>
    Effect.gen(function* () {
      const local = yield* server
      const firstPool = pool({ idleTtlMillis: 10_000, maxIdleConnections: 1 })
      const secondPool = pool({ idleTtlMillis: 10_000, maxIdleConnections: 1 })
      const input = { url: local.url, headers: Headers.empty }
      const first = yield* Effect.acquireRelease(firstPool.open(input), (connection) => connection.close)
      yield* first.close
      const second = yield* Effect.acquireRelease(secondPool.open(input), (connection) => connection.close)
      yield* second.close
      const third = yield* Effect.acquireRelease(
        firstPool.open({ ...input, headers: Headers.fromInput({ "x-session-affinity": "other" }) }),
        (connection) => connection.close,
      )
      yield* third.close
      yield* waitFor(() => local.closed.includes(1))
      expect(local.closed).toEqual([1])
      const reused = yield* Effect.acquireRelease(secondPool.open(input), (connection) => connection.close)
      expect(yield* exchange(reused, "unaffected")).toEqual(["2:unaffected"])
      expect(local.opened).toHaveLength(3)
    }),
  )
})
