import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm"
import { Schema } from "effect"
import { optionalOmitUndefined } from "@opencode-ai/core/schema"
import type { ProjectID } from "@/project/schema"
import type { WorkspaceID } from "@/control-plane/schema"
import { Database } from "@/storage/db"
import { MessageID, SessionID } from "./schema"
import { SessionTable } from "./session.sql"
import { Session } from "./session"

export const Input = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(1000)),
  mode: Schema.optional(Schema.Literals(["all", "title"])),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  cursor: Schema.optional(SessionID),
})
export type Input = typeof Input.Type

export const Match = Schema.Struct({
  type: Schema.Literals(["title", "summary", "message"]),
  text: Schema.String,
  messageID: optionalOmitUndefined(MessageID),
})

export const Result = Schema.Struct({
  items: Schema.Array(Schema.Struct({ session: Schema.suspend(() => Session.Info), match: Match })),
  next: optionalOmitUndefined(SessionID),
}).annotate({ identifier: "SessionSearchResult" })
export type Result = typeof Result.Type

export function search(input: Input & { projectID: ProjectID; directory: string; workspaceID?: WorkspaceID }): Result {
  const query = input.query.trim()
  if (!query) return { items: [] }
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`
  const limit = Math.max(1, Math.min(100, input.limit ?? 30))
  const title = sql`${SessionTable.title} like ${pattern} escape ${"\\"}`
  // Only user/assistant text is searchable: never tool input/output, reasoning, or attachments.
  // Correlated subqueries use the session indexes and keep message bodies inside SQLite.
  // Keep raw qualified names here: Drizzle strips column qualifiers in single-table select expressions.
  const match = sql<string | null>`(
    select json_patch(
      json_object('type', source, 'text', substr(body, max(1, instr(lower(body), lower(${query})) - 60), 220)),
      case when id is null then '{}' else json_object('messageID', id) end
    )
    from (
      select 'summary' as source, json_extract(message.data, '$.summary.title') as body, message.id as id
      from message
      where message.session_id = session.id
        and json_extract(message.data, '$.role') in ('user', 'assistant')
        and json_extract(message.data, '$.summary.title') like ${pattern} escape ${"\\"}
      union all
      select 'message' as source, json_extract(part.data, '$.text') as body, message.id as id
      from part inner join message on message.id = part.message_id
      where part.session_id = session.id and message.session_id = session.id
        and json_extract(message.data, '$.role') in ('user', 'assistant')
        and json_extract(part.data, '$.type') = 'text'
        and json_extract(part.data, '$.text') like ${pattern} escape ${"\\"}
      union all
      select 'message' as source, json_extract(session_message.data, '$.text') as body, null as id
      from session_message
      where session_message.session_id = session.id and session_message.type = 'user'
        and json_extract(session_message.data, '$.text') like ${pattern} escape ${"\\"}
      union all
      select 'message' as source, json_extract(content.value, '$.text') as body, null as id
      from session_message, json_each(session_message.data, '$.content') as content
      where session_message.session_id = session.id and session_message.type = 'assistant'
        and content.type = 'object' and json_extract(content.value, '$.type') = 'text'
        and json_extract(content.value, '$.text') like ${pattern} escape ${"\\"}
    ) limit 1
  )`
  const rows = Database.use((db) =>
    db
      .select({
        session: SessionTable,
        match:
          input.mode === "title" ? sql<null>`null` : sql<string | null>`case when ${title} then null else ${match} end`,
      })
      .from(SessionTable)
      .where(
        and(
          eq(SessionTable.project_id, input.projectID),
          eq(SessionTable.directory, input.directory),
          input.workspaceID ? eq(SessionTable.workspace_id, input.workspaceID) : isNull(SessionTable.workspace_id),
          input.mode === "title" ? title : or(title, sql`${match} is not null`),
          input.cursor ? gt(SessionTable.id, input.cursor) : undefined,
        ),
      )
      // Session IDs are immutable and generated in reverse creation order. Updates,
      // archives, and deletions cannot move remaining matches across this cursor.
      .orderBy(asc(SessionTable.id))
      .limit(limit + 1)
      .all(),
  )
  return {
    items: rows.slice(0, limit).map((row) => ({
      session: Session.fromRow(row.session),
      match: row.match
        ? (JSON.parse(row.match) as typeof Match.Type)
        : { type: "title", text: row.session.title.slice(0, 220) },
    })),
    ...(rows.length > limit ? { next: rows[limit - 1].session.id } : {}),
  }
}

export * as SessionSearch from "./search"
