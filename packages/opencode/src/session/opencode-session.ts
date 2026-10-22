import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { Cause, Effect, Option, Schema } from "effect"
import { SessionMessage } from "@opencode-ai/core/session-message"
import { Database } from "@/storage/db"
import { MessageV2 } from "./message-v2"
import { SessionMessageTable, SessionTable } from "./session.sql"
import { match, writeTranscript, type Entry, type Resolution } from "./session-transcript"

export const resolve = Effect.fn("OpenCodeSession.resolve")(
  function* (query: string, options?: { cache?: string }) {
    if (!query.trim()) {
      return {
        type: "missing",
        message: "Provide an OpenCode session title, topic, or full session ID after @opencode:.",
        candidates: [],
      } satisfies Resolution
    }

    const candidates = yield* Effect.sync(() =>
      Database.use((db) =>
        db
          .select({
            id: SessionTable.id,
            title: SessionTable.title,
            updatedAt: SessionTable.time_updated,
            cwd: SessionTable.directory,
          })
          .from(SessionTable)
          .orderBy(desc(SessionTable.time_updated), asc(SessionTable.id))
          .all()
          .map((row) => ({ ...row, updatedAt: new Date(row.updatedAt).toISOString() })),
      ),
    )
    const matched = match(query, candidates)
    if (matched.type === "ambiguous") return matched

    const selected =
      matched.type === "found"
        ? [matched.candidate]
        : yield* Effect.sync(() => {
            const ids = new Set(contentMatches(query))
            return candidates.filter((candidate) => ids.has(candidate.id))
          })
    if (!selected.length) {
      return {
        type: "missing",
        message: `No local OpenCode session matches ${JSON.stringify(query.trim())}. Use a full session ID or a more specific title or topic.`,
        candidates: [],
      } satisfies Resolution
    }
    if (selected.length > 1) {
      return {
        type: "ambiguous",
        message:
          "More than one OpenCode session contains this text. Use @opencode:<session-id> or a more specific title.",
        candidates: selected.slice(0, 20).map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
      } satisfies Resolution
    }

    const info = { ...selected[0], source: "opencode" as const }
    const legacy = yield* Effect.sync(() => Array.from(MessageV2.stream(info.id)).reverse())
    const messages: Entry[] = legacy.length
      ? legacy.flatMap((message) => {
          if (message.info.role !== "user" && message.info.role !== "assistant") return []
          if (message.info.role === "assistant" && message.info.summary) return []
          const text = message.parts
            .filter(
              (part): part is MessageV2.TextPart =>
                part.type === "text" &&
                !part.synthetic &&
                !part.ignored &&
                part.sessionID === info.id &&
                part.messageID === message.info.id,
            )
            .map((part) => part.text)
            .filter((text) => text.trim())
            .join("\n\n")
          return text ? [{ role: message.info.role, text }] : []
        })
      : yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.session_id, info.id),
                  inArray(SessionMessageTable.type, ["user", "assistant"]),
                ),
              )
              .orderBy(asc(SessionMessageTable.time_created), asc(SessionMessageTable.id))
              .all()
              .flatMap((row): Entry[] => {
                const decoded = Schema.decodeUnknownOption(SessionMessage.Message)({
                  ...row.data,
                  id: row.id,
                  type: row.type,
                })
                if (Option.isNone(decoded)) return []
                const message = decoded.value
                if (message.type !== "user" && message.type !== "assistant") return []
                const text =
                  message.type === "user"
                    ? message.text
                    : message.content
                        .filter((part) => part.type === "text")
                        .map((part) => part.text)
                        .join("\n\n")
                return text.trim() ? [{ role: message.type, text }] : []
              }),
          ),
        )
    if (!messages.length) {
      return {
        type: "missing",
        message: `OpenCode session ${JSON.stringify(info.title)} (${info.id}) has no visible user or assistant text. Choose another session.`,
        candidates: [],
      } satisfies Resolution
    }
    return {
      ...info,
      type: "found",
      ...(yield* Effect.promise(() => writeTranscript(info, messages, options?.cache))),
    } satisfies Resolution
  },
  Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.interrupt
      : Effect.succeed({
          type: "error",
          message: "Unable to read or cache this local OpenCode session. Check database/cache access and try again.",
          candidates: [],
        } satisfies Resolution),
  ),
)

function contentMatches(query: string) {
  const pattern = `%${query.trim().replace(/[\\%_]/g, "\\$&")}%`
  // Keep bodies inside SQLite, and use the same visibility and legacy-first rules as the transcript reader.
  return Database.use((db) =>
    db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(
        sql`(
        exists (
          select 1 from message inner join part on part.message_id = message.id
          where message.session_id = session.id and part.session_id = session.id
            and json_extract(message.data, '$.role') in ('user', 'assistant')
            and (json_extract(message.data, '$.role') != 'assistant' or coalesce(json_extract(message.data, '$.summary'), 0) = 0)
            and json_extract(part.data, '$.type') = 'text'
            and coalesce(json_extract(part.data, '$.synthetic'), 0) = 0
            and coalesce(json_extract(part.data, '$.ignored'), 0) = 0
            and json_extract(part.data, '$.text') like ${pattern} escape ${"\\"}
        ) or (
          not exists (select 1 from message where message.session_id = session.id)
          and (
            exists (
              select 1 from session_message
              where session_message.session_id = session.id and session_message.type = 'user'
                and json_extract(session_message.data, '$.text') like ${pattern} escape ${"\\"}
            ) or exists (
              select 1 from session_message, json_each(session_message.data, '$.content') as content
              where session_message.session_id = session.id and session_message.type = 'assistant'
                and content.type = 'object' and json_extract(content.value, '$.type') = 'text'
                and json_extract(content.value, '$.text') like ${pattern} escape ${"\\"}
            )
          )
        )
      )`,
      )
      .orderBy(desc(SessionTable.time_updated), asc(SessionTable.id))
      .limit(21)
      .all()
      .map((row) => row.id),
  )
}

export * as OpenCodeSession from "./opencode-session"
