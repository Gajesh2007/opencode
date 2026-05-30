import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { SubagentLimit } from "@/agent/subagent-limit"
import { Team } from "@/agent/team"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { ModelID, ProviderID } from "@/provider/schema"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }
const triggered: string[] = []

// A Plugin that records every hook name it is asked to fire, so we can assert the
// task tool drives the subagent lifecycle hooks.
const recordingPlugin = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    list: () => Effect.succeed([]),
    trigger: ((name: string, _input: unknown, output: unknown) =>
      Effect.sync(() => {
        triggered.push(name)
        return output
      })) as Plugin.Interface["trigger"],
  }),
)

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    SubagentLimit.defaultLayer,
    Team.defaultLayer,
    BackgroundJob.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    recordingPlugin,
    RuntimeFlags.layer({}),
  ),
)

const seed = Effect.fn("HooksTest.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Hooks" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function reply(sessionID: SessionPrompt.PromptInput["sessionID"], text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID,
      mode: "general",
      agent: "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID, type: "text", text }],
  }
}

const stubOps: TaskPromptOps = {
  cancel: () => Effect.void,
  resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
  prompt: (input) => Effect.sync(() => reply(input.sessionID, "done")),
  loop: (input) => Effect.succeed(reply(input.sessionID, "done")),
}

describe("tool.hooks", () => {
  it.instance("fires subagent.start and subagent.stop around a subagent run", () =>
    Effect.gen(function* () {
      triggered.length = 0
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()

      yield* def.execute(
        { description: "investigate", prompt: "look into it", subagent_type: "general" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(triggered).toContain("subagent.start")
      expect(triggered).toContain("subagent.stop")
      // start precedes stop
      expect(triggered.indexOf("subagent.start")).toBeLessThan(triggered.indexOf("subagent.stop"))
    }),
  )
})
