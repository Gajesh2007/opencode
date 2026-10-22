import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID, MessageID, PartID } from "./schema"
import { Effect, Layer, Context, Schema } from "effect"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import { GoalTable, SessionTable } from "./session.sql"
import { SessionUsage } from "./usage"

export const GoalStatus = Schema.Literals(["active", "completed", "blocked", "budget_limited", "abandoned"])
export type GoalStatus = Schema.Schema.Type<typeof GoalStatus>

export const Info = Schema.Struct({
  sessionID: SessionID,
  objective: Schema.String,
  status: GoalStatus,
  tokenBudget: Schema.optional(Schema.Number),
  tokensUsed: Schema.Number,
  costBudget: Schema.optional(Schema.Number),
  costUsed: Schema.Number,
  blockedTurns: Schema.Number,
  createdAt: Schema.optional(Schema.Number),
  usage: Schema.optional(SessionUsage.Summary),
  wholeTaskUsage: Schema.optional(SessionUsage.Summary),
}).annotate({ identifier: "Goal" })
export type Info = Schema.Schema.Type<typeof Info>

export type Turn = {
  messageID: MessageID
  token: string
  expires: number
  continuation?: { messageID: MessageID; partID: PartID; text: string }
}

const LEASE_MS = 30_000

export const Event = {
  Updated: BusEvent.define(
    "goal.updated",
    Schema.Struct({
      sessionID: SessionID,
      goal: Info,
    }),
  ),
}

