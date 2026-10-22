import { expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { count, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { init } from "#db"
import { Database } from "@/storage/db"
import { ProjectTable } from "@/project/project.sql"
import { ProjectID } from "@/project/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionTable } from "@/session/session.sql"
import type { SessionTiming } from "@/session/timing"
import { SessionTimingStore } from "@/session/timing-store"
import { TimingTable } from "@/session/timing.sql"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const directory = path.join(import.meta.dirname, "../../migration")
const migrations = readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    name: entry.name,
    timestamp: Number(entry.name.split("_")[0]),
    sql: readFileSync(path.join(directory, entry.name, "migration.sql"), "utf8"),
  }))
  .sort((a, b) => a.timestamp - b.timestamp)

function fixture(filename = ":memory:") {
  const open = () => {
    const db = init(filename)
    db.run("PRAGMA foreign_keys = ON")
    migrate(db, migrations)
    return db
  }
  let client: ReturnType<typeof open> | undefined = open()
  const clock = { now: Date.now() }
  const store = SessionTimingStore.create({ database: () => client, now: () => clock.now })
  const db = () => {
    if (!client) throw new Error("test database is closed")
    return client
  }
  const project = ProjectID.make("timing-project")
  db().insert(ProjectTable).values({ id: project, worktree: "/timing", sandboxes: [] }).run()
  const session = (id = "ses_timing", parent?: SessionID) => {
    const result = SessionID.make(id)
    db()
      .insert(SessionTable)
      .values({
        id: result,
        project_id: project,
        parent_id: parent,
        directory: "/timing",
        slug: "timing",
        title: "not timing metadata",
        version: "test",
      })
      .run()
    return result
  }
  const root = session()
  return {
    db,
    clock,
    store,
    root,
    session,
    rows: () => db().select().from(TimingTable).orderBy(TimingTable.time_created, TimingTable.id).all(),
    close() {
      client?.$client.close()
      client = undefined
    },
    reopen() {
      client?.$client.close()
      client = open()
    },
    [Symbol.dispose]() {
      store.flush()
      client?.$client.close()
    },
  }
}

function record(sessionID: string, input: Partial<SessionTiming.Record> = {}): SessionTiming.Record {
  return {
    executionID: "exe_timing",
    sessionID,
    stepID: "msg_timing",
    requestID: "msg_timing:1",
    phase: "tool",
    elapsedMs: 12.5,
    durationMs: 2.25,
    ...input,
  }
}

test("persists a flat versioned metadata allowlist with distinct row identities", () => {
  using f = fixture()
  const input = record(f.root, {
    callID: "call_1",
    tool: "bash",
    kind: "tool",
    status: "completed",
    providerID: "amazon-bedrock",
    modelID: "us.openai.gpt-6.1-sol",
    resolvedModelID: "us.openai.gpt-6.1-sol-2026-10-01",
    purpose: "assistant",
    variant: "high",
    requestedTier: "priority",
    returnedTier: "default",
    runtime: "native",
    exitCode: 0,
    attemptScope: "request",
    reason: "stop",
  })
  f.store.write(input)
  f.store.write(input)
  input.modelID = "mutated-after-write"
  expect(f.rows()).toHaveLength(0)
  f.store.flush()
  const rows = f.rows()
  expect(rows).toHaveLength(2)
  expect(new Set(rows.map((row) => row.id)).size).toBe(2)
  expect(rows[0]).toMatchObject({
    execution_id: "exe_timing",
    session_id: f.root,
    root_session_id: f.root,
    step_id: "msg_timing",
    phase: "tool",
    time_created: f.clock.now,
    data: {
      version: 1,
      requestID: "msg_timing:1",
      callID: "call_1",
      elapsedMs: 12.5,
      durationMs: 2.25,
      tool: "bash",
      kind: "tool",
      status: "completed",
      providerID: "amazon-bedrock",
      modelID: "us.openai.gpt-6.1-sol",
      resolvedModelID: "us.openai.gpt-6.1-sol-2026-10-01",
      purpose: "assistant",
      variant: "high",
      requestedTier: "priority",
      returnedTier: "default",
      runtime: "native",
      reason: "stop",
      exitCode: 0,
      attemptScope: "request",
    },
  })
  expect(Object.values(rows[0].data).every((value) => typeof value === "string" || typeof value === "number")).toBe(
    true,
  )
  expect(() => f.store.flush()).not.toThrow()
  expect(f.rows()).toHaveLength(2)
})

