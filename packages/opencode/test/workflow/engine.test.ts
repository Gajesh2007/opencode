import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { SubagentLimit } from "@/agent/subagent-limit"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { ModelID, ProviderID } from "@/provider/schema"
import { WorkflowTool } from "@/tool/workflow"
import type { TaskPromptOps } from "@/tool/task"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Layer.mergeAll(
    Agent.defaultLayer,
    SubagentLimit.defaultLayer,
    BackgroundJob.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    RuntimeFlags.layer(flags),
  )

const it = testEffect(layer())

const seed = Effect.fn("WorkflowEngineTest.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Workflow" })
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

function reply(input: { sessionID: SessionPrompt.PromptInput["sessionID"]; messageID?: MessageID }, text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
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
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  }
}

// Stub promptOps: each reviewer cell emits one finding (file+lens filled by the
// engine's parser defaults from the unit/pass); the synthesizer echoes a marker.
function stubOps(calls: SessionPrompt.PromptInput[]): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        calls.push(input)
        if (input.agent === "review-synthesizer") return reply(input, "FINAL REPORT")
        return reply(input, '[{"line":5,"severity":"high","title":"Bug","description":"d"}]')
      }),
    loop: (input) => Effect.succeed(reply({ sessionID: input.sessionID }, "done")),
  }
}

function ctx(
  sessionID: SessionPrompt.PromptInput["sessionID"],
  messageID: MessageID,
  promptOps: TaskPromptOps,
): Tool.Context {
  return {
    sessionID,
    messageID,
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps, bypassAgentCheck: true },
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("workflow.engine", () => {
  it.instance("defaults subagent concurrency to 200", () =>
    Effect.gen(function* () {
      const limit = yield* SubagentLimit.Service
      expect(yield* limit.cap).toBe(200)
    }),
  )

  it.instance("fans out units x passes, dedupes findings across lenses, and synthesizes", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* WorkflowTool).init()
      const calls: SessionPrompt.PromptInput[] = []

      const result = yield* def.execute(
        {
          description: "review 2 files",
          units: [
            { id: "a.ts", context: "changes in a" },
            { id: "b.ts", context: "changes in b" },
          ],
          passes: [
            { name: "security", agent: "review-security", prompt: "Review {unit_id} for security. {unit_context}" },
            { name: "logic", agent: "review-logic", prompt: "Review {unit_id} for logic. {unit_context}" },
          ],
          synthesis: { agent: "review-synthesizer", prompt: "Synthesize all findings." },
          format: "findings",
        },
        ctx(chat.id, assistant.id, stubOps(calls)),
      )

      // 2 units x 2 passes = 4 reviewer cells + 1 synthesis
      expect(calls.length).toBe(5)
      expect(calls.filter((c) => c.agent !== "review-synthesizer").length).toBe(4)

      // placeholder substitution reached the reviewer prompt
      const firstCell = calls.find((c) => c.agent === "review-security")
      const cellText = firstCell?.parts.find((p) => p.type === "text")?.text ?? ""
      expect(cellText).toContain("a.ts")
      expect(cellText).toContain("changes in a")

      // synthesizer received the deterministically aggregated + ranked findings
      const synth = calls.find((c) => c.agent === "review-synthesizer")
      const synthText = synth?.parts.find((p) => p.type === "text")?.text ?? ""
      expect(synthText).toContain("agreement") // each file reported by both lenses
      expect(synthText).toContain("high")

      // the synthesizer's report is surfaced as the tool output
      expect(result.output).toContain("FINAL REPORT")
      expect(result.output).toContain("cells: 4")
    }),
  )

  it.instance("rejects an oversized grid before spawning anything", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* WorkflowTool).init()
      const calls: SessionPrompt.PromptInput[] = []
      const units = Array.from({ length: 11000 }, (_, i) => ({ id: `f${i}.ts` }))

      const result = yield* def.execute(
        {
          description: "too big",
          units,
          passes: [
            { name: "security", agent: "review-security", prompt: "x" },
            { name: "logic", agent: "review-logic", prompt: "y" },
          ],
          format: "findings",
        },
        ctx(chat.id, assistant.id, stubOps(calls)),
      )

      expect(calls.length).toBe(0)
      expect(result.output).toContain("exceeding")
    }),
  )
})
