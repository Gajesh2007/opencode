import { Effect, Schema, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@/storage/db"
import type { Provider } from "@/provider/provider"
import { SessionID } from "./schema"
import { SessionTable } from "./session.sql"
import { UsageTable } from "./usage.sql"
import { getUsage } from "./session"
import type { LLMEvent } from "@opencode-ai/llm"

export type Record = {
  kind: "assistant" | "reviewer" | "steering" | "auxiliary"
  tokens?: Omit<ReturnType<typeof getUsage>["tokens"], "total"> & { total?: number }
  cost?: number
  providerID?: string
  modelID?: string
  requestedTier?: string
  returnedTier?: string
  pricing: "catalog_estimate" | "provider_reported" | "tier_unverified" | "unknown"
}

export const Summary = Schema.Struct({
  tokens: Schema.Number,
  cost: Schema.Number,
  attempts: Schema.Number,
  unknownAttempts: Schema.Number,
  unknownCosts: Schema.Number,
  pricing: Schema.Literals(["catalog_estimate", "provider_reported", "tier_unverified", "unknown"]),
  external: Schema.Literal("unknown"),
  coverage: Schema.Literal("recorded_attempts_only"),
  auxiliary: Schema.Literal("partial"),
})
export type Summary = Schema.Schema.Type<typeof Summary>

export function record(input: { id: string; sessionID: SessionID; startedAt: number; data: Record }) {
  return Effect.sync(() =>
    Database.transaction((db) => {
      const existing = db.select().from(UsageTable).where(eq(UsageTable.id, input.id)).get()
      if (existing) {
        // Never downgrade a reported finish when cleanup/replayed events arrive late.
        db.update(UsageTable)
          .set({
            data: {
              ...existing.data,
              ...input.data,
              tokens: input.data.tokens ?? existing.data.tokens,
              cost: input.data.cost ?? existing.data.cost,
              pricing: input.data.pricing === "unknown" ? existing.data.pricing : input.data.pricing,
            },
          })
          .where(eq(UsageTable.id, input.id))
          .run()
        return
      }
      const ancestors = lineage(input.sessionID)
      if (!ancestors.length) return
      db.insert(UsageTable)
        .values({
          id: input.id,
          session_id: input.sessionID,
          root_session_id: ancestors.at(-1) ?? input.sessionID,
          ancestors,
          time_created: input.startedAt,
          data: input.data,
        })
        .run()
    }),
  )
}

// One identity per stream step. An unfinished/abandoned attempt stays unknown,
// including across process restarts. Known usage survives later stream failure.
export function track(input: {
  sessionID: SessionID
  kind: Record["kind"]
  model: Provider.Model
  serviceTier?: string
}) {
  return <E, R>(stream: Stream.Stream<LLMEvent, E, R>) =>
    Stream.unwrap(
      Effect.gen(function* () {
        let id = crypto.randomUUID()
        let startedAt = Date.now()
        let finished = false
        let started = false
        const request = {
          kind: input.kind,
          providerID: input.model.providerID,
          modelID: input.model.id,
          requestedTier:
            input.serviceTier ??
            (typeof input.model.options.serviceTier === "string" ? input.model.options.serviceTier : undefined),
        }
        yield* record({ id, startedAt, sessionID: input.sessionID, data: { ...request, pricing: "unknown" } })
        return stream.pipe(
          Stream.tap((event) =>
            Effect.gen(function* () {
              if (event.type === "step-start" && (started || finished)) {
                id = crypto.randomUUID()
                startedAt = Date.now()
                finished = false
                yield* record({
                  id,
                  startedAt,
                  sessionID: input.sessionID,
                  data: { ...request, pricing: "unknown" },
                })
              }
              if (event.type === "step-start") started = true
              if (event.type !== "step-finish" && (event.type !== "finish" || finished)) return
              finished = true
              const reportedUsage =
                event.usage &&
                [
                  event.usage.inputTokens,
                  event.usage.outputTokens,
                  event.usage.totalTokens,
                  event.usage.reasoningTokens,
                  event.usage.cacheReadInputTokens,
                  event.usage.cacheWriteInputTokens,
                ].some((value) => value !== undefined)
              const usage =
                event.usage && reportedUsage
                  ? getUsage({ model: input.model, usage: event.usage, metadata: event.providerMetadata })
                  : undefined
              const gateway = event.providerMetadata?.gateway
              const rawCost = gateway && typeof gateway === "object" && "cost" in gateway ? gateway.cost : undefined
              const reported =
                (typeof rawCost === "number" || (typeof rawCost === "string" && rawCost.trim().length > 0)) &&
                Number.isFinite(Number(rawCost)) &&
                Number(rawCost) >= 0
              const openai = event.providerMetadata?.openai
              const bedrock = event.providerMetadata?.bedrock
              const responseTier = openai?.serviceTier ?? bedrock?.serviceTier
              const returnedTier =
                typeof responseTier === "string"
                  ? responseTier
                  : responseTier &&
                      typeof responseTier === "object" &&
                      "type" in responseTier &&
                      typeof responseTier.type === "string"
                    ? responseTier.type
                    : undefined
              const tier = returnedTier ?? request.requestedTier
              const unverified = tier !== undefined && tier !== "default" && tier !== "standard"
              const priced = input.model.costKnown ?? (input.model.cost.input > 0 || input.model.cost.output > 0)
              yield* record({
                id,
                startedAt,
                sessionID: input.sessionID,
                data: {
                  ...request,
                  returnedTier,
                  ...usage,
                  cost: reported ? Number(rawCost) : usage?.cost,
                  pricing: reported
                    ? "provider_reported"
                    : !priced ||
                        !usage ||
                        event.usage?.inputTokens === undefined ||
                        event.usage?.outputTokens === undefined
                      ? "unknown"
                      : unverified
                        ? "tier_unverified"
                        : "catalog_estimate",
                },
              })
            }),
          ),
        )
      }),
    )
}

function lineage(sessionID: SessionID) {
  return Database.use((db) => {
    const ids: SessionID[] = []
    let id: SessionID | null = sessionID
    for (;;) {
      if (!id || ids.includes(id)) return ids
      const session = db
        .select({ parent: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, id))
        .get()
      if (!session) return ids
      ids.push(id)
      id = session.parent
    }
  })
}

export function rows(sessionID: SessionID, wholeTask = false) {
  const root = lineage(sessionID).at(-1) ?? sessionID
  return Database.use((db) => db.select().from(UsageTable).where(eq(UsageTable.root_session_id, root)).all()).filter(
    (row) => wholeTask || row.ancestors.includes(sessionID),
  )
}

export function summarize(
  sessionID: SessionID,
  boundary?: { end?: string[]; baseline: string[] },
  wholeTask = false,
): Summary {
  const baseline = new Set(boundary?.baseline)
  const entries = rows(sessionID, wholeTask).filter(
    (row) => !boundary || (!baseline.has(row.id) && (boundary.end === undefined || boundary.end.includes(row.id))),
  )
  return {
    tokens: entries.reduce(
      (sum, row) =>
        sum +
        (row.data.tokens
          ? Math.max(
              row.data.tokens.total ?? 0,
              row.data.tokens.input +
                row.data.tokens.output +
                row.data.tokens.reasoning +
                row.data.tokens.cache.read +
                row.data.tokens.cache.write,
            )
          : 0),
      0,
    ),
    cost: entries.reduce((sum, row) => sum + (row.data.cost ?? 0), 0),
    attempts: entries.length,
    unknownAttempts: entries.filter((row) => !row.data.tokens).length,
    unknownCosts: entries.filter((row) => row.data.pricing === "unknown" || row.data.pricing === "tier_unverified")
      .length,
    pricing:
      entries.some((row) => row.data.pricing === "unknown") || !entries.length
        ? "unknown"
        : entries.some((row) => row.data.pricing === "tier_unverified")
          ? "tier_unverified"
          : entries.some((row) => row.data.pricing === "catalog_estimate")
            ? "catalog_estimate"
            : "provider_reported",
    external: "unknown",
    coverage: "recorded_attempts_only",
    auxiliary: "partial",
  }
}

export * as SessionUsage from "./usage"
