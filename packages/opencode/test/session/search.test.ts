import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { eq } from "drizzle-orm"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { WorkspaceID } from "@/control-plane/schema"
import { SessionMessage } from "@opencode-ai/core/session-message"
import { WorkspaceRef } from "@/effect/instance-ref"
import { Database } from "@/storage/db"
import { PartTable, SessionMessageTable, SessionTable } from "@/session/session.sql"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer))
const create = (input?: Session.CreateInput) =>
  Effect.acquireRelease(Session.use.create(input), (session) => Session.use.remove(session.id).pipe(Effect.ignore))

function text(sessionID: SessionID, value: string, summary?: string) {
  return Effect.gen(function* () {
    const message = yield* Session.use.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      agent: "build",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      time: { created: Date.now() },
      summary: summary ? { title: summary, diffs: [] } : undefined,
    })
    const part = yield* Session.use.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: message.id,
      type: "text",
      text: value,
    })
    return { message, part }
  })
}

describe("session.search", () => {
  it.instance("searches both persisted message formats once per chat, excluding v2 tools and reasoning", () =>
    Effect.gen(function* () {
      const projected = yield* create({ title: "Dual projection" })
      const assistant = yield* create({ title: "V2 assistant" })
      yield* text(projected.id, "shared needle")
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .insert(SessionMessageTable)
            .values([
              {
                id: SessionMessage.ID.create(),
                session_id: projected.id,
                type: "user",
                data: {
                  time: { created: 1 },
                  text: "shared needle",
                  files: [],
                  agents: [],
                  references: [],
                } as (typeof SessionMessageTable.$inferInsert)["data"],
              },
              {
                id: SessionMessage.ID.create(),
                session_id: assistant.id,
                type: "assistant",
                data: {
                  time: { created: 1 },
                  agent: "build",
                  model: { id: "test", providerID: "test", variant: "default" },
                  content: [
                    { type: "text", text: "assistant needle" },
                    { type: "reasoning", id: "reasoning", text: "secret" },
                  ],
                } as (typeof SessionMessageTable.$inferInsert)["data"],
              },
            ])
            .run(),
        ),
      )
      const found = yield* Session.use.search({ query: "needle" })
      expect(found.items).toHaveLength(2)
      expect(new Set(found.items.map((x) => x.session.id)).size).toBe(2)
      expect(found.items.find((x) => x.session.id === assistant.id)?.match).toEqual({
        type: "message",
        text: "assistant needle",
      })
      expect((yield* Session.use.search({ query: "secret" })).items).toEqual([])
      yield* Effect.sync(() =>
        Database.use((db) => db.delete(PartTable).where(eq(PartTable.session_id, projected.id)).run()),
      )
      expect((yield* Session.use.search({ query: "shared" })).items[0].match).toEqual({
        type: "message",
        text: "shared needle",
      })
    }),
  )

  it.instance("searches old archived messages, summaries, and children, not just recent titles", () =>
    Effect.gen(function* () {
      const old = yield* create({ title: "Old chat" })
      const message = yield* text(old.id, `${"padding ".repeat(100)}needle ${"tail ".repeat(100)}`)
      yield* Session.use.setArchived({ sessionID: old.id, time: 1 })
      yield* Effect.sync(() =>
        Database.use((db) => db.update(SessionTable).set({ time_updated: 1 }).where(eq(SessionTable.id, old.id)).run()),
      )
      yield* Effect.forEach(Array.from({ length: 105 }), (_, i) => create({ title: `Recent ${i}` }))
      const child = yield* create({ title: "Child", parentID: old.id })
      yield* text(child.id, "different body", "needle summary")
      expect((yield* Session.use.list()).map((x) => x.id)).not.toContain(old.id)
      const found = yield* Session.use.search({ query: "NEEDLE" })
      expect(found.items.map((x) => x.session.id)).toEqual([child.id, old.id])
      expect(found.items[0].match.type).toBe("summary")
      expect(found.items[1].match.messageID).toBe(message.message.id)
      expect(found.items[1].match.text).toContain("needle")
      expect(found.items[1].match.text.length).toBeLessThanOrEqual(220)
      expect((yield* Session.use.search({ query: "needle", mode: "title" })).items).toEqual([])
    }),
  )

  it.instance("literal LIKE metacharacters and title-only matching", () =>
    Effect.gen(function* () {
      const literal = yield* create({ title: "100%_\\ ready" })
      yield* create({ title: "100abc ready" })
      expect((yield* Session.use.search({ query: "%_\\", mode: "title" })).items.map((x) => x.session.id)).toEqual([
        literal.id,
      ])
      yield* text(literal.id, "body%_\\literal")
      expect((yield* Session.use.search({ query: "body%_\\" })).items[0].session.id).toBe(literal.id)
      expect((yield* Session.use.search({ query: "   " })).items).toEqual([])
    }),
  )

  it.instance("paginates every match with stable ordering even for equal timestamps", () =>
    Effect.gen(function* () {
      const sessions = yield* Effect.forEach(Array.from({ length: 105 }), () => create({ title: "match" }))
      yield* Effect.sync(() =>
        Database.use((db) =>
          sessions.forEach((x) =>
            db.update(SessionTable).set({ time_updated: 10 }).where(eq(SessionTable.id, x.id)).run(),
          ),
        ),
      )
      const first = yield* Session.use.search({ query: "match", limit: 40 })
      const second = yield* Session.use.search({ query: "match", limit: 40, cursor: first.next })
      const third = yield* Session.use.search({ query: "match", limit: 40, cursor: second.next })
      expect([...first.items, ...second.items, ...third.items].map((x) => x.session.id)).toEqual(
        sessions.map((x) => x.id).sort(),
      )
      expect(first.next).toBe(first.items.at(-1)?.session.id)
      expect(second.next).toBe(second.items.at(-1)?.session.id)
      expect(third.next).toBeUndefined()
    }),
  )

  it.instance("keeps every match reachable when chats are updated, archived, or deleted between pages", () =>
    Effect.gen(function* () {
      const a = yield* create({ title: "match a" })
      const b = yield* create({ title: "match b" })
      const c = yield* create({ title: "match c" })
      yield* Effect.sync(() =>
        Database.use((db) =>
          [a, b, c].forEach((session, i) =>
            db
              .update(SessionTable)
              .set({ time_updated: (i + 1) * 10 })
              .where(eq(SessionTable.id, session.id))
              .run(),
          ),
        ),
      )
      const first = yield* Session.use.search({ query: "match", limit: 1 })
      expect(first.items.map((x) => x.session.id)).toEqual([c.id])
      yield* Effect.sync(() =>
        Database.use((db) => db.update(SessionTable).set({ time_updated: 40 }).where(eq(SessionTable.id, a.id)).run()),
      )
      yield* Session.use.setArchived({ sessionID: a.id, time: Date.now() })
      yield* create({ title: "match newly created" })
      const second = yield* Session.use.search({ query: "match", limit: 1, cursor: first.next })
      expect(second.items.map((x) => x.session.id)).toEqual([b.id])
      // A cursor remains valid even if its corresponding row disappears.
      yield* Session.use.remove(b.id)
      yield* Session.use.touch(c.id)
      const third = yield* Session.use.search({ query: "match", limit: 1, cursor: second.next })
      expect(third.items.map((x) => x.session.id)).toEqual([a.id])
      expect(third.next).toBeUndefined()
    }),
  )

  it.instance("does not search tool, reasoning, or orphan/mismatched part bodies", () =>
    Effect.gen(function* () {
      const session = yield* create()
      const message = yield* text(session.id, "visible")
      yield* Session.use.updatePart({
        ...message.part,
        id: PartID.ascending(),
        type: "reasoning",
        text: "private needle",
        time: { start: 1 },
      })
      yield* Session.use.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: message.message.id,
        type: "tool",
        tool: "bash",
        callID: "call",
        state: { status: "pending", input: { text: "needle" }, raw: "needle" },
      })
      const other = yield* create()
      yield* Session.use.updatePart({
        id: PartID.ascending(),
        sessionID: other.id,
        messageID: message.message.id,
        type: "text",
        text: "needle mismatched",
      })
      expect((yield* Session.use.search({ query: "needle" })).items).toEqual([])
    }),
  )

  it.instance(
    "scopes exact folders, projects, and workspaces without following child parents",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const folder = path.join(test.directory, "nested")
        yield* Effect.promise(() => mkdir(folder))
        const root = yield* create({ title: "needle root" })
        const other = yield* create({ title: "needle child", parentID: root.id }).pipe(provideInstance(folder))
        const foreign = yield* create({ title: "needle foreign" }).pipe(
          provideInstance(yield* tmpdirScoped({ git: true })),
        )
        // Even a persisted row claiming the same directory must retain its project boundary.
        yield* Effect.sync(() =>
          Database.use((db) =>
            db.update(SessionTable).set({ directory: test.directory }).where(eq(SessionTable.id, foreign.id)).run(),
          ),
        )
        const workspaceID = WorkspaceID.make("wrk_search")
        const workspace = yield* create({ title: "needle workspace", workspaceID })
        expect((yield* Session.use.search({ query: "needle" })).items.map((x) => x.session.id)).toEqual([root.id])
        expect(
          (yield* Session.use
            .search({ query: "needle" })
            .pipe(Effect.provideService(WorkspaceRef, workspaceID))).items.map((x) => x.session.id),
        ).toEqual([workspace.id])
        expect(
          (yield* Session.use.search({ query: "needle" }).pipe(provideInstance(folder))).items.map((x) => x.session.id),
        ).toEqual([other.id])
      }),
    { git: true },
  )
})
