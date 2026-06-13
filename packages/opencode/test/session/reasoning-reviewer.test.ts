import { NodeFileSystem } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "@/config/config"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { ReasoningReviewer } from "../../src/session/reasoning-reviewer"
import { SessionStatus } from "../../src/session/status"
import { Snapshot } from "../../src/snapshot"
import * as Log from "@opencode-ai/core/util/log"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { SyncEvent } from "@/sync"
import { EventV2Bridge } from "@/event-v2-bridge"

void Log.init({ print: false })

const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }
// Configured reviewer model that is NOT in the test catalog — exercises the
// graceful fallback to the main model.
const unavailable = { providerID: ProviderID.make("google"), modelID: ModelID.make("gemini-3.5-flash") }

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
    },
  },
}

function providerCfg(url: string) {
  return { ...cfg, provider: { ...cfg.provider, test: { ...cfg.provider.test, options: { ...cfg.provider.test.options, baseURL: url } } } }
}

const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  LLM.defaultLayer,
  Provider.defaultLayer,
  status,
  SyncEvent.defaultLayer,
  EventV2Bridge.defaultLayer,
).pipe(Layer.provideMerge(infra))
// Use ReasoningReviewer.layer (not defaultLayer) so it shares the mock-configured
// LLM/Provider/Agent instances rather than building its own.
const env = Layer.mergeAll(TestLLMServer.layer, deps, ReasoningReviewer.layer.pipe(Layer.provide(deps)))

const it = testEffect(env)

const reviewInput = (sessionID: string, fallback: Provider.Model, reasoning: string) => ({
  sessionID: sessionID as never,
  reasoning,
  priorReasoning: "",
  basePrompt: "reason from first principles",
  model: unavailable,
  effort: "medium" as const,
  fallback,
})

it.live("session.reasoning-reviewer approves on REVIEW_OK", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const reviewer = yield* ReasoningReviewer.Service
        const provider = yield* Provider.Service
        const sessions = yield* Session.Service
        const fallback = yield* provider.getModel(ref.providerID, ref.modelID)

        yield* llm.push(reply().text("REVIEW_OK").stop())
        const chat = yield* sessions.create({})

        const verdict = yield* reviewer.review(reviewInput(chat.id, fallback, "I'll just guess."))

        expect(verdict.type).toBe("ok")
        // The configured reviewer model was unavailable, so exactly one call went to
        // the fallback (main) model.
        expect(yield* llm.calls).toBe(1)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.reasoning-reviewer redirects on a correction", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const reviewer = yield* ReasoningReviewer.Service
        const provider = yield* Provider.Service
        const sessions = yield* Session.Service
        const fallback = yield* provider.getModel(ref.providerID, ref.modelID)

        yield* llm.push(reply().text("Stop guessing — derive the answer from the base facts.").stop())
        const chat = yield* sessions.create({})

        const verdict = yield* reviewer.review(reviewInput(chat.id, fallback, "I'll just guess."))

        expect(verdict.type).toBe("redirect")
        expect(verdict.message).toContain("derive")
      }),
    { config: (url) => providerCfg(url) },
  ),
)
