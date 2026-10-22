import { eq, inArray, lt, sql } from "drizzle-orm"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Database } from "@/storage/db"
import { SessionID } from "./schema"
import { SessionTable } from "./session.sql"
import type { Record } from "./timing"
import { TimingTable, type TimingData } from "./timing.sql"

const MAX_BUFFERED = 128
const MAX_ROWS = 100_000
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const PRUNE_MS = 5 * 60 * 1000
const FLUSH_MS = 50

type Client = ReturnType<typeof Database.Client>

/** Test seams: database(false) must return only the currently open client.
 * Retention is swept on the first batch and every five active minutes. The
 * insertion window caps rows, not SQLite page/WAL allocation or other tables.
 */
export function create(
  options: {
    database?: (open: boolean) => Client | undefined
    now?: () => number
  } = {},
) {
  const database =
    options.database ?? ((open: boolean) => (open || Database.Client.loaded() ? Database.Client() : undefined))
  const now = options.now ?? Date.now
  const pending: (typeof TimingTable.$inferInsert)[] = []
  let client: Client | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let pruneAt = 0

  function flush(): void {
    if (timer) clearTimeout(timer)
    timer = undefined
    const batch = pending.splice(0)
    if (!batch.length) return
    try {
      // Never reopen a closed database, or replay an old buffer into a new one.
      if (!client || database(false) !== client) {
        client = undefined
        pruneAt = 0
        return
      }
      const time = now()
      withoutBusyWait(client, (client) =>
        client.transaction((db) => {
          const roots = new Set(
            db
              .select({ id: SessionTable.id })
              .from(SessionTable)
              .where(
                inArray(
                  SessionTable.id,
                  batch.map((row) => row.root_session_id),
                ),
              )
              .all()
              .map((row) => row.id),
          )
          const valid = batch.filter((row) => roots.has(row.root_session_id))
          if (valid.length) db.insert(TimingTable).values(valid).run()
          // A rowid window is an indexed upper bound even with concurrent writers;
          // gaps from root deletion/expiry can leave fewer than MAX_ROWS records.
          db.run(sql`DELETE FROM ${TimingTable} WHERE rowid <= (SELECT max(rowid) FROM ${TimingTable}) - ${MAX_ROWS}`)
          if (time >= pruneAt) {
            db.delete(TimingTable)
              .where(lt(TimingTable.time_created, time - RETENTION_MS))
              .run()
          }
        }),
      )
      if (time >= pruneAt) pruneAt = time + PRUNE_MS
    } catch {
      // Telemetry must not fail a request. Failed batches are intentionally lost;
      // retrying indefinitely would retain data or stall shutdown under DB faults.
      pruneAt = 0
    }
  }

  function write(record: Record): void {
    try {
      const executionID = label(record.executionID)
      const sessionID = label(record.sessionID)
      const stepID = label(record.stepID)
      const phase = choice(record.phase, [
        "execution_start",
        "preparation",
        "request_start",
        "request_prepared",
        "dispatch",
        "first_useful",
        "first_text",
        "first_reasoning",
        "tool_input_start",
        "tool_ready",
        "tool_start",
        "tool",
        "approval_start",
        "approval",
        "command_start",
        "command_first_output",
        "command",
        "request",
        "overall",
      ])
      if (!executionID || !sessionID || !stepID || !phase) return
      const data: TimingData = {
        version: 1,
        buildVersion: label(InstallationVersion, 64) ?? "unknown",
        requestID: label(record.requestID),
        callID: label(record.callID),
        approvalID: label(record.approvalID),
        commandID: label(record.commandID),
        elapsedMs: duration(record.elapsedMs),
        durationMs: duration(record.durationMs),
        tool: label(record.tool, 64),
        kind: choice(record.kind, ["text", "tool"]),
        status: choice(record.status, [
          "completed",
          "compact",
          "incomplete",
          "truncated",
          "error",
          "interrupted",
          "retry",
          "cancelled",
          "canceled",
          "aborted",
          "failed",
          "success",
          "running",
          "pending",
          "unknown",
          "timeout",
          "denied",
        ]),
        providerID: label(record.providerID, 64),
        modelID: label(record.modelID),
        resolvedModelID: label(record.resolvedModelID),
        purpose: choice(record.purpose, [
          "assistant",
          "reviewer",
          "steering",
          "auxiliary",
          "shell",
          "subtask",
          "compaction",
        ]),
        variant: label(record.variant, 64),
        requestedTier: label(record.requestedTier, 32),
        returnedTier: label(record.returnedTier, 32),
        runtime: choice(record.runtime, ["native", "sdk", "shell", "ai-sdk"]),
        reason: choice(record.reason, [
          "stop",
          "length",
          "content-filter",
          "tool-calls",
          "error",
          "other",
          "unknown",
          "completed",
          "interrupted",
          "cancelled",
          "canceled",
          "aborted",
          "failed",
          "timeout",
          "max-steps",
          "abort",
          "exit",
          "signal",
          "success",
        ]),
        exitCode:
          typeof record.exitCode === "number" &&
          Number.isInteger(record.exitCode) &&
          record.exitCode >= -2_147_483_648 &&
          record.exitCode <= 2_147_483_647
            ? record.exitCode
            : undefined,
        attemptScope: choice(record.attemptScope, ["logical", "request", "wire"]),
        anchor: choice(record.anchor, ["request_start", "dispatch"]),
      }
      const db = database(true)
      if (!db) return
      if (client !== db) {
        if (timer) clearTimeout(timer)
        timer = undefined
        pending.length = 0
        pruneAt = 0
        client = db
      }
      const root = withoutBusyWait(db, (db) => rootSession(db, SessionID.make(sessionID)))
      if (!root) return
      pending.push({
        id: crypto.randomUUID(),
        execution_id: executionID,
        session_id: sessionID,
        step_id: stepID,
        root_session_id: root,
        time_created: now(),
        phase,
        data,
      })
      // Completed executions are committed immediately. An abrupt crash can
      // lose only the pending (<128 records, normally <50ms) unfinished batch.
      if (pending.length >= MAX_BUFFERED || phase === "overall") return flush()
      timer ??= setTimeout(flush, FLUSH_MS).unref()
    } catch {
      // Includes malformed records/getters, missing sessions and storage faults.
    }
  }

  return { write, flush }
}

function label(value: unknown, max = 256) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/.test(value)
    ? value
    : undefined
}

function duration(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function choice<T extends string>(value: unknown, values: readonly T[]) {
  return typeof value === "string" ? values.find((item) => item === value) : undefined
}

function withoutBusyWait<T>(db: Client, run: (db: Client) => T): T {
  const timeout = db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`)
  if (!timeout) throw new Error("SQLite busy timeout unavailable")
  // No asynchronous work can observe the temporary timeout. Reads must also
  // be guarded: an exclusive rollback-journal lock blocks ancestor lookup.
  try {
    db.run("PRAGMA busy_timeout = 0")
    return run(db)
  } finally {
    db.run(sql.raw(`PRAGMA busy_timeout = ${timeout.timeout}`))
  }
}

function rootSession(db: Client, sessionID: SessionID) {
  const seen = new Set<SessionID>()
  let id = sessionID
  while (seen.size < 64 && !seen.has(id)) {
    if (!label(id)) return
    seen.add(id)
    const session = db
      .select({ parent: SessionTable.parent_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, id))
      .get()
    if (!session) return
    if (!session.parent) return id
    id = session.parent
  }
}

const store = create()

export function write(record: Record): void {
  store.write(record)
}

export function flush(): void {
  store.flush()
}

process.once("exit", flush)

export * as SessionTimingStore from "./timing-store"
