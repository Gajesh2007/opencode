import { describe, expect } from "bun:test"
import { heapStats } from "bun:jsc"
import { Effect } from "effect"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Database } from "../../src/storage/db"
import { MessageTable, PartTable } from "../../src/session/session.sql"
import { testEffect } from "../lib/effect"

const it = testEffect(Session.defaultLayer)

const history = Effect.fnUntraced(function* (count: number, bytes = 128, time = (index: number) => index) {
  const session = yield* Session.use.create()
  yield* Effect.addFinalizer(() => Session.use.remove(session.id).pipe(Effect.ignore))
  const messages: MessageV2.WithParts[] = Array.from({ length: count }, (_, index) => {
    const id = MessageID.ascending()
    const info: MessageV2.Info =
      index % 2 === 0
        ? {
            id,
            sessionID: session.id,
            role: "user",
            time: { created: time(index) },
            agent: "build",
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
          }
        : {
            id,
            sessionID: session.id,
            role: "assistant",
            time: { created: time(index), completed: time(index) },
            parentID: MessageID.make("msg_parent"),
            modelID: ModelID.make("test"),
            providerID: ProviderID.make("test"),
            mode: "build",
            agent: "build",
            path: { cwd: "/", root: "/" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          }
    return {
      info,
      parts: [
        {
          id: PartID.ascending(),
          messageID: id,
          sessionID: session.id,
          type: "text",
          text: `${index}:${"x".repeat(bytes)}`,
        },
      ],
    }
  })
  return { sessionID: session.id, messages }
})

function persist(messages: MessageV2.WithParts[]) {
  Database.transaction((db) => {
    for (const message of messages) {
      const { id, sessionID, ...data } = message.info
      db.insert(MessageTable)
        .values({ id, session_id: sessionID, time_created: data.time.created, data })
        .onConflictDoUpdate({ target: MessageTable.id, set: { data } })
        .run()
      for (const part of message.parts) {
        const { id, sessionID, messageID, ...data } = part
        db.insert(PartTable)
          .values({ id, session_id: sessionID, message_id: messageID, time_created: 0, data })
          .onConflictDoUpdate({ target: PartTable.id, set: { data } })
          .run()
      }
    }
  })
}

function compact(messages: MessageV2.WithParts[], index: number, tail?: number) {
  const request = messages[index]
  const summary = messages[index + 1]
  if (!request || request.info.role !== "user" || !summary || summary.info.role !== "assistant") {
    throw new Error("compaction fixture needs a user followed by an assistant")
  }
  request.parts = [
    {
      id: PartID.ascending(),
      sessionID: request.info.sessionID,
      messageID: request.info.id,
      type: "compaction",
      auto: true,
      ...(tail === undefined ? {} : { tail_start_id: messages[tail].info.id }),
    },
  ]
  summary.info.summary = true
  summary.info.parentID = request.info.id
}

describe("message history hydration", () => {
  it.live("keeps the legacy empty result for missing sessions", () =>
    Effect.gen(function* () {
      expect(yield* MessageV2.filterCompactedEffect(SessionID.make("ses_missing"))).toEqual([])
    }),
  )

  it.instance("hydrates large uncompacted histories in order without omitting parts", () =>
    Effect.gen(function* () {
      const fixture = yield* history(1004)
      fixture.messages[0].parts.push({
        id: PartID.ascending(),
        messageID: fixture.messages[0].info.id,
        sessionID: fixture.sessionID,
        type: "file",
        url: "data:image/png;base64,eA==",
        mime: "image/png",
      })
      fixture.messages[500].parts = []
      persist(fixture.messages)
      expect(yield* MessageV2.filterCompactedEffect(fixture.sessionID)).toEqual(fixture.messages)
    }),
  )

  it.instance("matches full hydration across page boundaries and equal timestamps", () =>
    Effect.gen(function* () {
      const fixture = yield* history(156, 128, () => 0)
      compact(fixture.messages, 96, 44)
      persist(fixture.messages)
      const expected = MessageV2.filterCompacted(MessageV2.stream(fixture.sessionID))
      expect(yield* MessageV2.filterCompactedEffect(fixture.sessionID)).toEqual(expected)
      expect(expected[0].info.id).toBe(fixture.messages[96].info.id)
      expect(expected[2].info.id).toBe(fixture.messages[44].info.id)
    }),
  )

  it.instance("does not discard history for unfinished or failed summaries", () =>
    Effect.gen(function* () {
      const fixture = yield* history(104)
      compact(fixture.messages, 100)
      const summary = fixture.messages[101].info
      if (summary.role !== "assistant") throw new Error("missing summary")
      summary.finish = undefined
      persist(fixture.messages)
      expect(yield* MessageV2.filterCompactedEffect(fixture.sessionID)).toEqual(fixture.messages)
      summary.finish = "stop"
      summary.error = new MessageV2.AbortedError({ message: "interrupted" }).toObject()
      persist(fixture.messages)
      expect(yield* MessageV2.filterCompactedEffect(fixture.sessionID)).toEqual(fixture.messages)
    }),
  )

  it.instance("keeps the newest successful boundary despite newer failed compaction", () =>
    Effect.gen(function* () {
      const fixture = yield* history(156)
      compact(fixture.messages, 48)
      compact(fixture.messages, 150)
      const summary = fixture.messages[151].info
      if (summary.role !== "assistant") throw new Error("missing summary")
      summary.error = new MessageV2.AbortedError({ message: "interrupted" }).toObject()
      persist(fixture.messages)
      expect(yield* MessageV2.filterCompactedEffect(fixture.sessionID)).toEqual(
        MessageV2.filterCompacted(MessageV2.stream(fixture.sessionID)),
      )
    }),
  )

  it.instance("retains all history when a compaction tail is missing", () =>
    Effect.gen(function* () {
      const fixture = yield* history(104)
      compact(fixture.messages, 100)
      const part = fixture.messages[100].parts[0]
      if (part.type !== "compaction") throw new Error("missing compaction")
      part.tail_start_id = MessageID.make("msg_missing")
      persist(fixture.messages)
      expect(yield* MessageV2.filterCompactedEffect(fixture.sessionID)).toEqual(fixture.messages)
    }),
  )

  it.instance("reads fresh parts after updates and removals without retaining a cache", () =>
    Effect.gen(function* () {
      const fixture = yield* history(4)
      persist(fixture.messages)
      const first = yield* MessageV2.filterCompactedEffect(fixture.sessionID)
      const part = fixture.messages[3].parts[0]
      if (part.type !== "text") throw new Error("missing text")
      part.text = "updated"
      yield* Session.use.updatePart(part)
      expect(yield* MessageV2.filterCompactedEffect(fixture.sessionID)).toEqual(fixture.messages)
      yield* Session.use.removeMessage({ sessionID: fixture.sessionID, messageID: fixture.messages[3].info.id })
      expect(yield* MessageV2.filterCompactedEffect(fixture.sessionID)).toEqual(fixture.messages.slice(0, 3))
      expect(first[3].parts[0]).not.toEqual(part)
    }),
  )
})

// Run explicitly: OPENCODE_BENCH_SESSION_HISTORY=1 bun test test/session/message-history.test.ts
const bench = process.env.OPENCODE_BENCH_SESSION_HISTORY ? it.instance : it.instance.skip
for (const scenario of ["compacted", "uncompacted"] as const) {
  bench(
    `benchmark ${scenario} message history`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* history(252, scenario === "compacted" ? 128 * 1024 : 1024)
        if (scenario === "compacted") compact(fixture.messages, 248)
        persist(fixture.messages)
        const expected = MessageV2.filterCompacted(MessageV2.stream(fixture.sessionID))
        for (const implementation of ["baseline", "optimized"] as const) {
          // The unchanged public stream retains the original full-page hydration path.
          const read =
            implementation === "baseline"
              ? Effect.sync(() => MessageV2.filterCompacted(MessageV2.stream(fixture.sessionID)))
              : MessageV2.filterCompactedEffect(fixture.sessionID)
          for (let index = 0; index < 10; index++) yield* read
          const samples = [] as number[]
          const heaps = [] as number[]
          for (let run = 0; run < 5; run++) {
            Bun.gc(true)
            const heap = heapStats().heapSize
            const start = performance.now()
            for (let index = 0; index < 20; index++) {
              const actual = yield* read
              expect(actual.map((message) => message.info.id)).toEqual(expected.map((message) => message.info.id))
            }
            samples.push((performance.now() - start) / 20)
            heaps.push(heapStats().heapSize - heap)
          }
          const parsedBytes = yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              const original = JSON.parse
              const parsed = { bytes: 0 }
              JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
                parsed.bytes += args[0].length
                return original(...args)
              }
              return { original, parsed }
            }),
            (capture) => read.pipe(Effect.map(() => capture.parsed.bytes)),
            (capture) =>
              Effect.sync(() => {
                JSON.parse = capture.original
              }),
          )
          console.log(
            JSON.stringify({
              benchmark: "session-history",
              scenario,
              implementation,
              messages: fixture.messages.length,
              retained: expected.length,
              medianMs: samples.toSorted((a, b) => a - b)[2],
              parsedJsonBytes: parsedBytes,
              maxHeapGrowthMiB: Math.max(...heaps) / 1024 / 1024,
              rssMiB: process.memoryUsage().rss / 1024 / 1024,
            }),
          )
        }
      }),
    { timeout: 30_000 },
  )
}