test("committed and completed records survive a real SQLite close/reopen", async () => {
  await using tmp = await tmpdir()
  using f = fixture(path.join(tmp.path, "timing.sqlite"))
  f.store.write(record(f.root))
  f.store.flush()
  f.store.write(record(f.root, { phase: "overall", status: "completed" }))
  expect(f.rows()).toHaveLength(2)
  const before = f.rows()
  f.reopen()
  expect(f.rows()).toEqual(before)
  f.store.flush()
  expect(f.rows()).toEqual(before)
})

test("preserves compact, incomplete and truncated outcomes with the actual build version", () => {
  using f = fixture()
  for (const status of ["compact", "incomplete", "truncated"]) {
    const input = { ...record(f.root, { phase: "overall", status }), buildVersion: "SECRET_USER_VERSION" }
    f.store.write(input)
  }
  expect(
    f
      .rows()
      .map((row) => row.data.status)
      .sort(),
  ).toEqual(["compact", "incomplete", "truncated"])
  expect(f.rows().every((row) => row.data.buildVersion === InstallationVersion)).toBe(true)
  expect(f.rows().every((row) => typeof row.data.buildVersion === "string" && row.data.buildVersion.length <= 64)).toBe(
    true,
  )
  expect(JSON.stringify(f.rows())).not.toContain("SECRET_USER_VERSION")
})

test("all collector phases persist with optional durations and bounded span correlations", () => {
  using f = fixture()
  const phases: SessionTiming.Record["phase"][] = [
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
  ]
  for (const phase of phases) {
    f.store.write(
      record(f.root, {
        phase,
        durationMs: undefined,
        approvalID: "exe_timing:approval:1",
        commandID: "exe_timing:command:1",
        attemptScope: "logical",
        anchor: "request_start",
      }),
    )
  }
  expect(
    f
      .rows()
      .map((row) => row.phase)
      .sort(),
  ).toEqual([...phases].sort())
  for (const row of f.rows()) {
    expect(row.data).toMatchObject({
      approvalID: "exe_timing:approval:1",
      commandID: "exe_timing:command:1",
      attemptScope: "logical",
      anchor: "request_start",
    })
    expect(row.data).not.toHaveProperty("durationMs")
  }
  f.store.write(record(f.root, { attemptScope: "wire" }))
  f.store.flush()
  expect(f.rows().some((row) => row.data.attemptScope === "wire")).toBe(true)
})

test("process exit best-effort flush preserves a queued unfinished marker", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "timing.sqlite")
  using f = fixture(filename)
  const child = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      `import { write } from ${JSON.stringify(path.join(import.meta.dirname, "../../src/session/timing-store.ts"))}; write(${JSON.stringify(record(f.root, { phase: "execution_start", durationMs: undefined }))}); process.exit(0)`,
    ],
    env: { ...process.env, OPENCODE_DB: filename },
    stderr: "pipe",
    stdout: "pipe",
  })
  expect(child.exitCode).toBe(0)
  f.reopen()
  expect(f.rows()).toHaveLength(1)
  expect(f.rows()[0].phase).toBe("execution_start")
  expect(f.rows()[0].data).not.toHaveProperty("durationMs")
})

test("pending rows are discarded on close/reopen and on replacement database", async () => {
  await using tmp = await tmpdir()
  using f = fixture(path.join(tmp.path, "timing.sqlite"))
  f.store.write(record(f.root))
  f.reopen()
  f.store.flush()
  expect(f.rows()).toHaveLength(0)
  f.store.write(record(f.root, { executionID: "exe_new" }))
  f.store.flush()
  expect(f.rows().map((row) => row.execution_id)).toEqual(["exe_new"])

  using other = fixture()
  let client = f.db()
  const store = SessionTimingStore.create({ database: () => client })
  store.write(record(f.root, { executionID: "exe_old" }))
  client = other.db()
  store.write(record(other.root, { executionID: "exe_other" }))
  store.flush()
  expect(other.rows().map((row) => row.execution_id)).toEqual(["exe_other"])
  expect(f.rows().map((row) => row.execution_id)).toEqual(["exe_new"])
})

