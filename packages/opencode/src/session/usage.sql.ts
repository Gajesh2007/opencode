import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionID } from "./schema"
import { SessionTable } from "./session.sql"
import type { SessionUsage } from "./usage"

// Execution records are deliberately separate from forkable transcript parts.
export const UsageTable = sqliteTable(
  "session_usage",
  {
    id: text().primaryKey(),
    session_id: text().$type<SessionID>().notNull(),
    root_session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ancestors: text({ mode: "json" }).$type<SessionID[]>().notNull(),
    time_created: integer().notNull(),
    data: text({ mode: "json" }).$type<SessionUsage.Record>().notNull(),
  },
  (table) => [
    index("session_usage_session_idx").on(table.session_id),
    index("session_usage_root_idx").on(table.root_session_id),
  ],
)
