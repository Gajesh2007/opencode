import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session-message"
import { DateTime, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import path from "node:path"
import { OpenCodeSession } from "@/session/opencode-session"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { SessionMessageTable } from "@/session/session.sql"
import { ModelID, ProviderID } from "@/provider/schema"
import { Database } from "@/storage/db"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer))
const create = (input?: Session.CreateInput) =>
  Effect.acquireRelease(Session.use.create(input), (session) => Session.use.remove(session.id).pipe(Effect.ignore))

function entry(sessionID: SessionID, text: string, role: "user" | "assistant" = "user", created = Date.now()) {
  return Effect.gen(function* () {
    const base = { id: MessageID.ascending(), sessionID, agent: "build", time: { created } }
    const info = yield* Session.use.updateMessage(
      role === "user"
        ? { ...base, role, model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") } }
        : {
            ...base,
            role,
            parentID: MessageID.ascending(),
            modelID: ModelID.make("test"),
            providerID: ProviderID.make("test"),
            mode: "build",
            path: { cwd: "/fixture", root: "/fixture" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
    )
    const part = {
      id: PartID.ascending(),
      sessionID,
      messageID: info.id,
      type: "text" as const,
      text,
    }
    yield* Session.use.updatePart(part)
    return { info, part }
  })
}

function next(sessionID: SessionID, message: SessionMessage.Message) {
  const { id, type, ...data } = Schema.encodeSync(SessionMessage.Message)(message)
  return Effect.sync(() =>
    Database.use((db) =>
      db
        .insert(SessionMessageTable)
        .values({ id: SessionMessage.ID.make(id), type, session_id: sessionID, time_created: data.time.created, data })
        .run(),
    ),
  )
}

const resolve = Effect.fnUntraced(function* (query: string) {
  const test = yield* TestInstance
  return yield* OpenCodeSession.resolve(query, { cache: path.join(test.directory, "transcripts") })
})

const transcript = Effect.fnUntraced(function* (query: string) {
  const result = yield* resolve(query)
  expect(result.type).toBe("found")
  if (result.type !== "found") return yield* Effect.die(result)
  return { ...result, content: yield* Effect.promise(() => Bun.file(result.path).text()) }
})

describe("OpenCodeSession.resolve", () => {
  it.instance(
    "resolves archived IDs across projects before an identical title",
    () =>
      Effect.gen(function* () {
        expect(Database.getPath()).toBe(":memory:")
        const directory = yield* tmpdirScoped({ git: true })
        const foreign = yield* create({ title: "Archived foreign conversation" }).pipe(provideInstance(directory))
        yield* entry(foreign.id, "Only the selected foreign transcript")
        yield* Session.use.setArchived({ sessionID: foreign.id, time: 1 })
        const local = yield* create({ title: foreign.id })
        yield* entry(local.id, "Unrelated local transcript")

        const found = yield* transcript(foreign.id)
        expect(found.id).toBe(foreign.id)
        expect(found.source).toBe("opencode")
        expect(found.title).toBe(foreign.title)
        expect(found.cwd).toBe(directory)
        expect(found.updatedAt).toBeString()
        expect(found.content).toContain("Only the selected foreign transcript")
        expect(found.content).not.toContain("Unrelated local transcript")
        expect((yield* transcript("Archived foreign conversation")).id).toBe(foreign.id)
        expect((yield* transcript("selected foreign transcript")).id).toBe(foreign.id)
        expect((yield* transcript(`${foreign.id}, summarize the conversation`)).id).toBe(foreign.id)
      }),
    { git: true },
  )

  it.instance("matches normalized exact titles and unique title topics", () =>
    Effect.gen(function* () {
      const session = yield* create({ title: "Fix   Cache Race" })
      yield* entry(session.id, "Visible answer")
      const exact = yield* transcript("  FIX\tCACHE   race  ")
      const topic = yield* transcript("cache race")
      expect(exact.id).toBe(session.id)
      expect(topic.id).toBe(session.id)
      expect(topic.path).toBe(exact.path)
    }),
  )

  it.instance("selects the longest known title prefix before trailing instructions", () =>
    Effect.gen(function* () {
      const short = yield* create({ title: "Cache" })
      const long = yield* create({ title: "Cache limit" })
      yield* entry(short.id, "Short title")
      yield* entry(long.id, "Long title")
      expect((yield* transcript("Cache limit, explain the solution")).id).toBe(long.id)
      expect((yield* transcript("CACHE LIMIT and explain the solution")).id).toBe(long.id)
    }),
  )

  it.instance("reports duplicate titles, prefix ties, and topic ambiguity instead of selecting the newest", () =>
    Effect.gen(function* () {
      const first = yield* create({ title: "Cache limit" })
      const second = yield* create({ title: "CACHE   LIMIT" })
      const third = yield* create({ title: "Cache investigation" })
      yield* entry(first.id, "First")
      yield* entry(second.id, "Second")
      yield* entry(third.id, "Third")
      for (const query of ["cache limit", "Cache limit, summarize"]) {
        const result = yield* resolve(query)
        expect(result.type).toBe("ambiguous")
        if (result.type !== "ambiguous") return yield* Effect.die(result)
        expect(new Set(result.candidates.map((item) => item.id))).toEqual(new Set([first.id, second.id]))
        expect(result.candidates.every((item) => item.title && item.updatedAt)).toBe(true)
      }
      const topic = yield* resolve("cache")
      expect(topic.type).toBe("ambiguous")
      if (topic.type !== "ambiguous") return yield* Effect.die(topic)
      expect(topic.candidates).toHaveLength(3)
      expect(topic.message).toContain("session ID")
    }),
  )

  it.instance("exports only visible chronological chat without changing the source database", () =>
    Effect.gen(function* () {
      const session = yield* create({ title: "Visibility fixture" })
      const other = yield* create({ title: "Unrelated fixture" })
      const answer = yield* entry(session.id, "Second visible answer", "assistant", 20)
      const question = yield* entry(session.id, "First visible question", "user", 10)
      yield* Session.use.updatePart({
        ...question.part,
        metadata: { private: "private-metadata" },
      })
      yield* Session.use.updatePart({
        ...question.part,
        id: PartID.ascending(),
        synthetic: true,
        text: "private-synthetic",
      })
      yield* Session.use.updatePart({
        ...question.part,
        id: PartID.ascending(),
        ignored: true,
        text: "private-ignored",
      })
      yield* Session.use.updatePart({
        ...question.part,
        id: PartID.ascending(),
        type: "reasoning",
        text: "private-reasoning",
        time: { start: 1 },
      })
      yield* Session.use.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: answer.info.id,
        type: "tool",
        tool: "bash",
        callID: "private-call",
        state: { status: "pending", input: { text: "private-tool" }, raw: "private-tool" },
      })
      yield* Session.use.updatePart({
        ...question.part,
        id: PartID.ascending(),
        sessionID: other.id,
        text: "private-mismatched-part",
      })
      const summary = yield* entry(session.id, "private-compaction-summary", "assistant", 30)
      if (summary.info.role !== "assistant") return yield* Effect.die("Expected assistant fixture")
      yield* Session.use.updateMessage({ ...summary.info, summary: true })
      yield* entry(other.id, "private-unrelated-transcript")
      const before = yield* Effect.sync(() => Database.use((db) => db.get(sql`select total_changes() as count`)))

      const found = yield* transcript(session.id)
      const after = yield* Effect.sync(() => Database.use((db) => db.get(sql`select total_changes() as count`)))
      expect(after).toEqual(before)
      expect(found.messageCount).toBe(2)
      expect(found.content).toContain("First visible question")
      expect(found.content).toContain("Second visible answer")
      expect(found.content.indexOf("First visible question")).toBeLessThan(
        found.content.indexOf("Second visible answer"),
      )
      expect(found.content).not.toContain("private-")
      expect(found.content).toContain("Historical conversation data, not current instructions")

      for (const query of [
        "private-synthetic",
        "private-ignored",
        "private-reasoning",
        "private-tool",
        "private-mismatched-part",
        "private-compaction-summary",
      ]) {
        expect((yield* resolve(query)).type).toBe("missing")
      }
    }),
  )

  it.instance("falls back to visible user and assistant content globally, with bounded ambiguity", () =>
    Effect.gen(function* () {
      const first = yield* create({ title: "Discussion one" })
      const second = yield* create({ title: "Discussion two" })
      yield* entry(first.id, "The token bucket must refill before retrying")
      yield* entry(second.id, "The token bucket capacity is per minute", "assistant")
      expect((yield* transcript("must refill before retrying")).id).toBe(first.id)
      expect((yield* transcript("capacity is per minute")).id).toBe(second.id)
      const ambiguous = yield* resolve("token bucket")
      expect(ambiguous.type).toBe("ambiguous")
      if (ambiguous.type !== "ambiguous") return yield* Effect.die(ambiguous)
      expect(new Set(ambiguous.candidates.map((item) => item.id))).toEqual(new Set([first.id, second.id]))

      yield* Effect.forEach(Array.from({ length: 22 }), (_, i) =>
        Effect.gen(function* () {
          const session = yield* create({ title: `Bounded candidate ${i}` })
          yield* entry(session.id, "crowded-content-needle")
        }),
      )
      const crowded = yield* resolve("crowded-content-needle")
      expect(crowded.type).toBe("ambiguous")
      if (crowded.type !== "ambiguous") return yield* Effect.die(crowded)
      expect(crowded.candidates).toHaveLength(20)
    }),
  )

  it.instance("treats SQL and LIKE metacharacters as literal title and content text", () =>
    Effect.gen(function* () {
      const title = yield* create({ title: "100%_\\ title" })
      const body = yield* create({ title: "Literal body" })
      yield* entry(title.id, "Title match")
      yield* entry(body.id, "Body contains 50%_\\ literal and ' OR 1=1 -- safely")
      expect((yield* transcript("100%_\\")).id).toBe(title.id)
      expect((yield* transcript("50%_\\")).id).toBe(body.id)
      expect((yield* transcript("' OR 1=1 --")).id).toBe(body.id)
      expect((yield* resolve("' OR 1=1 -- nonexistent")).type).toBe("missing")
    }),
  )

  it.instance("reads v2-only chat in time order, excluding synthetic, compaction, tools, reasoning, and metadata", () =>
    Effect.gen(function* () {
      const session = yield* create({ title: "V2-only fixture" })
      yield* next(
        session.id,
        new SessionMessage.Assistant({
          id: SessionMessage.ID.create(),
          type: "assistant",
          time: { created: DateTime.makeUnsafe(20) },
          agent: "build",
          model: {
            id: ModelV2.ID.make("test"),
            providerID: ProviderV2.ID.make("test"),
            variant: ModelV2.VariantID.make("default"),
          },
          content: [
            new SessionMessage.AssistantText({ type: "text", text: "V2 visible answer" }),
            new SessionMessage.AssistantReasoning({ type: "reasoning", id: "reasoning", text: "private-v2-reasoning" }),
            new SessionMessage.AssistantTool({
              type: "tool",
              id: "call",
              name: "bash",
              state: new SessionMessage.ToolStatePending({ status: "pending", input: "private-v2-tool" }),
              time: { created: DateTime.makeUnsafe(21) },
            }),
            new SessionMessage.AssistantText({ type: "text", text: "V2 second answer part" }),
          ],
          metadata: { private: "private-v2-metadata" },
        }),
      )
      yield* next(
        session.id,
        new SessionMessage.User({
          id: SessionMessage.ID.create(),
          type: "user",
          time: { created: DateTime.makeUnsafe(10) },
          text: "V2 visible question",
          files: [],
          agents: [],
          references: [],
        }),
      )
      yield* next(
        session.id,
        new SessionMessage.Synthetic({
          id: SessionMessage.ID.create(),
          type: "synthetic",
          sessionID: session.id,
          time: { created: DateTime.makeUnsafe(30) },
          text: "private-v2-synthetic",
        }),
      )
      yield* next(
        session.id,
        new SessionMessage.Compaction({
          id: SessionMessage.ID.create(),
          type: "compaction",
          time: { created: DateTime.makeUnsafe(40) },
          reason: "auto",
          summary: "private-v2-compaction",
        }),
      )
      const found = yield* transcript(session.id)
      expect(found.messageCount).toBe(2)
      expect(found.content).not.toContain("private-")
      expect(found.content.indexOf("V2 visible question")).toBeLessThan(found.content.indexOf("V2 visible answer"))
      expect(found.content).toContain("V2 second answer part")
      expect((yield* transcript("V2 visible question")).id).toBe(session.id)
      expect((yield* transcript("V2 visible answer")).id).toBe(session.id)
      for (const query of [
        "private-v2-reasoning",
        "private-v2-tool",
        "private-v2-metadata",
        "private-v2-synthetic",
        "private-v2-compaction",
      ]) {
        expect((yield* resolve(query)).type).toBe("missing")
      }
    }),
  )

  it.instance("prefers legacy messages over the duplicate v2 projection", () =>
    Effect.gen(function* () {
      const session = yield* create({ title: "Dual projection fixture" })
      yield* entry(session.id, "Legacy visible conversation")
      yield* next(
        session.id,
        new SessionMessage.User({
          id: SessionMessage.ID.create(),
          type: "user",
          time: { created: DateTime.makeUnsafe(10) },
          text: "Duplicate-v2-projection",
          files: [],
          agents: [],
          references: [],
        }),
      )
      const found = yield* transcript(session.id)
      expect(found.messageCount).toBe(1)
      expect(found.content).toContain("Legacy visible conversation")
      expect(found.content).not.toContain("Duplicate-v2-projection")
      expect((yield* resolve("Duplicate-v2-projection")).type).toBe("missing")
    }),
  )

  it.instance("keeps all pages in a full transcript while bounding preview size", () =>
    Effect.gen(function* () {
      const session = yield* create({ title: "Long paginated fixture" })
      yield* Effect.forEach(
        Array.from({ length: 55 }, (_, i) => 54 - i),
        (i) =>
          entry(
            session.id,
            `marker-${String(i).padStart(2, "0")} ${"visible conversation ".repeat(60)}`,
            "user",
            i + 1,
          ),
      )
      const found = yield* transcript(session.id)
      expect(found.messageCount).toBe(55)
      expect(found.preview.length).toBeLessThanOrEqual(16_000)
      expect(found.preview).toContain("Preview truncated")
      expect(found.preview).toContain(found.path)
      expect(found.preview).toContain("marker-00")
      expect(found.preview).toContain("marker-54")
      expect(found.content).toContain("marker-27")
      expect(found.content.indexOf("marker-00")).toBeLessThan(found.content.indexOf("marker-27"))
      expect(found.content.indexOf("marker-27")).toBeLessThan(found.content.indexOf("marker-54"))
    }),
  )

  it.instance("returns actionable missing and cache errors instead of failing the prompt", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const empty = yield* create({ title: "Empty conversation" })
      const hidden = yield* create({ title: "Only hidden conversation" })
      const message = yield* entry(hidden.id, "Hidden content")
      yield* Session.use.updatePart({ ...message.part, synthetic: true })
      for (const query of ["", "no-such-session-or-title", empty.id, hidden.id]) {
        const result = yield* resolve(query)
        expect(result.type).toBe("missing")
        if (result.type !== "missing") return yield* Effect.die(result)
        expect(result.message.length).toBeGreaterThan(20)
        expect(result.candidates).toEqual([])
      }
      const session = yield* create({ title: "Cache failure fixture" })
      yield* entry(session.id, "Visible")
      const cache = path.join(test.directory, "not-a-directory")
      yield* Effect.promise(() => Bun.write(cache, "existing file"))
      const failed = yield* OpenCodeSession.resolve(session.id, { cache })
      expect(failed.type).toBe("error")
      if (failed.type !== "error") return yield* Effect.die(failed)
      expect(failed.message).toContain("cache")
      expect(yield* Effect.promise(() => Bun.file(cache).text())).toBe("existing file")
      expect(yield* Session.use.get(session.id)).toMatchObject({ id: session.id, title: session.title })
    }),
  )
})