test("default writer does not reopen a database during flush after close/reset", () => {
  const db = Database.Client()
  const id = SessionID.descending()
  db.insert(ProjectTable).values({ id: ProjectID.global, worktree: "/", sandboxes: [] }).onConflictDoNothing().run()
  db.insert(SessionTable)
    .values({ id, project_id: ProjectID.global, directory: "/", slug: "timing", title: "timing", version: "test" })
    .run()
  SessionTimingStore.write(record(id))
  Database.close()
  expect(() => SessionTimingStore.flush()).not.toThrow()
  expect(Database.Client.loaded()).toBe(false)
  expect(Database.Client().select().from(TimingTable).all()).toHaveLength(0)
})

test("missing and invalid sessions/identities/phases never throw or create rows", () => {
  using f = fixture()
  f.db().run("PRAGMA busy_timeout = 137")
  const invalid = [
    { sessionID: "ses_missing" },
    { sessionID: "not-a-session" },
    { sessionID: "" },
    { sessionID: "ses_" + "x".repeat(253) },
    { stepID: "" },
    { stepID: "x".repeat(257) },
    { executionID: undefined },
    { executionID: "x".repeat(257) },
    { phase: "SECRET_PROMPT" },
  ]
  for (const input of invalid) {
    expect(() => f.store.write({ ...record(f.root), ...input } as SessionTiming.Record)).not.toThrow()
    expect(f.db().get<{ timeout: number }>(sql`PRAGMA busy_timeout`)?.timeout).toBe(137)
  }
  expect(() => f.store.write(null as unknown as SessionTiming.Record)).not.toThrow()
  const cyclic = f.session("ses_cyclic", SessionID.make("ses_cyclic"))
  f.store.write(record(cyclic))
  f.store.flush()
  expect(f.rows()).toHaveLength(0)
  expect(f.db().get<{ timeout: number }>(sql`PRAGMA busy_timeout`)?.timeout).toBe(137)
})

test("unknown payloads, nested objects, unsafe strings and invalid numbers cannot enter storage", () => {
  using f = fixture()
  const input = {
    ...record(f.root),
    executionID: "exe_private",
    prompt: "SECRET_PROMPT",
    command: "SECRET_COMMAND",
    args: ["SECRET_ARGUMENT"],
    output: { text: "SECRET_OUTPUT" },
    metadata: { token: "SECRET_TOKEN" },
    data: { version: 999, prompt: "SECRET_NESTED" },
    toJSON() {
      throw new Error("raw record must never be serialized")
    },
    tool: "bash SECRET_COMMAND",
    modelID: { toJSON: () => "SECRET_MODEL" },
    resolvedModelID: { secret: "SECRET_RESOLVED_MODEL" },
    purpose: "SECRET_PURPOSE",
    providerID: "provider\nSECRET_PROVIDER",
    requestedTier: "x".repeat(33),
    returnedTier: "tier SECRET_TIER",
    runtime: "SECRET_RUNTIME",
    reason: "SECRET_REASON",
    status: "SECRET_STATUS",
    kind: "SECRET_KIND",
    attemptScope: "SECRET_SCOPE",
    callID: { secret: "SECRET_CALL" },
    durationMs: Infinity,
    elapsedMs: -1,
    exitCode: NaN,
  }
  expect(() => f.store.write(input as unknown as SessionTiming.Record)).not.toThrow()
  f.store.flush()
  expect(f.rows()[0].data).toEqual({ version: 1, buildVersion: InstallationVersion, requestID: "msg_timing:1" })
  expect(JSON.stringify(f.rows())).not.toContain("SECRET")
  const throwing = Object.defineProperty(record(f.root), "modelID", {
    get() {
      throw new Error("SECRET_GETTER")
    },
  })
  expect(() => f.store.write(throwing)).not.toThrow()
  expect(f.rows()).toHaveLength(1)
})

