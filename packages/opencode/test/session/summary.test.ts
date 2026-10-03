import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session/session"
import { MessageID, PartID } from "../../src/session/schema"
import { MessageTable, PartTable } from "../../src/session/session.sql"
import { SessionSummary } from "../../src/session/summary"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Snapshot } from "../../src/snapshot"
import { Database } from "../../src/storage/db"
import { Storage } from "../../src/storage/storage"
import { testEffect } from "../lib/effect"

const bounds: [string, string][] = []
const it = testEffect(
  SessionSummary.layer.pipe(
    Layer.provideMerge(Session.defaultLayer),
    Layer.provide(
      Layer.mock(Snapshot.Service, {
        diffFull: (from, to) =>
          Effect.sync(() => {
            bounds.push([from, to])
            return [{ file: "file.txt", additions: 2, deletions: 1, patch: `${from}:${to}` }]
          }),
      }),
    ),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
  ),
)

const history = Effect.fnUntraced(function* (count: number, bytes = 128) {
  bounds.length = 0
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ title: "Summary fixture" })
  yield* Effect.addFinalizer(() => sessions.remove(session.id).pipe(Effect.ignore))
  const ids = Array.from({ length: count }, () => MessageID.ascending())
  const messages: MessageV2.WithParts[] = ids.map((id, index) => ({
    info:
      index % 2 === 0
        ? {
            id,
            sessionID: session.id,
            role: "user",
            agent: "build",
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
            time: { created: index },
          }
        : {
            id,
            sessionID: session.id,
            role: "assistant",
            parentID: ids[index - 1],
            agent: "build",
            mode: "build",
            modelID: ModelID.make("test"),
            providerID: ProviderID.make("test"),
            path: { cwd: "/", root: "/" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: index, completed: index },
            finish: "stop",
          },
    parts: [
      ...(index % 2 === 0
        ? []
        : [
            {
              id: PartID.ascending(),
              sessionID: session.id,
              messageID: id,
              type: "step-start" as const,
              snapshot: `start-${index}`,
            },
          ]),
      { id: PartID.ascending(), sessionID: session.id, messageID: id, type: "text", text: "x".repeat(bytes) },
      ...(index % 2 === 0
        ? []
        : [
            {
              id: PartID.ascending(),
              sessionID: session.id,
              messageID: id,
              type: "step-finish" as const,
              snapshot: `end-${index}`,
              reason: "stop",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          ]),
    ],
  }))
  Database.transaction((db) => {
    for (const message of messages) {
      const { id, sessionID, ...data } = message.info
      db.insert(MessageTable).values({ id, session_id: sessionID, time_created: data.time.created, data }).run()
      for (const part of message.parts) {
        const { id, sessionID, messageID, ...data } = part
        db.insert(PartTable).values({ id, session_id: sessionID, message_id: messageID, data }).run()
      }
    }
  })
  return { sessionID: session.id, messages }
})

it.instance("summary preserves session and per-prompt snapshot boundaries", () =>
  Effect.gen(function* () {
    const fixture = yield* history(6)
    const summary = yield* SessionSummary.Service
    yield* summary.summarize({ sessionID: fixture.sessionID, messageID: fixture.messages[4].info.id })
    expect(bounds).toEqual([
      ["start-1", "end-5"],
      ["start-5", "end-5"],
    ])
    expect((yield* Session.use.get(fixture.sessionID)).summary).toMatchObject({ additions: 2, deletions: 1, files: 1 })
    const target = yield* MessageV2.get({ sessionID: fixture.sessionID, messageID: fixture.messages[4].info.id })
    expect(target.info.role).toBe("user")
    if (target.info.role === "user") expect(target.info.summary?.diffs[0].patch).toBe("start-5:end-5")
  }),
)

it.instance("summary remains fresh after parts are replaced and messages are removed", () =>
  Effect.gen(function* () {
    const fixture = yield* history(4)
    const summary = yield* SessionSummary.Service
    const sessions = yield* Session.Service
    const finish = fixture.messages[3].parts.at(-1)
    if (finish?.type !== "step-finish") throw new Error("missing finish part")
    yield* sessions.updatePart({ ...finish, snapshot: "updated" })
    yield* summary.summarize({ sessionID: fixture.sessionID, messageID: fixture.messages[2].info.id })
    expect(bounds).toEqual([
      ["start-1", "updated"],
      ["start-3", "updated"],
    ])
    bounds.length = 0
    yield* sessions.removeMessage({ sessionID: fixture.sessionID, messageID: fixture.messages[3].info.id })
    yield* summary.summarize({ sessionID: fixture.sessionID, messageID: fixture.messages[2].info.id })
    expect(bounds).toEqual([["start-1", "end-1"]])
  }),
)

it.instance("summary of an empty session leaves metadata unchanged", () =>
  Effect.gen(function* () {
    const fixture = yield* history(0)
    yield* (yield* SessionSummary.Service).summarize({ sessionID: fixture.sessionID, messageID: MessageID.ascending() })
    expect(bounds).toEqual([])
    expect((yield* Session.use.get(fixture.sessionID)).summary).toBeUndefined()
  }),
)

// Run explicitly: OPENCODE_BENCH_SESSION_SUMMARY=1 bun test test/session/summary.test.ts
const bench = process.env.OPENCODE_BENCH_SESSION_SUMMARY ? it.instance : it.instance.skip
bench(
  "benchmark summary without hydrating unrelated tool output",
  () =>
    Effect.gen(function* () {
      const fixture = yield* history(252, 128 * 1024)
      const summary = yield* SessionSummary.Service
      const input = { sessionID: fixture.sessionID, messageID: fixture.messages[250].info.id }
      for (let index = 0; index < 5; index++) yield* summary.summarize(input)
      const samples: number[] = []
      for (let run = 0; run < 5; run++) {
        Bun.gc(true)
        const start = performance.now()
        for (let index = 0; index < 10; index++) yield* summary.summarize(input)
        samples.push((performance.now() - start) / 10)
      }
      const capture = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const original = JSON.parse
          const parsed = { bytes: 0 }
          JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
            parsed.bytes += args[0].length
            return original(...args)
          }
          return { original, parsed }
        }),
        (capture) =>
          Effect.sync(() => {
            JSON.parse = capture.original
          }),
      )
      yield* summary.summarize(input)
      console.log(
        JSON.stringify({
          benchmark: "session-summary",
          messages: fixture.messages.length,
          medianMs: samples.toSorted((a, b) => a - b)[2],
          parsedJsonBytes: capture.parsed.bytes,
          rssMiB: process.memoryUsage().rss / 1024 / 1024,
        }),
      )
    }),
  { timeout: 30_000 },
)