export interface Interface {
  readonly create: (input: {
    sessionID: SessionID
    objective: string
    tokenBudget?: number
    costBudget?: number
  }) => Effect.Effect<Info>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly update: (input: {
    sessionID: SessionID
    status: "completed" | "blocked"
    createdAt?: number
  }) => Effect.Effect<Info | undefined>
  readonly claimTurn: (
    sessionID: SessionID,
    messageID: MessageID,
    createdAt?: number,
  ) => Effect.Effect<Turn | undefined>
  readonly getTurn: (sessionID: SessionID) => Effect.Effect<Turn | undefined>
  readonly renewTurn: (sessionID: SessionID, token: string) => Effect.Effect<void>
  readonly releaseTurn: (sessionID: SessionID, token: string, completed: boolean) => Effect.Effect<void>
  readonly prepareContinuation: (sessionID: SessionID, token: string, text: string) => Effect.Effect<Turn | undefined>
  readonly recoverable: (directory: string) => Effect.Effect<SessionID[]>
  readonly setBudgetLimited: (sessionID: SessionID, createdAt?: number) => Effect.Effect<Info | undefined>
  readonly incrementBlockedTurns: (sessionID: SessionID, createdAt?: number) => Effect.Effect<number>
  readonly resetBlockedTurns: (sessionID: SessionID, createdAt?: number) => Effect.Effect<void>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

function rowToInfo(row: typeof GoalTable.$inferSelect): Info {
  const usage = SessionUsage.summarize(row.session_id, {
    end: row.usage_end ?? undefined,
    baseline: row.usage_baseline,
  })
  return {
    sessionID: row.session_id as SessionID,
    objective: row.objective,
    status: row.status,
    tokenBudget: row.token_budget ?? undefined,
    tokensUsed: row.tokens_used + usage.tokens,
    costBudget: row.cost_budget ?? undefined,
    costUsed: row.cost_used + usage.cost,
    blockedTurns: row.blocked_turns,
    createdAt: row.time_created,
    usage,
    wholeTaskUsage: SessionUsage.summarize(row.session_id, undefined, true),
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const publish = (goal: Info) => bus.publish(Event.Updated, { sessionID: goal.sessionID, goal })

    const create: Interface["create"] = Effect.fn("Goal.create")(function* (input) {
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          const previous = db.select().from(GoalTable).where(eq(GoalTable.session_id, input.sessionID)).get()
          // Monotonic even for replacement within the same millisecond.
          const now = Math.max(Date.now(), (previous?.time_created ?? 0) + 1)
          db.delete(GoalTable).where(eq(GoalTable.session_id, input.sessionID)).run()
          db.insert(GoalTable)
            .values({
              session_id: input.sessionID,
              objective: input.objective,
              status: "active",
              token_budget: input.tokenBudget ?? null,
              tokens_used: 0,
              cost_budget: input.costBudget ?? null,
              cost_used: 0,
              blocked_turns: 0,
              usage_baseline: SessionUsage.rows(input.sessionID).map((row) => row.id),
              time_created: now,
              time_updated: now,
            })
            .run()
        }),
      )
      const goal = yield* get(input.sessionID)
      if (!goal) throw new Error("Created goal was not persisted")
      yield* publish(goal)
      return goal
    })

    const get: Interface["get"] = Effect.fn("Goal.get")(function* (sessionID) {
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(GoalTable).where(eq(GoalTable.session_id, sessionID)).get()),
      )
      if (!row) return undefined
      return rowToInfo(row)
    })

    const update: Interface["update"] = Effect.fn("Goal.update")(function* (input) {
      const now = Date.now()
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(GoalTable)
            .set({
              status: input.status,
              time_updated: now,
              usage_end: SessionUsage.rows(input.sessionID).map((row) => row.id),
            })
            .where(
              Database.and(
                eq(GoalTable.session_id, input.sessionID),
                input.createdAt === undefined ? undefined : eq(GoalTable.time_created, input.createdAt),
              ),
            )
            .returning()
            .get(),
        ),
      )
      const goal = row ? rowToInfo(row) : undefined
      if (goal) yield* publish(goal)
      return goal
    })

    const claimTurn: Interface["claimTurn"] = Effect.fn("Goal.claimTurn")(function* (sessionID, messageID, createdAt) {
      return yield* Effect.sync(() =>
        Database.transaction((db) => {
          const row = db.select().from(GoalTable).where(eq(GoalTable.session_id, sessionID)).get()
          if (!row || row.status !== "active" || (createdAt !== undefined && row.time_created !== createdAt)) return
          if (row.last_assistant_id && row.last_assistant_id >= messageID) return
          const pending = row.pending_turn
          if (pending && messageID < pending.messageID) return
          // A newer assistant after our outbox message proves the previous dispatch ran.
          if (
            pending &&
            pending.expires > Date.now() &&
            !(pending.continuation && messageID > pending.continuation.messageID)
          )
            return
          const turn: Turn = {
            messageID,
            token: crypto.randomUUID(),
            expires: Date.now() + LEASE_MS,
            continuation: pending?.messageID === messageID ? pending.continuation : undefined,
          }
          db.update(GoalTable)
            .set({
              pending_turn: turn,
              last_assistant_id: pending && pending.messageID < messageID ? pending.messageID : row.last_assistant_id,
            })
            .where(eq(GoalTable.session_id, sessionID))
            .run()
          return turn
        }),
      )
    })

    const getTurn: Interface["getTurn"] = (sessionID) =>
      Effect.sync(() =>
        Database.use(
          (db) =>
            db.select().from(GoalTable).where(eq(GoalTable.session_id, sessionID)).get()?.pending_turn ?? undefined,
        ),
      )

    const renewTurn: Interface["renewTurn"] = (sessionID, token) =>
      Effect.sync(() =>
        Database.transaction((db) => {
          const row = db.select().from(GoalTable).where(eq(GoalTable.session_id, sessionID)).get()
          if (row?.pending_turn?.token !== token) return
          db.update(GoalTable)
            .set({ pending_turn: { ...row.pending_turn, expires: Date.now() + LEASE_MS } })
            .where(eq(GoalTable.session_id, sessionID))
            .run()
        }),
      )

    const releaseTurn: Interface["releaseTurn"] = (sessionID, token, completed) =>
      Effect.sync(() =>
        Database.transaction((db) => {
          const row = db.select().from(GoalTable).where(eq(GoalTable.session_id, sessionID)).get()
          if (row?.pending_turn?.token !== token) return
          db.update(GoalTable)
            .set(
              completed
                ? { pending_turn: null, last_assistant_id: row.pending_turn.messageID }
                : { pending_turn: { ...row.pending_turn, expires: 0 } },
            )
            .where(eq(GoalTable.session_id, sessionID))
            .run()
        }),
      )

    const prepareContinuation: Interface["prepareContinuation"] = (sessionID, token, text) =>
      Effect.sync(() =>
        Database.transaction((db) => {
          const row = db.select().from(GoalTable).where(eq(GoalTable.session_id, sessionID)).get()
          if (row?.pending_turn?.token !== token) return
          const turn = {
            ...row.pending_turn,
            continuation: row.pending_turn.continuation ?? {
              messageID: MessageID.ascending(),
              partID: PartID.ascending(),
              text,
            },
          }
          db.update(GoalTable).set({ pending_turn: turn }).where(eq(GoalTable.session_id, sessionID)).run()
          return turn
        }),
      )

    const recoverable: Interface["recoverable"] = (directory) =>
      Effect.sync(() =>
        Database.use((db) =>
          db
            .select({ sessionID: GoalTable.session_id, turn: GoalTable.pending_turn })
            .from(GoalTable)
            .innerJoin(SessionTable, eq(SessionTable.id, GoalTable.session_id))
            .where(Database.and(eq(GoalTable.status, "active"), eq(SessionTable.directory, directory)))
            .all()
            .filter((row) => row.turn && row.turn.expires <= Date.now())
            .map((row) => row.sessionID),
        ),
      )

    const setBudgetLimited: Interface["setBudgetLimited"] = Effect.fn("Goal.setBudgetLimited")(
      function* (sessionID, createdAt) {
        const now = Date.now()
        const row = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .update(GoalTable)
              .set({
                status: "budget_limited",
                time_updated: now,
                usage_end: SessionUsage.rows(sessionID).map((row) => row.id),
              })
              .where(
                Database.and(
                  eq(GoalTable.session_id, sessionID),
                  createdAt === undefined ? undefined : eq(GoalTable.time_created, createdAt),
                ),
              )
              .returning()
              .get(),
          ),
        )
        const goal = row ? rowToInfo(row) : undefined
        if (goal) yield* publish(goal)
        return goal
      },
    )

    const incrementBlockedTurns: Interface["incrementBlockedTurns"] = Effect.fn("Goal.incrementBlockedTurns")(
      function* (sessionID, createdAt) {
        const now = Date.now()
        const row = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .update(GoalTable)
              .set({
                blocked_turns: Database.sql`blocked_turns + 1`,
                time_updated: now,
              })
              .where(
                Database.and(
                  eq(GoalTable.session_id, sessionID),
                  createdAt === undefined ? undefined : eq(GoalTable.time_created, createdAt),
                ),
              )
              .returning()
              .get(),
          ),
        )
        return row?.blocked_turns ?? 0
      },
    )

    const resetBlockedTurns: Interface["resetBlockedTurns"] = Effect.fn("Goal.resetBlockedTurns")(
      function* (sessionID, createdAt) {
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .update(GoalTable)
              .set({ blocked_turns: 0, time_updated: Date.now() })
              .where(
                Database.and(
                  eq(GoalTable.session_id, sessionID),
                  createdAt === undefined ? undefined : eq(GoalTable.time_created, createdAt),
                ),
              )
              .run(),
          ),
        )
      },
    )

    const clear: Interface["clear"] = Effect.fn("Goal.clear")(function* (sessionID) {
      yield* Effect.sync(() =>
        Database.use((db) => db.delete(GoalTable).where(eq(GoalTable.session_id, sessionID)).run()),
      )
    })

    return Service.of({
      create,
      get,
      update,
      claimTurn,
      getTurn,
      renewTurn,
      releaseTurn,
      prepareContinuation,
      recoverable,
      setBudgetLimited,
      incrementBlockedTurns,
      resetBlockedTurns,
      clear,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Goal from "./goal"