test("finite nonnegative durations and signed integer exit codes are the only accepted numbers", () => {
  using f = fixture()
  for (const value of [NaN, Infinity, -Infinity, -0.5, -1]) {
    f.store.write(record(f.root, { durationMs: value, elapsedMs: value, exitCode: value }))
  }
  f.store.write(record(f.root, { durationMs: 0, elapsedMs: Number.MAX_VALUE, exitCode: -1 }))
  f.store.flush()
  const rows = f.rows()
  expect(rows.filter((row) => row.data.durationMs !== undefined)).toHaveLength(1)
  expect(rows.filter((row) => row.data.elapsedMs !== undefined)).toHaveLength(1)
  expect(rows.find((row) => row.data.durationMs === 0)?.data).toMatchObject({
    elapsedMs: Number.MAX_VALUE,
    exitCode: -1,
  })
  expect(rows.every((row) => row.data.exitCode === undefined || Number.isInteger(row.data.exitCode))).toBe(true)
})

test("identifier and label caps bound every persisted row below 4 KiB of serialized metadata", () => {
  using f = fixture()
  const sessionID = f.session("ses_" + "s".repeat(252))
  f.store.write(
    record(sessionID, {
      executionID: "e".repeat(256),
      stepID: "m".repeat(256),
      requestID: "r".repeat(256),
      callID: "c".repeat(256),
      approvalID: "a".repeat(256),
      commandID: "c".repeat(256),
      modelID: "m".repeat(256),
      resolvedModelID: "r".repeat(256),
      tool: "t".repeat(64),
      providerID: "p".repeat(64),
      variant: "v".repeat(64),
      requestedTier: "t".repeat(32),
      returnedTier: "t".repeat(32),
    }),
  )
  f.store.flush()
  expect(f.rows()).toHaveLength(1)
  expect(Buffer.byteLength(JSON.stringify(f.rows()[0]))).toBeLessThan(4096)
  f.store.write(
    record(f.root, {
      requestID: "r".repeat(257),
      callID: "c".repeat(257),
      modelID: "m".repeat(257),
      resolvedModelID: "r".repeat(257),
      tool: "t".repeat(65),
      providerID: "p".repeat(65),
      variant: "v".repeat(65),
    }),
  )
  f.store.flush()
  expect(f.rows().find((row) => row.session_id === f.root)?.data).toEqual({
    version: 1,
    buildVersion: InstallationVersion,
    elapsedMs: 12.5,
    durationMs: 2.25,
  })
})

test("flushes every 128 records and drops failed batches instead of growing or replaying them", () => {
  using f = fixture()
  f.db().run("PRAGMA busy_timeout = 137")
  for (let i = 0; i < 127; i++) f.store.write(record(f.root))
  expect(f.rows()).toHaveLength(0)
  f.store.write(record(f.root))
  expect(f.rows()).toHaveLength(128)
  f.db().run("PRAGMA query_only = ON")
  expect(() => {
    for (let i = 0; i < 1024; i++) f.store.write(record(f.root))
    f.store.flush()
  }).not.toThrow()
  expect(f.db().get<{ timeout: number }>(sql`PRAGMA busy_timeout`)?.timeout).toBe(137)
  f.db().run("PRAGMA query_only = OFF")
  f.store.flush()
  expect(f.rows()).toHaveLength(128)
  f.store.write(record(f.root))
  f.store.flush()
  expect(f.rows()).toHaveLength(129)
  f.close()
  expect(() => f.store.write(record(f.root))).not.toThrow()
  expect(() => f.store.flush()).not.toThrow()
  const failed = SessionTimingStore.create({
    database() {
      throw new Error("database unavailable")
    },
  })
  expect(() => failed.write(record(f.root))).not.toThrow()
  expect(() => failed.flush()).not.toThrow()
})

for (const mode of ["WAL", "DELETE"] as const) {
  test(`drops a contended ${mode} batch promptly and restores the application's busy timeout`, async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "timing.sqlite")
    using f = fixture(filename)
    f.db().run(sql.raw(`PRAGMA journal_mode = ${mode}`))
    f.db().run("PRAGMA busy_timeout = 5000")
    f.store.write(record(f.root))
    const blocker = init(filename)
    blocker.run("BEGIN EXCLUSIVE")
    try {
      const start = performance.now()
      expect(() => f.store.flush()).not.toThrow()
      expect(performance.now() - start).toBeLessThan(250)
      expect(f.db().get<{ timeout: number }>(sql`PRAGMA busy_timeout`)?.timeout).toBe(5000)
      if (mode === "WAL") {
        const start = performance.now()
        for (let i = 0; i < 256; i++) f.store.write(record(f.root))
        expect(performance.now() - start).toBeLessThan(250)
        expect(f.db().get<{ timeout: number }>(sql`PRAGMA busy_timeout`)?.timeout).toBe(5000)
      }
    } finally {
      blocker.run("ROLLBACK")
      blocker.$client.close()
    }
    f.store.flush()
    expect(f.rows()).toHaveLength(0)
    f.store.write(record(f.root, { phase: "overall" }))
    expect(f.rows()).toHaveLength(1)
    expect(f.db().get<{ timeout: number }>(sql`PRAGMA busy_timeout`)?.timeout).toBe(5000)
  })
}

