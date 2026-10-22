import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionID } from "./schema"
import { SessionTable } from "./session.sql"

export type TimingData = {
  version: 1
  buildVersion?: string
  requestID?: string
  callID?: string
  approvalID?: string
  commandID?: string
  elapsedMs?: number
  durationMs?: number
  tool?: string
  kind?: string
  status?: string
  providerID?: string
  modelID?: string
  resolvedModelID?: string
  purpose?: string
  variant?: string
  requestedTier?: string
  returnedTier?: string
  runtime?: string
  reason?: string
  exitCode?: number
  attemptScope?: string
  anchor?: string
}

// No transcript/message foreign keys: deleting a child keeps its execution
// history, while deleting the root removes the entire task's local timings.
export const TimingTable = sqliteTable(
  "session_timing",
  {
    id: text().primaryKey(),
    execution_id: text().notNull(),
    session_id: text().notNull(),
    step_id: text().notNull(),
    root_session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    time_created: integer().notNull(),
    phase: text().notNull(),
    data: text({ mode: "json" }).$type<TimingData>().notNull(),
  },
  (table) => [
    index("session_timing_execution_id_idx").on(table.execution_id),
    index("session_timing_session_id_time_created_idx").on(table.session_id, table.time_created),
    index("session_timing_root_session_id_idx").on(table.root_session_id),
    index("session_timing_time_created_id_idx").on(table.time_created, table.id),
  ],
)
