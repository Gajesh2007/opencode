import { expect } from "bun:test"
import { Effect } from "effect"
import { MetaAgent } from "@opencode/core/meta-agent"
import { Session } from "@opencode/core/session"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(MetaAgent.node))
it.effect("keeps the review lens and model while toggling review", () =>
  Effect.gen(function* () {
    const review = yield* MetaAgent.Service
    const sessionID = Session.ID.make("ses_reviewer")
    expect(yield* review.get(sessionID)).toBeUndefined()
    const model = Model.Ref.make({
      id: Model.ID.make("small"),
      providerID: Provider.ID.make("test"),
      variant: Model.VariantID.make("high"),
    })
    yield* review.set({ sessionID, basePrompt: "Check every assumption", model })
    expect(yield* review.set({ sessionID, enabled: false })).toMatchObject({
      enabled: false,
      basePrompt: "Check every assumption",
      model,
    })
    expect(yield* review.set({ sessionID, enabled: true })).toMatchObject({ enabled: true, model })
    yield* review.clear(sessionID)
    expect(yield* review.get(sessionID)).toBeUndefined()
  }),
)