test("write never waits for locked session ancestry or retains private payloads", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "timing.sqlite")
  using f = fixture(filename)
  f.db().run("PRAGMA journal_mode = DELETE")
  f.db().run("PRAGMA busy_timeout = 5000")
  const child = f.session("ses_child", f.root)
  const grandchild = f.session("ses_grandchild", child)
  const input = {
    ...record(grandchild),
    prompt: "SECRET_LOCKED_PROMPT",
    output: { text: "SECRET_LOCKED_OUTPUT" },
  }
  const blocker = init(filename)
  blocker.run("BEGIN EXCLUSIVE")
  try {
    const start = performance.now()
    expect(() => f.store.write(input)).not.toThrow()
    expect(performance.now() - start).toBeLessThan(250)
    expect(f.db().get<{ timeout: number }>(sql`PRAGMA busy_timeout`)?.timeout).toBe(5000)
    expect(() => f.store.flush()).not.toThrow()
    expect(f.db().get<{ timeout: number }>(sql`PRAGMA busy_timeout`)?.timeout).toBe(5000)
  } finally {
    blocker.run("ROLLBACK")
    blocker.$client.close()
  }
  f.store.flush()
  expect(f.rows()).toHaveLength(0)
  f.store.write(input)
  expect(f.db().get<{ timeout: number }>(sql`PRAGMA busy_timeout`)?.timeout).toBe(5000)
  f.store.flush()
  expect(f.rows()).toHaveLength(1)
  expect(f.rows()[0].root_session_id).toBe(f.root)
  expect(JSON.stringify(f.rows())).not.toContain("SECRET_LOCKED")
  expect(f.db().get<{ timeout: number }>(sql`PRAGMA busy_timeout`)?.timeout).toBe(5000)
})

test("short timer flushes unfinished batches without keeping a process alive", async () => {
  using f = fixture()
  f.store.write(record(f.root))
  expect(f.rows()).toHaveLength(0)
  // This is the timer/debounce behavior under test, not synchronization with work.
  await Bun.sleep(100)
  expect(f.rows()).toHaveLength(1)
})

test("prunes records older than 30 days, preserving the boundary until the next indexed sweep", () => {
  using f = fixture()
  const retention = 30 * 24 * 60 * 60 * 1000
  f.db()
    .insert(TimingTable)
    .values(
      [
        { id: "expired", time_created: f.clock.now - retention - 1 },
        { id: "boundary", time_created: f.clock.now - retention },
        { id: "recent", time_created: f.clock.now },
      ].map((row) => ({
        ...row,
        execution_id: "exe_seed",
        session_id: f.root,
        root_session_id: f.root,
        step_id: "msg_seed",
        phase: "tool",
        data: { version: 1 as const },
      })),
    )
    .run()
  f.store.write(record(f.root))
  f.store.flush()
  expect(f.rows().map((row) => row.id)).not.toContain("expired")
  expect(f.rows().map((row) => row.id)).toContain("boundary")
  f.clock.now += 5 * 60 * 1000 + 1
  f.store.write(record(f.root))
  f.store.flush()
  expect(f.rows().map((row) => row.id)).not.toContain("boundary")
  const plan = f.db().all<{
    detail: string
  }>(sql`EXPLAIN QUERY PLAN DELETE FROM session_timing WHERE time_created < ${f.clock.now - retention}`)
  expect(plan.some((row) => row.detail.includes("session_timing_time_created_id_idx"))).toBe(true)
})

