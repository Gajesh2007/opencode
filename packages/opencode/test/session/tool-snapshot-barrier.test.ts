import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option, Schema } from "effect"
import { Collaboration } from "../../src/agent/collaboration"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session/session"
import { MessageID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionTools } from "../../src/session/tools"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"

const ran: string[] = []
const started = { mutate: Deferred.makeUnsafe<void>() }

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
        Effect.succeed(
          (["mutate", "inspect"] as const).map((id) => ({
            id,
            description: id,
            readOnly: id === "inspect",
            parameters: Schema.Struct({}),
            execute: () =>
              Effect.gen(function* () {
                ran.push(id)
                if (id === "mutate") yield* Deferred.succeed(started.mutate, undefined)
                return { title: id, output: id, metadata: {} }
              }),
          })),
        ),
    }),
  ),
)

it.instance(
  "mutating tools wait for the carried step-start snapshot; read-only tools do not",
  () =>
    Effect.gen(function* () {
      ran.length = 0
      const session = yield* (yield* Session.Service).create({})
      const model = yield* Provider.use.getModel(ProviderID.make("test"), ModelID.make("test-model"))
      const message: MessageV2.Assistant = {
        id: MessageID.ascending(),
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
      // Stands in for the previous step's background snapshot capture.
      const captured = yield* Deferred.make<void>()
      const tools = yield* SessionTools.resolve({
        agent: { name: "build", mode: "primary", permission: [], options: {} },
        model,
        session,
        messages: [],
        bypassAgentCheck: false,
        processor: {
          message,
          ready: Deferred.await(captured),
          completeToolCall: () => Effect.void,
          updateToolCall: () => Effect.succeed(undefined),
        },
        promptOps: {
          cancel: () => Effect.void,
          resolvePromptParts: () => Effect.succeed([]),
          prompt: () => Effect.die("unexpected"),
          loop: () => Effect.die("unexpected"),
        },
      })
      const call = (name: "mutate" | "inspect") =>
        Effect.promise(() =>
          Promise.resolve(
            tools[name].execute!({}, { toolCallId: name, messages: [], abortSignal: new AbortController().signal }),
          ),
        )

      const mutate = yield* call("mutate").pipe(Effect.forkChild)
      yield* call("inspect")
      // Proving the mutation is held back needs a bounded window: an in-process
      // tool call that is not gated starts within a few milliseconds.
      const early = yield* Deferred.await(started.mutate).pipe(Effect.timeoutOption("200 millis"))
      expect(Option.isNone(early)).toBe(true)
      expect(ran).toEqual(["inspect"])

      yield* Deferred.succeed(captured, undefined)
      yield* Fiber.join(mutate)
      expect(ran).toEqual(["inspect", "mutate"])
    }),
  { config: testProviderConfig("http://localhost:1/v1") },
)
