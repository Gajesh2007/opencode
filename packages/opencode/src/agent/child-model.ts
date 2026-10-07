import type { Agent } from "./agent"
import { Provider } from "@/provider/provider"
import type { MessageV2 } from "@/session/message-v2"
import { Effect } from "effect"

export type Input = {
  model?: string
  variant?: string
  resetModel?: boolean
  agent: Agent.Info
  parent: MessageV2.User["model"]
  current?: MessageV2.User["model"]
}

export const resolve = Effect.fn("ChildModel.resolve")(function* (input: Input) {
  if (input.resetModel && (input.model !== undefined || input.variant !== undefined)) {
    return yield* Effect.fail(new Error("reset_model cannot be combined with model or variant."))
  }
  if (input.model !== undefined && !/^[^/\s]+\/\S+$/.test(input.model)) {
    return yield* Effect.fail(new Error("model must be a provider/model ID, including both names."))
  }
  if (input.variant !== undefined && !input.variant.trim()) {
    return yield* Effect.fail(new Error("variant must be a model-supported name or 'default'."))
  }

  const defaults = input.agent.model ?? input.parent
  const inherited = defaults.providerID === input.parent.providerID && defaults.modelID === input.parent.modelID
  const current =
    input.current && !input.resetModel
      ? input.current
      : {
          ...defaults,
          variant: input.agent.variant ?? (inherited ? input.parent.variant : undefined),
          serviceTier: input.agent.serviceTier ?? input.parent.serviceTier,
          upstream: input.parent.upstream,
        }
  const model = input.model ? Provider.parseModel(input.model) : current
  const changed = model.providerID !== current.providerID || model.modelID !== current.modelID
  const configured = model.providerID === input.agent.model?.providerID && model.modelID === input.agent.model?.modelID
  const variant =
    input.variant ?? (changed ? (configured ? input.agent.variant : undefined) : current.variant) ?? "default"
  const serviceTier = current.serviceTier === "default" ? undefined : current.serviceTier
  const upstream = current.upstream === "default" ? undefined : current.upstream
  const source = input.current && !input.resetModel ? input.current : input.parent
  const tierSource =
    input.current && !input.resetModel ? input.current : input.agent.serviceTier ? defaults : input.parent
  const routingChanged = model.providerID !== source.providerID || model.modelID !== source.modelID
  const selection = {
    model: { providerID: model.providerID, modelID: model.modelID },
    variant,
    ...(serviceTier ? { serviceTier } : {}),
    ...(upstream ? { upstream } : {}),
  }

  // Existing omitted selections retain their admission behavior. Explicit changes
  // must use the filtered connected catalog, not the unfiltered model database.
  if (input.model === undefined && input.variant === undefined && !input.resetModel) return selection
  const provider = yield* Provider.Service
  const target = yield* provider
    .getModel(model.providerID, model.modelID)
    .pipe(
      Effect.mapError(
        (error) =>
          new Error(
            `Model ${error.providerID}/${error.modelID} is unavailable or disallowed.${error.suggestions?.length ? ` Available alternatives: ${error.suggestions.join(", ")}.` : ""}`,
          ),
      ),
    )
  if (variant !== "default" && !Object.hasOwn(target.variants ?? {}, variant)) {
    return yield* Effect.fail(
      new Error(
        `Variant '${variant}' is not supported by ${target.providerID}/${target.id}. Choose 'default'${Object.keys(target.variants ?? {}).length ? ` or one of: ${Object.keys(target.variants ?? {}).join(", ")}` : ""}.`,
      ),
    )
  }
  if (!target.capabilities.input.text || !target.capabilities.output.text || !target.capabilities.toolcall) {
    return yield* Effect.fail(
      new Error(
        `Model ${target.providerID}/${target.id} must support text input, text output, and tool calls for a child agent.`,
      ),
    )
  }
  if (
    serviceTier &&
    (!Object.hasOwn(target.serviceTiers ?? {}, serviceTier) || target.providerID !== tierSource.providerID)
  ) {
    return yield* Effect.fail(
      new Error(
        `Service tier '${serviceTier}' cannot be carried to ${target.providerID}/${target.id}. Choose a compatible model or have the user clear the service tier before switching.`,
      ),
    )
  }
  if (
    upstream &&
    routingChanged &&
    (!target.upstreams?.includes(upstream) ||
      !["@ai-sdk/gateway", "@openrouter/ai-sdk-provider"].includes(target.api.npm) ||
      target.providerID !== source.providerID)
  ) {
    return yield* Effect.fail(
      new Error(
        `Upstream pin '${upstream}' cannot be carried to ${target.providerID}/${target.id}. Choose a compatible model or have the user clear the upstream pin before switching.`,
      ),
    )
  }
  return { ...selection, model: { providerID: target.providerID, modelID: target.id } }
})

export * as ChildModel from "./child-model"
