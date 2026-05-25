import { Effect, Layer, Context, Stream } from "effect"
import { LLM } from "./llm"
import { Agent } from "../agent/agent"
import { Provider } from "@/provider/provider"
import type { Goal } from "./goal"
import { MessageV2 } from "./message-v2"
import { MessageID, type SessionID } from "./schema"
import type { ProviderID, ModelID } from "@/provider/schema"
import { LLMEvent } from "@opencode-ai/llm"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "steering" })

export interface SteerResult {
  readonly type: "continue" | "complete" | "blocked"
  readonly message: string
}

type SteerInput = {
  readonly sessionID: SessionID
  readonly goal: Goal.Info
  readonly providerID: ProviderID
  readonly modelID: ModelID
}

export class Service extends Context.Service<Service, {
  readonly steer: (input: SteerInput) => Effect.Effect<SteerResult>
}>()("@opencode/Steering") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const agents = yield* Agent.Service
    const prov = yield* Provider.Service

    const steer = Effect.fn("Steering.steer")(function* (input: SteerInput): Generator<any, SteerResult, any> {
      const ag = yield* agents.get("steer")
      if (!ag) {
        log.warn("steer agent not found, falling back to template continuation")
        return { type: "continue", message: "" }
      }

      // Use the same model the main chat is using so the steering agent has
      // equivalent capability to understand the work being done.
      const mdl = yield* prov.getModel(input.providerID, input.modelID)

      const allMsgs = yield* MessageV2.filterCompactedEffect(input.sessionID)
      const recentMsgs = allMsgs.slice(-10)
      const modelMsgs = yield* MessageV2.toModelMessagesEffect(recentMsgs, mdl)

      const steerPrompt = [
        "<goal_objective>",
        input.goal.objective,
        "</goal_objective>",
        "",
        `Tokens used: ${input.goal.tokensUsed}${input.goal.tokenBudget ? ` / ${input.goal.tokenBudget}` : ""}`,
        "",
        "Read the conversation above. Inspect the codebase if needed. Then produce your steering message.",
      ].join("\n")

      const user: MessageV2.User = {
        id: MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        agent: "steer",
        model: { providerID: mdl.providerID, modelID: mdl.id },
        time: { created: Date.now() },
      }

      const text = yield* llm
        .stream({
          agent: ag,
          user,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.sessionID,
          retries: 1,
          messages: [...modelMsgs, { role: "user" as const, content: steerPrompt }],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )

      const cleaned = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim()
      log.info("steering result", { text: cleaned.slice(0, 200) })

      if (cleaned === "GOAL_COMPLETE") return { type: "complete", message: cleaned }
      if (cleaned === "GOAL_BLOCKED") return { type: "blocked", message: cleaned }
      return { type: "continue", message: cleaned }
    })

    return Service.of({
      steer: (input: SteerInput) => steer(input).pipe(Effect.orDie) as Effect.Effect<SteerResult>,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Provider.defaultLayer),
  ),
)

export * as Steering from "./steering"
