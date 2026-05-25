import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID } from "./schema"
import { Effect, Layer, Context, Schema } from "effect"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import { GoalTable } from "./session.sql"

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
}).annotate({ identifier: "Goal" })
export type Info = Schema.Schema.Type<typeof Info>

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
  }) => Effect.Effect<Info | undefined>
  readonly addUsage: (input: {
    sessionID: SessionID
    tokens: number
    cost: number
  }) => Effect.Effect<Info | undefined>
  readonly setBudgetLimited: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly incrementBlockedTurns: (sessionID: SessionID) => Effect.Effect<number>
  readonly resetBlockedTurns: (sessionID: SessionID) => Effect.Effect<void>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

function rowToInfo(row: typeof GoalTable.$inferSelect): Info {
  return {
    sessionID: row.session_id as SessionID,
    objective: row.objective,
    status: row.status,
    tokenBudget: row.token_budget ?? undefined,
    tokensUsed: row.tokens_used,
    costBudget: row.cost_budget ?? undefined,
    costUsed: row.cost_used,
    blockedTurns: row.blocked_turns,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const publish = (goal: Info) => bus.publish(Event.Updated, { sessionID: goal.sessionID, goal })

    const create: Interface["create"] = Effect.fn("Goal.create")(function* (input) {
      const now = Date.now()
      yield* Effect.sync(() =>
        Database.transaction((db) => {
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
              time_created: now,
              time_updated: now,
            })
            .run()
        }),
      )
      const goal: Info = {
        sessionID: input.sessionID,
        objective: input.objective,
        status: "active",
        tokenBudget: input.tokenBudget,
        tokensUsed: 0,
        costBudget: input.costBudget,
        costUsed: 0,
        blockedTurns: 0,
      }
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
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(GoalTable)
            .set({ status: input.status, time_updated: now })
            .where(eq(GoalTable.session_id, input.sessionID))
            .run(),
        ),
      )
      const goal = yield* get(input.sessionID)
      if (goal) yield* publish(goal)
      return goal
    })

    const addUsage: Interface["addUsage"] = Effect.fn("Goal.addUsage")(function* (input) {
      const now = Date.now()
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(GoalTable)
            .set({
              tokens_used: Database.sql`tokens_used + ${input.tokens}`,
              cost_used: Database.sql`cost_used + ${input.cost}`,
              time_updated: now,
            })
            .where(eq(GoalTable.session_id, input.sessionID))
            .run(),
        ),
      )
      return yield* get(input.sessionID)
    })

    const setBudgetLimited: Interface["setBudgetLimited"] = Effect.fn("Goal.setBudgetLimited")(
      function* (sessionID) {
        const now = Date.now()
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .update(GoalTable)
              .set({ status: "budget_limited", time_updated: now })
              .where(eq(GoalTable.session_id, sessionID))
              .run(),
          ),
        )
        const goal = yield* get(sessionID)
        if (goal) yield* publish(goal)
        return goal
      },
    )

    const incrementBlockedTurns: Interface["incrementBlockedTurns"] = Effect.fn("Goal.incrementBlockedTurns")(
      function* (sessionID) {
        const now = Date.now()
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .update(GoalTable)
              .set({
                blocked_turns: Database.sql`blocked_turns + 1`,
                time_updated: now,
              })
              .where(eq(GoalTable.session_id, sessionID))
              .run(),
          ),
        )
        const goal = yield* get(sessionID)
        return goal?.blockedTurns ?? 0
      },
    )

    const resetBlockedTurns: Interface["resetBlockedTurns"] = Effect.fn("Goal.resetBlockedTurns")(
      function* (sessionID) {
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .update(GoalTable)
              .set({ blocked_turns: 0, time_updated: Date.now() })
              .where(eq(GoalTable.session_id, sessionID))
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

    return Service.of({ create, get, update, addUsage, setBudgetLimited, incrementBlockedTurns, resetBlockedTurns, clear })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Goal from "./goal"
