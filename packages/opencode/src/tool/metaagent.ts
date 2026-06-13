import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./metaagent.txt"
import { MetaAgent } from "../session/metaagent"
import { ProviderID, ModelID } from "@/provider/schema"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["set", "get", "clear"]).annotate({
    description: '"set" to configure the reasoning reviewer, "get" to read it, "clear" to disable it',
  }),
  base_prompt: Schema.optional(Schema.String).annotate({
    description:
      "The reviewer lens / criteria — e.g. 'think in first principles' or 'review as David Deutsch would'. Also injected into the main agent's system prompt so it actually thinks that way.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Reviewer model as 'provider/model-id' (default google/gemini-3.5-flash)",
  }),
  effort: Schema.optional(Schema.Literals(["low", "medium", "high", "xhigh", "max"])).annotate({
    description: "Reviewer reasoning effort (default medium)",
  }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable/disable the reviewer without losing the rest of the config",
  }),
})

type MetaAgentMetadata = {
  action: string
  metaagent?: MetaAgent.Info
}

export const MetaAgentTool = Tool.define<typeof Parameters, MetaAgentMetadata, MetaAgent.Service>(
  "metaagent",
  Effect.gen(function* () {
    const svc = yield* MetaAgent.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<MetaAgentMetadata>) =>
        Effect.gen(function* () {
          if (params.action === "get") {
            const current = yield* svc.get(ctx.sessionID)
            if (!current) {
              return {
                title: "No meta agent",
                output: "No meta agent is configured for this session.",
                metadata: { action: "get" },
              }
            }
            return { title: "Meta agent", output: format(current), metadata: { action: "get", metaagent: current } }
          }

          if (params.action === "clear") {
            yield* svc.clear(ctx.sessionID)
            return {
              title: "Meta agent cleared",
              output: "The reasoning reviewer is disabled for this session.",
              metadata: { action: "clear" },
            }
          }

          // action === "set"
          const result = yield* svc.set({
            sessionID: ctx.sessionID,
            enabled: params.enabled,
            basePrompt: params.base_prompt,
            model: parseModel(params.model),
            effort: params.effort,
          })
          return { title: "Meta agent set", output: format(result), metadata: { action: "set", metaagent: result } }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, MetaAgentMetadata>
  }),
)

function parseModel(input: string | undefined): MetaAgent.ModelRef | undefined {
  if (!input) return undefined
  const i = input.indexOf("/")
  if (i <= 0 || i >= input.length - 1) return undefined
  return { providerID: ProviderID.make(input.slice(0, i)), modelID: ModelID.make(input.slice(i + 1)) }
}

function format(m: MetaAgent.Info): string {
  return [
    `Enabled: ${m.enabled}`,
    `Base prompt: ${m.basePrompt || "(none)"}`,
    `Model: ${m.model ? `${m.model.providerID}/${m.model.modelID}` : "(default)"}`,
    `Effort: ${m.effort ?? "(default)"}`,
  ].join("\n")
}
