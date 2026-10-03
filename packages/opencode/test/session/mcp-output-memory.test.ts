import { expect } from "bun:test"
import { heapStats } from "bun:jsc"
import { randomBytes } from "node:crypto"
import { dynamicTool, jsonSchema } from "ai"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Collaboration } from "../../src/agent/collaboration"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session/session"
import { MessageID } from "../../src/session/schema"
import { SessionTools } from "../../src/session/tools"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { isRecord } from "../../src/util/record"
import { testEffect } from "../lib/effect"

const hooks: { name: string; raw: boolean }[] = []
const payload = { bytes: 0, media: false }
const config = {
  enabled_providers: ["test"],
  provider: {
    test: {
      name: "Test",
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
      models: {
        test: {
          name: "Test",
          limit: { context: 100_000, output: 10_000 },
          cost: { input: 0, output: 0 },
        },
      },
    },
  },
}

const it = testEffect(
  Layer.mergeAll(
    Session.defaultLayer,
    Provider.defaultLayer,
    Truncate.defaultLayer,
    AppFileSystem.defaultLayer,
    Layer.mock(ToolRegistry.Service, { tools: () => Effect.succeed([]) }),
    Layer.mock(Permission.Service, { ask: () => Effect.void }),
    Layer.mock(Collaboration.Service, { member: () => Effect.succeed(undefined) }),
    Layer.mock(Plugin.Service, {
      trigger: (name, _input, output) =>
        Effect.sync(() => {
          hooks.push({ name, raw: isRecord(output) && Array.isArray(output.content) })
          return output
        }),
    }),
    Layer.mock(MCP.Service, {
      tools: () =>
        Effect.sync(() => ({
          test_lookup: dynamicTool({
            description: "Synthetic MCP result",
            inputSchema: jsonSchema({ type: "object", properties: {} }),
            execute: async () => ({
              content: [
                { type: "text", text: payload.bytes ? randomBytes(payload.bytes).toString("base64") : "answer" },
                ...(payload.media
                  ? [
                      { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
                      { type: "resource", resource: { uri: "file:///fixture.txt", text: "resource text" } },
                      {
                        type: "resource",
                        resource: { uri: "file:///fixture.pdf", mimeType: "application/pdf", blob: "cGRm" },
                      },
                    ]
                  : []),
              ],
              metadata: { source: "fixture" },
            }),
          }),
        })),
    }),
  ),
)

const execute = Effect.fnUntraced(function* () {
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ title: "MCP memory fixture" })
  yield* Effect.addFinalizer(() => sessions.remove(session.id).pipe(Effect.ignore))
  const model = yield* Provider.use.getModel(ProviderID.make("test"), ModelID.make("test"))
  const id = MessageID.ascending()
  const tools = yield* SessionTools.resolve({
    agent: { name: "build", mode: "primary", permission: [], options: {} },
    model,
    session,
    messages: [],
    bypassAgentCheck: false,
    processor: {
      message: {
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
      },
      updateToolCall: () => Effect.succeed(undefined),
      completeToolCall: () => Effect.void,
    },
    promptOps: {
      cancel: () => Effect.void,
      resolvePromptParts: () => Effect.succeed([]),
      prompt: () => Effect.die("unexpected prompt"),
      loop: () => Effect.die("unexpected loop"),
    },
  })
  const tool = tools.test_lookup
  if (!tool.execute) return yield* Effect.die("missing MCP execute")
  return (input: object, signal = new AbortController().signal) =>
    Effect.promise(() =>
      Promise.resolve(tool.execute?.(input, { toolCallId: "call_fixture", messages: [], abortSignal: signal })),
    )
})

it.instance(
  "MCP normalization preserves plugin results, metadata, and attachments",
  () =>
    Effect.gen(function* () {
      payload.bytes = 0
      payload.media = true
      hooks.length = 0
      const run = yield* execute()
      const result = yield* run({})
      if (!isRecord(result)) throw new Error("missing normalized output")
      expect(result.output).toBe("answer\n\nresource text")
      expect(result.content).toBeUndefined()
      expect(result.metadata).toMatchObject({ source: "fixture", truncated: false })
      expect(result.attachments).toMatchObject([
        { mime: "image/png", url: "data:image/png;base64,aW1hZ2U=" },
        { mime: "application/pdf", url: "data:application/pdf;base64,cGRm", filename: "file:///fixture.pdf" },
      ])
      expect(hooks).toEqual([
        { name: "tool.execute.before", raw: false },
        { name: "tool.execute.after", raw: true },
      ])
    }),
  { config },
)

it.instance(
  "truncated MCP results retain the artifact reference instead of raw content",
  () =>
    Effect.gen(function* () {
      payload.bytes = 768 * 1024
      payload.media = false
      hooks.length = 0
      const run = yield* execute()
      const result = yield* run({})
      if (!isRecord(result) || !isRecord(result.metadata)) throw new Error("missing normalized output")
      expect(result.content).toBeUndefined()
      expect(result.metadata.truncated).toBe(true)
      expect(hooks.at(-1)).toEqual({ name: "tool.execute.after", raw: true })
      if (typeof result.metadata.outputPath !== "string") throw new Error("missing saved output")
      expect(Number((yield* (yield* AppFileSystem.Service).stat(result.metadata.outputPath)).size)).toBe(1024 * 1024)
    }),
  { config },
)

const memory = () => {
  Bun.gc(true)
  Bun.gc(true)
  const heap = heapStats()
  return { heap: heap.heapSize, external: heap.extraMemorySize, rss: process.memoryUsage().rss }
}

const bench = process.env.OPENCODE_BENCH_MCP_OUTPUT ? it.instance : it.instance.skip
bench(
  "benchmark normalized MCP result retention",
  () =>
    Effect.gen(function* () {
      payload.bytes = 0
      payload.media = false
      const run = yield* execute()
      yield* run({})
      yield* Effect.promise(() => Bun.sleep(0))
      const before = memory()
      payload.bytes = 24 * 1024 * 1024
      const result = yield* run({})
      // Let resolved I/O promises and execution continuations release temporary payloads.
      yield* Effect.promise(() => Bun.sleep(0))
      const after = memory()
      if (!isRecord(result) || typeof result.output !== "string" || !isRecord(result.metadata)) {
        throw new Error("missing normalized output")
      }
      console.log(
        JSON.stringify({
          benchmark: "mcp-normalized-output",
          trial: process.env.OPENCODE_BENCH_TRIAL,
          rawBytes: (payload.bytes * 4) / 3,
          normalizedChars: result.output.length,
          heapGrowthMiB: (after.heap - before.heap) / 1024 / 1024,
          externalGrowthMiB: (after.external - before.external) / 1024 / 1024,
          rssGrowthMiB: (after.rss - before.rss) / 1024 / 1024,
          carriesRawContent: Array.isArray(result.content),
        }),
      )
      expect(result.metadata.truncated).toBe(true)
      if (typeof result.metadata.outputPath !== "string") throw new Error("missing saved output")
      expect(Number((yield* (yield* AppFileSystem.Service).stat(result.metadata.outputPath)).size)).toBe(
        (payload.bytes * 4) / 3,
      )
    }),
  { config },
  { timeout: 30_000 },
)
