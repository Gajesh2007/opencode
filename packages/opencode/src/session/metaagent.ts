import { SessionID } from "./schema"
import { ProviderID, ModelID } from "@/provider/schema"
import { Effect, Layer, Context, Schema } from "effect"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import { MetaAgentTable } from "./session.sql"

// Per-session configuration for the metacognition layer: a thin reviewer ("meta
// agent") that grades the model's reasoning after each step against a base prompt
// (the "lens" — e.g. "think in first principles" / "think like David Deutsch").
// Set via the `metaagent` tool or the `/metaagent` command; consumed per-step by
// the ReasoningReviewer and injected into the main agent's system prompt.

export const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"])
export type Effort = Schema.Schema.Type<typeof Effort>

export const ModelRef = Schema.Struct({ providerID: ProviderID, modelID: ModelID })
export type ModelRef = Schema.Schema.Type<typeof ModelRef>

export const Info = Schema.Struct({
  sessionID: SessionID,
  enabled: Schema.Boolean,
  basePrompt: Schema.String,
  model: Schema.optional(ModelRef),
  effort: Schema.optional(Effort),
}).annotate({ identifier: "MetaAgent" })
export type Info = Schema.Schema.Type<typeof Info>

// Default reviewer model: a cheap, fast, cross-provider small model.
export const DEFAULT_MODEL: ModelRef = {
  providerID: ProviderID.make("google"),
  modelID: ModelID.make("gemini-3.5-flash"),
}
export const DEFAULT_EFFORT: Effort = "medium"

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly set: (input: {
    sessionID: SessionID
    enabled?: boolean
    basePrompt?: string
    model?: ModelRef
    effort?: Effort
  }) => Effect.Effect<Info>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionMetaAgent") {}

function rowToInfo(row: typeof MetaAgentTable.$inferSelect): Info {
  return {
    sessionID: row.session_id as SessionID,
    enabled: row.enabled === 1,
    basePrompt: row.base_prompt,
    model:
      row.model_provider && row.model_id
        ? { providerID: row.model_provider as ProviderID, modelID: row.model_id as ModelID }
        : undefined,
    effort: row.effort ?? undefined,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const get: Interface["get"] = Effect.fn("MetaAgent.get")(function* (sessionID) {
      const row = yield* Effect.sync(() =>
        Database.use((db) => db.select().from(MetaAgentTable).where(eq(MetaAgentTable.session_id, sessionID)).get()),
      )
      if (!row) return undefined
      return rowToInfo(row)
    })

    // Merge semantics: only the provided fields change; the rest are preserved.
    // Setting any field activates the meta agent unless `enabled:false` is passed.
    const set: Interface["set"] = Effect.fn("MetaAgent.set")(function* (input) {
      const existing = yield* get(input.sessionID)
      const now = Date.now()
      const merged: Info = {
        sessionID: input.sessionID,
        enabled: input.enabled ?? existing?.enabled ?? true,
        basePrompt: input.basePrompt ?? existing?.basePrompt ?? "",
        model: input.model ?? existing?.model ?? DEFAULT_MODEL,
        effort: input.effort ?? existing?.effort ?? DEFAULT_EFFORT,
      }
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.delete(MetaAgentTable).where(eq(MetaAgentTable.session_id, input.sessionID)).run()
          db.insert(MetaAgentTable)
            .values({
              session_id: input.sessionID,
              enabled: merged.enabled ? 1 : 0,
              base_prompt: merged.basePrompt,
              model_provider: merged.model?.providerID ?? null,
              model_id: merged.model?.modelID ?? null,
              effort: merged.effort ?? null,
              time_created: now,
              time_updated: now,
            })
            .run()
        }),
      )
      return merged
    })

    const clear: Interface["clear"] = Effect.fn("MetaAgent.clear")(function* (sessionID) {
      yield* Effect.sync(() =>
        Database.use((db) => db.delete(MetaAgentTable).where(eq(MetaAgentTable.session_id, sessionID)).run()),
      )
    })

    return Service.of({ get, set, clear })
  }),
)

export const defaultLayer = layer

export * as MetaAgent from "./metaagent"
