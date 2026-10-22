import { Effect, Layer, Context } from "effect"
import { LLM } from "./llm"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"
import type { MetaAgent } from "./metaagent"
import { MessageV2 } from "./message-v2"
import { MessageID, type SessionID } from "./schema"
import { jsonSchema, tool } from "ai"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Auxiliary from "./auxiliary"

// Thin per-step reasoning reviewer (metacognition layer). Mirrors session/steering.ts:
// it runs a small, cheap, cross-provider model under the configured base prompt ("lens")
// to judge the latest reasoning step and either approve it (REVIEW_OK) or return a short
// course-correction. Model-agnostic: it consumes whatever reasoning representation exists
// (raw, summarized, or none).

export interface ReviewResult {
  readonly type: "ok" | "redirect" | "unavailable" | "skipped"
  readonly message: string
}

type ReviewInput = {
  readonly sessionID: SessionID
  // Latest step's reasoning (raw or summarized; may be empty).
  readonly reasoning: string
  // Recent prior reasoning blocks, for trajectory/contradiction checks.
  readonly priorReasoning: string
  // The lens / criteria to grade against.
  readonly basePrompt: string
  // Configured reviewer model; resolved with graceful fallback.
  readonly model: MetaAgent.ModelRef
  readonly effort?: MetaAgent.Effort
  // Main turn model, used if the configured reviewer model is unavailable.
  readonly fallback: Provider.Model
}

export class Service extends Context.Service<
  Service,
  { readonly review: (input: ReviewInput) => Effect.Effect<ReviewResult> }
>()("@opencode/ReasoningReviewer") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const agents = yield* Agent.Service
    const prov = yield* Provider.Service
    const flags = yield* RuntimeFlags.Service

    const review = Effect.fn("ReasoningReviewer.review")(function* (input: ReviewInput) {
      if (!flags.experimentalMetaAgent) return { type: "skipped" as const, message: "" }
      const ag = yield* agents.get("reasoning-reviewer")
      if (!ag) {
        return { type: "skipped" as const, message: "" }
      }

      // Resolve the configured reviewer model; fall back to the main model (small) if it
      // isn't available (not in catalog / not authed).
      const resolved = yield* prov
        .getModel(input.model.providerID, input.model.modelID)
        .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
      const mdl = resolved ?? input.fallback
      const useSmall = resolved === undefined

      const allMsgs = yield* MessageV2.filterCompactedEffect(input.sessionID)
      const recentMsgs = allMsgs.slice(-5)
      const modelMsgs = yield* MessageV2.toModelMessagesEffect(recentMsgs, mdl)

      const messagesTool = tool({
        description:
          "Read a range of past conversation messages (including older reasoning/thinking) from this session. Recent context is already provided — use this only to inspect older turns.",
        inputSchema: jsonSchema<{ offset?: number; limit?: number }>({
          type: "object",
          properties: {
            offset: { type: "number", description: "Starting message index (0 = oldest). Defaults to 0." },
            limit: { type: "number", description: "Max messages to return. Defaults to 20." },
          },
        }),
        execute: async (args) => {
          const msgs = [...MessageV2.stream(input.sessionID)]
          const offset = Math.max(0, Math.trunc(args.offset ?? 0))
          const limit = Math.max(0, Math.min(20, Math.trunc(args.limit ?? 20)))
          const slice = msgs.slice(offset, offset + limit)
          const lines = slice.map((msg, i) => {
            const idx = offset + i
            const role = msg.info.role
            const texts = msg.parts
              .filter((p): p is MessageV2.TextPart => p.type === "text")
              .map((p) => p.text)
              .join("\n")
            const reasoning = msg.parts
              .filter((p): p is MessageV2.ReasoningPart => p.type === "reasoning")
              .map((p) => `  [thinking] ${p.text.length > 400 ? p.text.slice(0, 400) + "..." : p.text}`)
              .join("\n")
            const content = [texts, reasoning].filter(Boolean).join("\n")
            const truncated = content.length > 1200 ? content.slice(0, 1200) + "\n  [truncated]" : content
            return `--- [${idx}] ${role} ---\n${truncated || "(no content)"}`
          })
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Showing messages ${offset}-${offset + slice.length - 1} of ${msgs.length}\n\n` + lines.join("\n\n"),
              },
            ],
          }
        },
      })

      const reviewPrompt = [
        "<lens>",
        input.basePrompt || "Evaluate whether the reasoning is sound and on-track for the task.",
        "</lens>",
        "",
        "<reasoning_to_review>",
        input.reasoning || "(the model produced no explicit reasoning this step — judge the step's actions/direction)",
        "</reasoning_to_review>",
        ...(input.priorReasoning ? ["", "<earlier_reasoning>", input.priorReasoning, "</earlier_reasoning>"] : []),
        "",
        "Judge the latest reasoning against the lens. Reply with exactly REVIEW_OK if on-track, otherwise a short course-correction for the next step.",
      ].join("\n")

      const user: MessageV2.User = {
        id: MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        agent: "reasoning-reviewer",
        model: { providerID: mdl.providerID, modelID: mdl.id, variant: useSmall ? undefined : input.effort },
        time: { created: Date.now() },
      }

      const text = yield* llm
        .stream({
          agent: ag,
          user,
          system: [],
          small: useSmall,
          tools: { messages: messagesTool },
          model: mdl,
          sessionID: input.sessionID,
          retries: 1,
          usageKind: "reviewer",
          messages: [...modelMsgs, { role: "user" as const, content: reviewPrompt }],
        })
        .pipe(Auxiliary.text)

      const cleaned = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim()
      if (!cleaned || /<\/?think>/.test(cleaned)) return { type: "unavailable" as const, message: "" }
      if (cleaned === "REVIEW_OK") return { type: "ok" as const, message: "" }
      return { type: "redirect" as const, message: cleaned }
    })

    return Service.of({
      review: (input) => Auxiliary.recover(review(input), { type: "unavailable" as const, message: "" }),
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
  ),
)

export * as ReasoningReviewer from "./reasoning-reviewer"