test("caps storage at 100000 rows using an indexed insertion window", () => {
  using f = fixture()
  f.store.write(record(f.root))
  f.store.flush()
  f.db().run(sql`
    WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 100010)
    INSERT INTO session_timing (id, execution_id, session_id, root_session_id, step_id, time_created, phase, data)
    SELECT printf('seed_%06d', n), 'exe_seed', ${f.root}, ${f.root}, 'msg_seed', ${f.clock.now} - 100010 + n, 'tool', '{"version":1}' FROM numbers
  `)
  f.store.write(record(f.root))
  f.store.flush()
  const total = () => f.db().select({ value: count() }).from(TimingTable).get()?.value
  expect(total()).toBe(100000)
  expect(f.db().select().from(TimingTable).where(eq(TimingTable.id, "seed_000001")).get()).toBeUndefined()
  expect(f.db().select().from(TimingTable).where(eq(TimingTable.id, "seed_100010")).get()).toBeDefined()
  for (let i = 0; i < 128; i++) f.store.write(record(f.root, { phase: "overall" }))
  expect(total()).toBe(100000)
  f.store.write(record(f.root, { phase: "overall" }))
  expect(total()).toBe(100000)
  const plan = f.db().all<{
    detail: string
  }>(sql`EXPLAIN QUERY PLAN DELETE FROM session_timing WHERE rowid <= (SELECT max(rowid) FROM session_timing) - 100000`)
  expect(plan.some((row) => row.detail.includes("INTEGER PRIMARY KEY"))).toBe(true)
  expect(plan.some((row) => row.detail.startsWith("SCAN"))).toBe(false)
})

test("child history survives child deletion but root deletion cascades, even across queued batches", () => {
  using f = fixture()
  const child = f.session("ses_child", f.root)
  const grandchild = f.session("ses_grandchild", child)
  f.store.write(record(grandchild))
  f.db().delete(SessionTable).where(eq(SessionTable.id, grandchild)).run()
  f.db().delete(SessionTable).where(eq(SessionTable.id, child)).run()
  f.store.flush()
  expect(f.rows()[0]).toMatchObject({ session_id: grandchild, root_session_id: f.root })
  f.store.write(record(f.root))
  f.db().delete(SessionTable).where(eq(SessionTable.id, f.root)).run()
  const other = f.session("ses_other")
  f.store.write(record(other))
  f.store.flush()
  expect(f.rows()).toHaveLength(1)
  expect(f.rows()[0].session_id).toBe(other)
})

test("generated migration adds only session_timing and leaves the preceding snapshot intact", () => {
  const index = migrations.findIndex((entry) => entry.name.endsWith("_session_timing"))
  expect(index).toBeGreaterThan(0)
  const migration = migrations[index]
  expect(migration.sql).not.toMatch(/^(ALTER|DROP|INSERT|UPDATE|DELETE)\b/im)
  expect(migration.sql.match(/CREATE TABLE/g)).toHaveLength(1)
  expect(migration.sql.match(/CREATE INDEX/g)).toHaveLength(4)
  const current = JSON.parse(readFileSync(path.join(directory, migration.name, "snapshot.json"), "utf8"))
  const previous = JSON.parse(readFileSync(path.join(directory, migrations[index - 1].name, "snapshot.json"), "utf8"))
  expect(current.prevIds).toEqual([previous.id])
  expect(
    current.ddl.filter(
      (entry: { table?: string; name?: string }) => entry.table !== "session_timing" && entry.name !== "session_timing",
    ),
  ).toEqual(previous.ddl)
})

const it = testEffect(Session.defaultLayer)

it.instance("fork clones transcript parts but never timing rows", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: root.id,
      role: "user",
      agent: "build",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: root.id,
      messageID: message.id,
      type: "text",
      text: "not timing metadata",
    })
    SessionTimingStore.write(record(root.id, { stepID: message.id, phase: "overall" }))
    const fork = yield* sessions.fork({ sessionID: root.id })
    expect(yield* sessions.messages({ sessionID: fork.id })).toHaveLength(1)
    expect(
      Database.use((db) => db.select().from(TimingTable).where(eq(TimingTable.session_id, root.id)).all()),
    ).toHaveLength(1)
    expect(
      Database.use((db) => db.select().from(TimingTable).where(eq(TimingTable.session_id, fork.id)).all()),
    ).toHaveLength(0)
    yield* sessions.remove(root.id)
    yield* sessions.remove(fork.id)
  }),
)
