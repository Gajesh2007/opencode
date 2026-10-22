import { expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Collaboration } from "../../src/agent/collaboration"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session/session"
import { MessageID, PartID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionTools } from "../../src/session/tools"
import { SessionTiming } from "../../src/session/timing"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"

const it = testEffect(
  Layer.mergeAll(
    Session.defaultLayer,
    Provider.defaultLayer,
    Truncate.defaultLayer,
    Layer.mock(MCP.Service, { tools: () => Effect.succeed({}) }),
    Layer.mock(Permission.Service, { ask: () => Effect.void }),
    Layer.mock(Collaboration.Service, { member: () => Effect.succeed(undefined) }),
    Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
    Layer.mock(ToolRegistry.Service, {
      tools: () =>
        Effect.succeed([
          {
            id: "timed",
            description: "metadata timing regression",
            parameters: Schema.Struct({}),
            execute: (_args, ctx) =>
              Effect.gen(function* () {
                yield* ctx.metadata({ title: "first", metadata: { progress: 1 } })
                yield* ctx.metadata({ title: "second", metadata: { progress: 2 } })
                return { title: "done", output: "done", metadata: {} }
              }),
          },
        ]),
    }),
  ),
)

for (const status of ["pending", "running"] as const) {
  it.instance(
    `metadata preserves ${status} tool execution start through repeated updates`,
    () =>
      Effect.gen(function* () {
        const session = yield* (yield* Session.Service).create({})
        const model = yield* Provider.use.getModel(ProviderID.make("test"), ModelID.make("test-model"))
        const id = MessageID.ascending()
        const message: MessageV2.Assistant = {
          id,
          role: "assistant",
          sessionID: session.id,
          parentID: MessageID.ascending(),
          agent: "build",
          mode: "build",
          modelID: model.id,
          providerID: model.providerID,
          time: { created: 0 },
          path: { cwd: "/", root: "/" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
        }
        let part: MessageV2.ToolPart = {
          id: PartID.ascending(),
          messageID: id,
          sessionID: session.id,
          type: "tool",
          tool: "timed",
          callID: "call",
          state: status === "pending" ? { status, input: {}, raw: "" } : { status, input: {}, time: { start: 123 } },
        }
        const starts: number[] = []
        const records: SessionTiming.Record[] = []
        const timing = SessionTiming.start({ sessionID: session.id, messageID: id }, { emit: (r) => records.push(r) })
        timing.request()
        const tools = yield* SessionTools.resolve({
          agent: { name: "build", mode: "primary", permission: [], options: {} },
          model,
          session,
          messages: [],
          bypassAgentCheck: false,
          processor: {
            message,
            timing,
            completeToolCall: () => Effect.void,
            updateToolCall: (_id, update) =>
              Effect.sync(() => {
                part = update(part)
                if (part.state.status === "running") starts.push(part.state.time.start)
                return part
              }),
          },
          promptOps: {
            cancel: () => Effect.void,
            resolvePromptParts: () => Effect.succeed([]),
            prompt: () => Effect.die("unexpected"),
            loop: () => Effect.die("unexpected"),
          },
        })
        const execute = tools.timed.execute
        if (!execute) throw new Error("missing timed tool")
        yield* Effect.promise(() =>
          Promise.resolve(execute({}, { toolCallId: "call", messages: [], abortSignal: new AbortController().signal })),
        )
        expect(starts).toHaveLength(2)
        expect(starts[0]).toBe(starts[1])
        if (status === "running") expect(starts[0]).toBe(123)
        expect(part.state).toMatchObject({ title: "second", metadata: { progress: 2 } })
        expect(records.filter((r) => r.phase === "tool")).toMatchObject([{ callID: "call", status: "completed" }])
      }),
    { config: testProviderConfig("http://localhost:1/v1") },
  )
}
