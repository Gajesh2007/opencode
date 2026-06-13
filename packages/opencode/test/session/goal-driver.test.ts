import { NodeFileSystem } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "@/config/config"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { Goal } from "../../src/session/goal"
import { Steering } from "../../src/session/steering"
import { SessionPrompt } from "../../src/session/prompt"
import { GoalDriver } from "../../src/session/goal-driver"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Snapshot } from "../../src/snapshot"
import * as Log from "@opencode-ai/core/util/log"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { SyncEvent } from "@/sync"
import { EventV2Bridge } from "@/event-v2-bridge"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

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

// Controllable fakes — reset per test. The driver's decision logic is what we
// exercise here; real steering (an LLM call) and real re-prompting are stubbed.
let steerOutcome: Steering.SteerResult = { type: "continue", message: "" }
let loopCalls: string[] = []

const fakeSteering = Layer.succeed(
  Steering.Service,
  Steering.Service.of({ steer: () => Effect.succeed(steerOutcome) }),
)
const fakeSessionPrompt = Layer.succeed(
  SessionPrompt.Service,
  SessionPrompt.Service.of({
    cancel: () => Effect.void,
    prompt: () => Effect.succeed({} as MessageV2.WithParts),
    loop: (input) =>
      Effect.sync(() => {
        loopCalls.push(input.sessionID)
        return {} as MessageV2.WithParts
      }),
    shell: () => Effect.succeed({} as MessageV2.WithParts),
    command: () => Effect.succeed({} as MessageV2.WithParts),
    resolvePromptParts: () => Effect.succeed([]),
  }),
)

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
  Goal.defaultLayer,
).pipe(Layer.provideMerge(infra))
const driverDeps = Layer.mergeAll(deps, fakeSteering, fakeSessionPrompt)
const env = Layer.mergeAll(TestLLMServer.layer, driverDeps, GoalDriver.layer.pipe(Layer.provide(driverDeps)))

const it = testEffect(env)

const boot = Effect.fn("test.boot")(function* () {
  const driver = yield* GoalDriver.Service
  const goals = yield* Goal.Service
  const sessions = yield* Session.Service
  return { driver, goals, sessions }
})

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text })
  return msg
})

const assistant = Effect.fn("test.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
  opts?: { tokens?: number; cost?: number },
) {
  const session = yield* Session.Service
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: opts?.cost ?? 0,
    tokens: { total: 0, input: opts?.tokens ?? 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

// Set up a session with one finished assistant turn and an active goal.
const setup = Effect.fn("test.setup")(function* (dir: string, goalInput?: { tokenBudget?: number; costBudget?: number }, turn?: { tokens?: number; cost?: number }) {
  const { driver, goals, sessions } = yield* boot()
  const chat = yield* sessions.create({})
  const u = yield* user(chat.id, "do the thing")
  yield* assistant(chat.id, u.id, path.resolve(dir), turn)
  yield* goals.create({ sessionID: chat.id, objective: "finish the thing", ...goalInput })
  return { driver, goals, sessions, chat }
})

it.live("session.goal-driver continues an active goal by re-prompting", () =>
  provideTmpdirServer(
    ({ dir }) =>
      Effect.gen(function* () {
        loopCalls = []
        steerOutcome = { type: "continue", message: "keep going" }
        const { driver, goals, chat } = yield* setup(dir)

        yield* driver.onIdle(chat.id)

        expect(loopCalls).toEqual([chat.id])
        const goal = yield* goals.get(chat.id)
        expect(goal?.status).toBe("active")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.goal-driver stops when steering reports the goal complete", () =>
  provideTmpdirServer(
    ({ dir }) =>
      Effect.gen(function* () {
        loopCalls = []
        steerOutcome = { type: "complete", message: "GOAL_COMPLETE" }
        const { driver, goals, chat } = yield* setup(dir)

        yield* driver.onIdle(chat.id)

        expect(loopCalls).toEqual([])
        const goal = yield* goals.get(chat.id)
        expect(goal?.status).toBe("completed")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.goal-driver stops at the budget limit without re-prompting", () =>
  provideTmpdirServer(
    ({ dir }) =>
      Effect.gen(function* () {
        loopCalls = []
        steerOutcome = { type: "continue", message: "keep going" }
        // Goal budget is 100 tokens; the finished turn already used 150.
        const { driver, goals, chat } = yield* setup(dir, { tokenBudget: 100 }, { tokens: 150 })

        yield* driver.onIdle(chat.id)

        expect(loopCalls).toEqual([])
        const goal = yield* goals.get(chat.id)
        expect(goal?.status).toBe("budget_limited")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.goal-driver blocks after consecutive blocked verdicts", () =>
  provideTmpdirServer(
    ({ dir }) =>
      Effect.gen(function* () {
        loopCalls = []
        steerOutcome = { type: "blocked", message: "GOAL_BLOCKED" }
        const { driver, goals, sessions, chat } = yield* setup(dir)
        const root = path.resolve(dir)

        // Each idle needs a fresh finished assistant turn after the latest user
        // message (the driver injects a synthetic user message on continue).
        for (let i = 0; i < 3; i++) {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const lastUser = MessageV2.latest(msgs).user!
          yield* assistant(chat.id, lastUser.id, root)
          yield* driver.onIdle(chat.id)
        }

        const goal = yield* goals.get(chat.id)
        expect(goal?.status).toBe("blocked")
        // Two continues (turns 1 and 2), then blocked on turn 3 — no re-prompt.
        expect(loopCalls.length).toBe(2)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.goal-driver is a no-op when no goal is active", () =>
  provideTmpdirServer(
    ({ dir }) =>
      Effect.gen(function* () {
        loopCalls = []
        steerOutcome = { type: "continue", message: "keep going" }
        const { driver, sessions } = yield* boot()
        const chat = yield* sessions.create({})
        const u = yield* user(chat.id, "no goal here")
        yield* assistant(chat.id, u.id, path.resolve(dir))

        yield* driver.onIdle(chat.id)

        expect(loopCalls).toEqual([])
      }),
    { config: (url) => providerCfg(url) },
  ),
)
