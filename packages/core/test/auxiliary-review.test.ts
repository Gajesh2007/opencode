import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { AuxiliaryReview } from "@opencode/core/session/auxiliary-review"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Agent } from "@opencode/core/agent"
import { Goal } from "@opencode/core/goal"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { promptLocationNode } from "./fixture/prompt-location"
import { globalProjectNode } from "./lib/project"
import { testEffect } from "./lib/effect"

const resolved = SessionRunnerModel.resolved(
  LanguageModel.make({ id: "test", provider: "test", route: OpenAIChat.route }),
  {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 10000, output: 4000 },
  },
)
const testLLM = TestLLM.layer({})
const it = testEffect(
  Layer.merge(
    testLLM,
    AppNodeBuilder.build(LayerNode.group([AuxiliaryReview.node, Session.node, Goal.node, Agent.node]), [
      LocationServiceMap.node.replace(promptLocationNode),
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      LayerNodePlatform.llmClient.replace(TestLLM.clientLayer.pipe(Layer.provide(testLLM))),
      ModelResolver.node.replace(
        Layer.succeed(ModelResolver.Service, {
          resolve: () => Effect.succeed(resolved),
          resolveModel: () => Effect.succeed(resolved),
        }),
      ),
    ]),
  ),
)

it.effect("reviews child history and accounts auxiliary usage against the root goal", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const goals = yield* Goal.Service
    const reviewer = yield* AuxiliaryReview.Service
    const llm = yield* TestLLM.Service
    const root = yield* sessions.create({ location: { directory: AbsolutePath.make("/auxiliary-review") } })
    const child = yield* sessions.create({ parentID: root.id })
    yield* goals.create({ sessionID: root.id, objective: "Verify the implementation", tokenBudget: 100 })
    yield* sessions.prompt({ sessionID: child.id, text: "Check the actual files", resume: false })
    yield* llm.push(TestLLM.textWithUsage("REVIEW_OK", "review", 25))
    expect(yield* reviewer.run({ sessionID: child.id, agent: "reasoning-reviewer", prompt: "Check correctness" })).toBe(
      "REVIEW_OK",
    )
    expect((yield* goals.get(root.id))?.tokensUsed).toBe(25)
    expect(llm.requests[0].tools).toHaveLength(1)
  }),
)
