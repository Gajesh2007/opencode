export * as MetaAgentPlugin from "./meta-agent.js"

import { SystemPart, ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { MetaAgent } from "../meta-agent.js"
import { Model } from "../model.js"
import { Session } from "../session.js"
import { AuxiliaryReview } from "../session/auxiliary-review.js"
import { Permission } from "../permission.js"

export const Plugin = define({
  id: "opencode.meta-agent",
  effect: Effect.fn("MetaAgentPlugin")(function* (ctx) {
    const config = yield* MetaAgent.Service
    const sessions = yield* Session.Service
    const reviewer = yield* AuxiliaryReview.Service
    const permissions = yield* Permission.Service
    const reviewed = new Map<string, { message: string; feedback?: string }>()
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name: "metaagent",
          options: { codemode: false },
          description:
            "Configure optional per-step reasoning review. Enable or change it only at the user's request. A base prompt defines the review lens.",
          input: Schema.Struct({
            action: Schema.Literals(["get", "set", "clear"]),
            enabled: Schema.optionalKey(Schema.Boolean),
            base_prompt: Schema.optionalKey(Schema.String),
            model: Schema.optionalKey(Schema.String),
          }),
          output: Schema.Struct({ config: Schema.optionalKey(MetaAgent.Info) }),
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permissions.assert({
                action: "metaagent",
                resources: [input.action],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              if (input.action === "clear") {
                yield* config.clear(context.sessionID)
                reviewed.delete(context.sessionID)
                return { output: {} }
              }
              const modelName = input.model
              const model = modelName
                ? yield* Effect.try({
                    try: () => Model.Ref.parse(modelName),
                    catch: () => new ToolFailure({ message: "Invalid reviewer model reference." }),
                  })
                : undefined
              const current =
                input.action === "set"
                  ? yield* config.set({
                      sessionID: context.sessionID,
                      enabled: input.enabled,
                      basePrompt: input.base_prompt,
                      model,
                    })
                  : yield* config.get(context.sessionID)
              if (input.action === "set") reviewed.delete(context.sessionID)
              return { output: current ? { config: current } : {} }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: "Unable to configure reasoning review", error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const current = yield* config.get(event.sessionID)
        if (!current?.enabled) return
        if (current.basePrompt) event.system.push(SystemPart.make(current.basePrompt))
        const latest = (yield* sessions.messages({
          sessionID: event.sessionID,
          type: "assistant",
          order: "desc",
          limit: 1,
        }))[0]
        if (!latest || latest.type !== "assistant" || latest.time.completed === undefined) return
        const previous = reviewed.get(event.sessionID)
        const feedback =
          previous?.message === latest.id
            ? previous.feedback
            : yield* reviewer.run({
                sessionID: event.sessionID,
                agent: "reasoning-reviewer",
                model: current.model,
                prompt:
                  "Judge the latest completed step against this review lens. Reply with exactly REVIEW_OK if sound and on track; otherwise give a short actionable course correction.\n\n" +
                  (current.basePrompt || "Evaluate correctness, evidence and progress toward the user's request."),
              })
        reviewed.set(event.sessionID, { message: latest.id, feedback })
        if (feedback && feedback !== "REVIEW_OK")
          event.system.push(SystemPart.make("Reasoning reviewer feedback:\n" + feedback))
      }).pipe(Effect.catch((error) => Effect.logWarning("Reasoning review unavailable", { error }))),
    )
  }),
})
