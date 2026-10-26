export * as ModelSelectionPlugin from "./model-selection.js"

import { define } from "@opencode/plugin/effect/plugin"
import { SystemPart } from "@opencode/ai"
import { Effect } from "effect"
import type { SessionRequest } from "@opencode/plugin/effect/session"
import { Model } from "../model.js"
import { ModelSelection } from "../model-selection.js"
import { Provider } from "../provider.js"
import { Session } from "../session.js"

export const Plugin = define({
  id: "opencode.model-selection",
  effect: Effect.fn("ModelSelectionPlugin")(function* (ctx) {
    const models = yield* Model.Service
    const sessions = yield* Session.Service
    yield* models.transform((editor) => {
      for (const model of editor.list()) {
        if (!ModelSelection.supportsUltra(model) || model.variants.some((variant) => variant.id === "ultra")) continue
        const maximum = model.variants.find((variant) => variant.id === "max")
        if (maximum) model.variants.push({ ...maximum, id: Model.VariantID.make("ultra") })
      }
    })
    const apply = (event: SessionRequest) =>
      Effect.gen(function* () {
        const session = yield* sessions.get(event.sessionID)
        const model = yield* models.get(event.model.providerID, event.model.id)
        if (!model) return
        const selection =
          session.model?.id === model.id && session.model.providerID === model.providerID ? session.model : event.model
        Object.assign(event.options, Provider.mergeOverlay(event.options, ModelSelection.options(model, selection)))
        if (ModelSelection.supportsUltra(model))
          event.system.push(
            SystemPart.make(
              event.model.variant === "ultra"
                ? "Proactive multi-agent delegation is enabled. Use scoped child agents when parallel work improves quality or speed. Continue useful independent work while children run and respect the user's limits."
                : "Delegate only when the user or applicable instructions explicitly request subagents, delegation or parallel work.",
            ),
          )
      }).pipe(Effect.catch((error) => Effect.logWarning("Unable to apply model selection", { error })))
    yield* ctx.session.hook("context", apply)
    yield* ctx.session.hook("compaction", apply)
    yield* ctx.session.hook("model.request", (event) =>
      Effect.gen(function* () {
        const model = yield* models.get(event.model.providerID, event.model.id)
        if (!model) return
        const selection = event.model
        if (!selection.serviceTier) return
        const headers = ModelSelection.tiers(model)[selection.serviceTier]?.headers
        if (typeof headers === "object" && headers !== null && !Array.isArray(headers))
          Object.assign(
            event.headers,
            Object.fromEntries(
              Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
            ),
          )
      }).pipe(Effect.catch((error) => Effect.logWarning("Unable to apply tier headers", { error }))),
    )
  }),
})
