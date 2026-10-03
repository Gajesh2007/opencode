import { Effect, Layer, Context, Schema } from "effect"
import { Bus } from "@/bus"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID } from "./schema"
import { and, Database, eq, inArray, sql } from "@/storage/db"
import { MessageTable, PartTable } from "./session.sql"

function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return Buffer.from(bytes).toString()
}

export interface Interface {
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (input: { messages: MessageV2.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service

    const diffParts = (parts: readonly { type: string; snapshot?: string | null }[]) => {
      const from = parts.find((part) => part.type === "step-start" && part.snapshot)?.snapshot
      const to = parts.findLast((part) => part.type === "step-finish" && part.snapshot)?.snapshot
      return from && to ? snapshot.diffFull(from, to) : Effect.succeed([])
    }

    const computeDiff = Effect.fn("SessionSummary.computeDiff")((input: { messages: MessageV2.WithParts[] }) => {
      return diffParts(
        input.messages.flatMap((item) =>
          item.parts.filter((part) => part.type === "step-start" || part.type === "step-finish"),
        ),
      )
    })

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      if (
        !Database.use((db) =>
          db
            .select({ id: MessageTable.id })
            .from(MessageTable)
            .where(eq(MessageTable.session_id, input.sessionID))
            .get(),
        )
      )
        return

      // Project only snapshot metadata. Hydrating tool output here duplicates the
      // entire conversation on every step, even after model-history compaction.
      const parts = Database.use((db) =>
        db
          .select({
            messageID: PartTable.message_id,
            parentID: sql<string | null>`json_extract(${MessageTable.data}, '$.parentID')`,
            role: sql<string>`json_extract(${MessageTable.data}, '$.role')`,
            type: sql<string>`json_extract(${PartTable.data}, '$.type')`,
            snapshot: sql<string | null>`json_extract(${PartTable.data}, '$.snapshot')`,
          })
          .from(PartTable)
          .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
          .where(
            and(
              eq(MessageTable.session_id, input.sessionID),
              inArray(sql`json_extract(${PartTable.data}, '$.type')`, ["step-start", "step-finish"]),
            ),
          )
          .orderBy(MessageTable.time_created, MessageTable.id, PartTable.id)
          .all(),
      )
      const diffs = yield* diffParts(parts)
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })

      const target = Database.use((db) =>
        db
          .select()
          .from(MessageTable)
          .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
          .get(),
      )
      if (!target || target.data.role !== "user") return
      const msgDiffs = yield* diffParts(
        parts.filter(
          (part) =>
            part.messageID === input.messageID || (part.role === "assistant" && part.parentID === input.messageID),
        ),
      )
      yield* sessions.updateMessage({
        ...target.data,
        id: target.id,
        sessionID: target.session_id,
        summary: { ...target.data.summary, diffs: msgDiffs },
      })
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      const diffs = yield* storage
        .read<Snapshot.FileDiff[]>(["session_diff", input.sessionID])
        .pipe(Effect.catch(() => Effect.succeed([] as Snapshot.FileDiff[])))
      const next = diffs.map((item) => {
        if (item.file === undefined) return item
        const file = unquoteGitPath(item.file)
        if (file === item.file) return item
        return { ...item, file }
      })
      const changed = next.some((item, i) => item.file !== diffs[i]?.file)
      if (changed) yield* storage.write(["session_diff", input.sessionID], next).pipe(Effect.ignore)
      return next
    })

    return Service.of({ summarize, diff, computeDiff })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
  ),
)

export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

export * as SessionSummary from "./summary"
