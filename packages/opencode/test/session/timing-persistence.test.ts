import { expect } from "bun:test"
import { Cause, ConfigProvider, Context, Effect, Exit, Fiber, Latch, Layer, Schema, Stream } from "effect"
import { ChildProcessSpawner, make as makeSpawner, makeHandle } from "effect/unstable/process/ChildProcessSpawner"
import { eq } from "drizzle-orm"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import { Agent } from "@/agent/agent"
import { Collaboration } from "@/agent/collaboration"
import { Auth } from "@/auth"
import { Bus } from "@/bus"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Image } from "@/image/image"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Memory } from "@/memory/memory"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Reference } from "@/reference/reference"
import { SessionCompaction } from "@/session/compaction"
import { Goal } from "@/session/goal"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { MetaAgent } from "@/session/metaagent"
import { MessageV2 } from "@/session/message-v2"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { ReasoningReviewer } from "@/session/reasoning-reviewer"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { SystemPrompt } from "@/session/system"
import { SessionTimingStore } from "@/session/timing-store"
import { TimingTable } from "@/session/timing.sql"
import { SessionTools } from "@/session/tools"
import { Snapshot } from "@/snapshot"
import { Database } from "@/storage/db"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

const privateData = {
  prompt: "TIMING_PRIVATE_PROMPT",
  system: "TIMING_PRIVATE_SYSTEM",
  args: "TIMING_PRIVATE_ARGUMENTS",
  output: "TIMING_PRIVATE_TOOL_OUTPUT",
  text: "TIMING_PRIVATE_ASSISTANT_TEXT",
  metadata: "TIMING_PRIVATE_METADATA",
  apiKey: "TIMING_PRIVATE_API_KEY",
  error: "TIMING_PRIVATE_PROVIDER_ERROR",
}
const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }
const parameters = Schema.Struct({ value: Schema.String })

function services(flags = RuntimeFlags.layer({ disableTiming: false, experimentalNativeLlm: false })) {
  const dependencies = Layer.mergeAll(
    flags,
    Auth.defaultLayer,
    Config.defaultLayer,
    Provider.defaultLayer,
    Plugin.defaultLayer,
    Permission.defaultLayer,
    Session.defaultLayer,
    Agent.defaultLayer,
    Collaboration.defaultLayer,
    Snapshot.defaultLayer,
    SessionSummary.defaultLayer,
    SessionStatus.defaultLayer,
    Image.defaultLayer,
    Bus.layer,
    EventV2Bridge.defaultLayer,
    Truncate.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    TestLLMServer.layer,
    Layer.mock(MCP.Service, { tools: () => Effect.succeed({}) }),
    Layer.mock(ToolRegistry.Service, {
      tools: () =>
        Effect.succeed([
          {
            id: "timing_probe",
            description: "A deterministic local tool for timing integration tests",
            parameters,
            execute: (args, ctx) =>
              Effect.gen(function* () {
                yield* ctx.ask({
                  permission: "timing_probe",
                  patterns: [Schema.decodeUnknownSync(parameters)(args).value],
                  always: ["*"],
                  metadata: { secret: privateData.metadata },
                })
                yield* ctx.metadata({ title: privateData.metadata, metadata: { secret: privateData.metadata } })
                return {
                  title: privateData.metadata,
                  output: privateData.output,
                  metadata: { secret: privateData.metadata },
                }
              }),
          },
        ]),
    }),
  )
  const llm = LLM.layer.pipe(
    Layer.provideMerge(dependencies),
    Layer.provide(
      LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
    ),
  )
  return SessionProcessor.layer.pipe(Layer.provideMerge(llm))
}

const config = (url: string) => {
  const cfg = testProviderConfig(url)
  return {
    ...cfg,
    snapshot: false,
    enabled_providers: ["test"],
    provider: {
      test: { ...cfg.provider.test, options: { ...cfg.provider.test.options, apiKey: privateData.apiKey } },
    },
  }
}

const localStream = Effect.fn("TimingPersistence.localStream")(function* (frames: readonly unknown[]) {
  const requests: string[] = []
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          requests.push(new URL(request.url).pathname)
          return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          })
        },
      }),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  )
  return { url: `http://127.0.0.1:${server.port}/v1`, requests }
})

const fixture = Effect.fn("TimingPersistence.fixture")(function* (
  action: "allow" | "ask" = "allow",
  processors?: SessionProcessor.Interface,
) {
  // The agent runner may bypass permissions; these tests must exercise the ruleset.
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      ["OPENCODE_YOLO", "OPENCODE_YOLO_FOREVER", "OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS"].map((key) => {
        const value = process.env[key]
        delete process.env[key]
        return [key, value] as const
      }),
    ),
    (values) =>
      Effect.sync(() => {
        for (const [key, value] of values) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )
  const sessions = yield* Session.Service
  const session = yield* sessions.create({})
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => SessionTimingStore.flush()).pipe(Effect.andThen(sessions.remove(session.id)), Effect.orDie),
  )
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user",
    agent: "build",
    model: { ...model, variant: "high" },
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: session.id,
    messageID: user.id,
    type: "text",
    text: privateData.prompt,
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    sessionID: session.id,
    parentID: user.id,
    role: "assistant",
    agent: "build",
    mode: "build",
    modelID: model.modelID,
    providerID: model.providerID,
    path: { cwd: session.directory, root: session.directory },
    time: { created: Date.now() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  yield* sessions.updateMessage(assistant)
  const selected = yield* (yield* Provider.Service).getModel(model.providerID, model.modelID)
  const processor = yield* (processors ?? (yield* SessionProcessor.Service)).create({
    sessionID: session.id,
    assistantMessage: assistant,
    model: selected,
  })
  const agent: Agent.Info = {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action }],
  }
  const tools = yield* SessionTools.resolve({
    agent,
    model: selected,
    session,
    processor,
    messages: [],
    bypassAgentCheck: false,
    promptOps: {
      cancel: () => Effect.void,
      resolvePromptParts: () => Effect.succeed([]),
      prompt: () => Effect.die("unexpected nested prompt"),
      loop: () => Effect.die("unexpected nested loop"),
    },
  })
  return {
    session,
    processor,
    input: {
      user,
      sessionID: session.id,
      model: selected,
      agent,
      system: [privateData.system],
      messages: [{ role: "user", content: privateData.prompt }],
      tools,
      retries: 0,
    } satisfies LLM.StreamInput,
    rows() {
      SessionTimingStore.flush()
      return Database.use((db) => db.select().from(TimingTable).where(eq(TimingTable.session_id, session.id)).all())
    },
  }
})

const it = testEffect(services())

it.live("persists real text and auto-allowed tool spans without transcript content or artificial approval waits", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const f = yield* fixture()
        yield* llm.push(reply().text(privateData.text).tool("timing_probe", { value: privateData.args }))
        expect(yield* f.processor.process(f.input)).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        const rows = f.rows()
        expect(new Set(rows.map((row) => row.execution_id))).toEqual(new Set([f.processor.timing.executionID]))
        expect(
          rows.every((row) => row.step_id === f.processor.message.id && row.root_session_id === f.session.id),
        ).toBe(true)
        expect(rows.map((row) => row.phase)).toEqual(
          expect.arrayContaining([
            "execution_start",
            "preparation",
            "request_start",
            "request_prepared",
            "first_text",
            "tool_input_start",
            "tool_ready",
            "tool_start",
            "tool",
            "request",
            "overall",
          ]),
        )
        expect(rows.find((row) => row.phase === "first_text")?.data).toMatchObject({
          providerID: model.providerID,
          modelID: model.modelID,
          runtime: "ai-sdk",
          attemptScope: "logical",
          anchor: "request_start",
        })
        expect(rows.find((row) => row.phase === "first_text")?.data.durationMs).toBeGreaterThanOrEqual(0)
        const tool = rows.find((row) => row.phase === "tool")
        expect(tool?.data).toMatchObject({
          tool: "timing_probe",
          callID: "call_1",
          status: "completed",
        })
        expect(tool?.data.durationMs).toBeGreaterThanOrEqual(0)
        expect(tool?.data.requestID).toBe(rows.find((row) => row.phase === "first_text")?.data.requestID)
        expect(rows.find((row) => row.phase === "overall")?.data.status).toBe("completed")
        expect(rows.filter((row) => row.phase.startsWith("approval"))).toHaveLength(0)
        expect(rows.filter((row) => !((row.data.elapsedMs ?? -1) >= 0 && (row.data.durationMs ?? 0) >= 0))).toEqual([])
        const serialized = JSON.stringify(rows)
        for (const secret of Object.values(privateData)) expect(serialized).not.toContain(secret)
        const messages = yield* (yield* Session.Service).messages({ sessionID: f.session.id })
        expect(JSON.stringify(messages)).toContain(privateData.prompt)
        expect(JSON.stringify(messages)).toContain(privateData.output)
      }),
    { config },
  ),
)

it.live("an auxiliary LLM stream owns a distinct persisted execution without a processor", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const f = yield* fixture()
        yield* llm.text(privateData.text)
        yield* f.processor.process(f.input)
        const before = f.rows()
        yield* llm.text("auxiliary result")
        const events = yield* (yield* LLM.Service)
          .stream({ ...f.input, small: true, tools: {} })
          .pipe(Stream.runCollect)
        expect(events.some((event) => event.type === "text-delta" && event.text === "auxiliary result")).toBe(true)
        const rows = f.rows()
        expect(rows.filter((row) => row.execution_id === f.processor.timing.executionID)).toEqual(before)
        const auxiliary = rows.filter((row) => row.execution_id !== f.processor.timing.executionID)
        expect(new Set(rows.map((row) => row.execution_id)).size).toBe(2)
        expect(auxiliary.every((row) => row.step_id === f.input.user.id && row.root_session_id === f.session.id)).toBe(
          true,
        )
        expect(auxiliary.find((row) => row.phase === "first_text")?.data).toMatchObject({
          providerID: model.providerID,
          modelID: model.modelID,
          purpose: "auxiliary",
          runtime: "ai-sdk",
        })
        expect(auxiliary.find((row) => row.phase === "first_text")?.data).not.toHaveProperty("variant")
        expect(auxiliary.filter((row) => row.phase === "overall")).toMatchObject([{ data: { status: "completed" } }])
        expect(yield* llm.calls).toBe(2)
      }),
    { config },
  ),
)

it.live("retains failed response timings without persisting provider error payloads", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const f = yield* fixture()
        yield* llm.error(400, { error: { message: privateData.error, type: "invalid_request_error" } })
        expect(yield* f.processor.process(f.input)).toBe("stop")
        const rows = f.rows()
        expect(rows.map((row) => row.phase)).toEqual(
          expect.arrayContaining(["execution_start", "request_start", "request", "overall"]),
        )
        expect(rows.find((row) => row.phase === "overall")?.data.status).toBe("error")
        expect(rows.find((row) => row.phase === "request")?.data.status).toBe("error")
        expect(rows.filter((row) => row.phase === "first_text")).toHaveLength(0)
        expect(JSON.stringify(rows)).not.toContain(privateData.error)
        expect(f.processor.message.error).toBeDefined()
        expect(yield* (yield* Session.Service).messages({ sessionID: f.session.id })).toHaveLength(2)
        expect(yield* llm.calls).toBe(1)
      }),
    { config },
  ),
)

it.live("retains partial response timings when a running processor is cancelled", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const f = yield* fixture()
        yield* llm.push(reply().text(privateData.text).hang())
        const fiber = yield* f.processor.process(f.input).pipe(Effect.forkScoped)
        yield* pollWithTimeout(
          Effect.sync(() => f.rows().find((row) => row.phase === "first_text")),
          "partial response never reached the timing collector",
        )
        expect(f.rows().filter((row) => row.phase === "overall")).toHaveLength(0)
        yield* Fiber.interrupt(fiber)
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
        const rows = f.rows()
        expect(rows.find((row) => row.phase === "overall")?.data.status).toBe("interrupted")
        expect(rows.find((row) => row.phase === "request")?.data.status).toBe("interrupted")
        expect(rows.filter((row) => row.phase === "first_text")).toHaveLength(1)
        expect(JSON.stringify(rows)).not.toContain(privateData.text)
        const messages = yield* (yield* Session.Service).messages({ sessionID: f.session.id })
        expect(JSON.stringify(messages)).toContain(privateData.text)
      }),
    { config },
  ),
)

it.live("real pending permission and reply persist a correlated approval span", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const f = yield* fixture("ask")
        const permissions = yield* Permission.Service
        yield* llm.tool("timing_probe", { value: privateData.args })
        const fiber = yield* f.processor.process(f.input).pipe(Effect.forkScoped)
        const pending = yield* pollWithTimeout(
          permissions.list().pipe(Effect.map((items) => items.find((item) => item.sessionID === f.session.id))),
          "tool never requested permission",
        )
        const start = f.rows().find((row) => row.phase === "approval_start")
        expect(start?.data).toMatchObject({ callID: pending.tool?.callID, tool: "timing_probe" })
        expect(start?.data.approvalID).toEqual(expect.any(String))
        expect(f.rows().filter((row) => row.phase === "approval")).toHaveLength(0)
        yield* permissions.reply({ requestID: pending.id, reply: "once" })
        yield* awaitWithTimeout(Fiber.join(fiber), "approved tool never completed")
        const rows = f.rows()
        expect(rows.filter((row) => row.phase === "approval")).toMatchObject([
          {
            data: {
              callID: start?.data.callID,
              requestID: start?.data.requestID,
              approvalID: start?.data.approvalID,
              tool: "timing_probe",
              status: "completed",
            },
          },
        ])
        expect(rows.find((row) => row.phase === "approval")?.data.durationMs).toBeGreaterThanOrEqual(0)
        expect(yield* permissions.list()).toHaveLength(0)
        for (const secret of Object.values(privateData)) expect(JSON.stringify(rows)).not.toContain(secret)
      }),
    { config },
  ),
)

it.live("Session.fork copies a real response but never its timing rows", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const sessions = yield* Session.Service
        yield* llm.text(privateData.text)
        yield* f.processor.process(f.input)
        const before = f.rows()
        expect(before.length).toBeGreaterThan(0)
        const fork = yield* sessions.fork({ sessionID: f.session.id })
        yield* Effect.addFinalizer(() => sessions.remove(fork.id).pipe(Effect.orDie))
        SessionTimingStore.flush()
        expect(yield* sessions.messages({ sessionID: fork.id })).toHaveLength(2)
        expect(
          Database.use((db) => db.select().from(TimingTable).where(eq(TimingTable.session_id, fork.id)).all()),
        ).toHaveLength(0)
        expect(
          Database.use((db) => db.select().from(TimingTable).where(eq(TimingTable.root_session_id, fork.id)).all()),
        ).toHaveLength(0)
        expect(f.rows()).toEqual(before)
      }),
    { config },
  ),
)

it.live("AI SDK step metadata survives the metadata-free finish event in processor and auxiliary timings", () =>
  Effect.gen(function* () {
    const server = yield* localStream([
      {
        type: "response.created",
        response: { id: "resp_timing", created_at: 1, model: "served-timing-model" },
      },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_timing" } },
      { type: "response.output_text.delta", item_id: "msg_timing", delta: privateData.text },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_timing" } },
      {
        type: "response.completed",
        response: {
          service_tier: "priority",
          usage: { input_tokens: 2, output_tokens: 3 },
        },
      },
    ])
    const cfg = config(server.url)
    yield* provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const f = yield* fixture()
          const events = yield* (yield* LLM.Service)
            .stream({ ...f.input, small: true, tools: {} })
            .pipe(Stream.runCollect)
          expect(events.find((event) => event.type === "step-finish")?.providerMetadata?.openai).toMatchObject({
            serviceTier: "priority",
            modelId: "served-timing-model",
          })
          expect(events.find((event) => event.type === "finish")?.providerMetadata).toBeUndefined()
          expect(yield* f.processor.process(f.input)).toBe("continue")
          const terminal = f.rows().filter((row) => row.phase === "request" || row.phase === "overall")
          expect(terminal).toHaveLength(4)
          for (const row of terminal) {
            expect(row.data).toMatchObject({
              modelID: model.modelID,
              resolvedModelID: "served-timing-model",
              returnedTier: "priority",
              runtime: "ai-sdk",
              status: "completed",
            })
          }
          expect(server.requests).toEqual(["/v1/responses", "/v1/responses"])
        }),
      { config: { ...cfg, provider: { test: { ...cfg.provider.test, npm: "@ai-sdk/openai" } } } },
    )
  }),
)

for (const [reason, outcome, finish] of [
  [undefined, "incomplete", "unknown"],
  ["length", "truncated", "length"],
  ["content_filter", "error", "content-filter"],
] as const) {
  it.live(
    `partial text ending with ${reason ?? "EOF"} retains ${outcome} timings without changing application success`,
    () =>
      Effect.gen(function* () {
        const server = yield* localStream([
          {
            id: "chatcmpl-timing",
            object: "chat.completion.chunk",
            model: "test-model",
            choices: [{ index: 0, delta: { role: "assistant", content: privateData.text } }],
          },
          ...(reason ? [{ id: "chatcmpl-timing", choices: [{ index: 0, delta: {}, finish_reason: reason }] }] : []),
        ])
        yield* provideTmpdirInstance(
          () =>
            Effect.gen(function* () {
              const f = yield* fixture()
              expect(yield* f.processor.process(f.input)).toBe("continue")
              expect(f.processor.message.error).toBeUndefined()
              expect(f.processor.message.finish).toBe(finish)
              expect(JSON.stringify(yield* (yield* Session.Service).messages({ sessionID: f.session.id }))).toContain(
                privateData.text,
              )
              const events = yield* (yield* LLM.Service)
                .stream({ ...f.input, small: true, tools: {} })
                .pipe(Stream.runCollect)
              expect(events.some((event) => event.type === "text-delta" && event.text === privateData.text)).toBe(true)
              const terminal = f.rows().filter((row) => row.phase === "request" || row.phase === "overall")
              expect(terminal).toHaveLength(4)
              expect(terminal.map((row) => row.data.status)).toEqual([outcome, outcome, outcome, outcome])
              expect(server.requests).toEqual(["/v1/chat/completions", "/v1/chat/completions"])
            }),
          { config: config(server.url) },
        )
      }),
  )
}

it.live("processor cleanup failure overrides a successful provider outcome in persisted timings", () =>
  provideTmpdirServer(
    ({ llm }) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const failure = new Error("TIMING_PRIVATE_CLEANUP_FAILURE")
        const processors = Context.get(
          yield* Layer.build(SessionProcessor.layer.pipe(Layer.fresh)).pipe(
            Effect.provideService(Session.Service, {
              ...sessions,
              updateMessage: (message) =>
                message.role === "assistant" && message.time.completed !== undefined
                  ? Effect.die(failure)
                  : sessions.updateMessage(message),
            }),
          ),
          SessionProcessor.Service,
        )
        const f = yield* fixture("allow", processors)
        yield* llm.text(privateData.text)
        const exit = yield* f.processor.process(f.input).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(failure)
        expect(f.processor.message.finish).toBe("stop")
        expect(f.processor.message.error).toBeUndefined()
        const terminal = f.rows().filter((row) => row.phase === "request" || row.phase === "overall")
        expect(terminal).toHaveLength(2)
        expect(terminal.map((row) => row.data.status)).toEqual(["error", "error"])
        expect(JSON.stringify(f.rows())).not.toContain(failure.message)
        expect(yield* llm.calls).toBe(1)
      }),
    { config },
  ),
)

const shellFixture = Effect.fn("TimingPersistence.shellFixture")(function* () {
  const sessions = yield* Session.Service
  const spawner = yield* ChildProcessSpawner
  const session = yield* sessions.create({})
  yield* Effect.addFinalizer(() => sessions.remove(session.id).pipe(Effect.orDie))
  const gates = {
    exited: yield* Latch.make(),
    output: yield* Latch.make(),
    cleaning: yield* Latch.make(),
    cleanup: yield* Latch.make(),
    saving: yield* Latch.make(),
    save: yield* Latch.make(),
  }
  const prompt = Context.get(
    yield* Layer.build(
      SessionPrompt.layer.pipe(
        Layer.fresh,
        Layer.provide(
          Layer.mergeAll(
            AppFileSystem.defaultLayer,
            SessionRunState.defaultLayer,
            Layer.mock(Command.Service, {}),
            Layer.mock(Goal.Service, {}),
            Layer.mock(Instruction.Service, {}),
            Layer.mock(LSP.Service, {}),
            Layer.mock(Memory.Service, {}),
            Layer.mock(MetaAgent.Service, {}),
            Layer.mock(ReasoningReviewer.Service, {}),
            Layer.mock(Reference.Service, {}),
            Layer.mock(SessionCompaction.Service, {}),
            Layer.mock(SessionRevert.Service, {}),
            Layer.mock(SystemPrompt.Service, {}),
          ),
        ),
      ),
    ).pipe(
      Effect.provideService(Session.Service, {
        ...sessions,
        updateMessage: (message) =>
          message.role === "assistant" && message.time.completed !== undefined
            ? gates.saving.open.pipe(Effect.andThen(gates.save.await), Effect.andThen(sessions.updateMessage(message)))
            : sessions.updateMessage(message),
      }),
      Effect.provideService(
        ChildProcessSpawner,
        makeSpawner((command) =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => gates.cleaning.open.pipe(Effect.andThen(gates.cleanup.await)))
            const handle = yield* spawner.spawn(command)
            return makeHandle({
              ...handle,
              // Capture output immediately, but deliver it only after observing process exit.
              all: handle.all.pipe(
                Stream.tap(() =>
                  handle.exitCode.pipe(Effect.andThen(gates.exited.open), Effect.andThen(gates.output.await)),
                ),
              ),
            })
          }),
        ),
      ),
    ),
    SessionPrompt.Service,
  )
  const fiber = yield* prompt
    .shell({
      sessionID: session.id,
      agent: "build",
      model,
      command: `"${process.execPath}" -e 'process.stdout.write("${privateData.output}")'`,
    })
    .pipe(Effect.forkScoped)
  yield* Effect.addFinalizer(() =>
    gates.output.open.pipe(Effect.andThen(gates.cleanup.open), Effect.andThen(gates.save.open), Effect.asVoid),
  )
  return {
    session,
    prompt,
    fiber,
    gates,
    rows() {
      SessionTimingStore.flush()
      return Database.use((db) => db.select().from(TimingTable).where(eq(TimingTable.session_id, session.id)).all())
    },
  }
})

const shellTest = process.platform === "win32" ? it.live.skip : it.live

shellTest("direct shell timing separates process cleanup from transcript finalization", () =>
  provideTmpdirServer(
    () =>
      Effect.gen(function* () {
        const f = yield* shellFixture()
        yield* awaitWithTimeout(f.gates.exited.await, "shell process did not exit")
        const start = f.rows().find((row) => row.phase === "command_start")
        expect(start?.data.commandID).toEqual(expect.any(String))
        expect(f.rows().filter((row) => row.phase === "command_first_output" || row.phase === "command")).toHaveLength(
          0,
        )
        yield* f.gates.output.open
        yield* awaitWithTimeout(f.gates.cleaning.await, "shell did not reach process cleanup")
        const first = f.rows().filter((row) => row.phase === "command_first_output")
        expect(first).toHaveLength(1)
        expect(first[0].data.commandID).toBe(start?.data.commandID)
        expect(f.rows().filter((row) => row.phase === "command")).toHaveLength(0)
        yield* f.gates.cleanup.open
        yield* awaitWithTimeout(f.gates.saving.await, "shell did not finalize its transcript")
        expect(f.rows().filter((row) => row.phase === "command")).toMatchObject([
          { data: { exitCode: 0, status: "completed" } },
        ])
        expect(f.rows().filter((row) => row.phase === "overall")).toHaveLength(0)
        yield* f.gates.save.open
        const result = yield* awaitWithTimeout(Fiber.join(f.fiber), "shell did not finish")
        expect(JSON.stringify(result.parts)).toContain(privateData.output)
        const rows = f.rows()
        expect(rows.filter((row) => row.phase === "command")).toHaveLength(1)
        expect(rows.find((row) => row.phase === "command")?.data).toMatchObject({
          commandID: start?.data.commandID,
          callID: start?.data.callID,
          exitCode: 0,
          status: "completed",
        })
        expect(rows.find((row) => row.phase === "command")?.data.durationMs).toBeGreaterThanOrEqual(
          first[0].data.durationMs ?? 0,
        )
        expect(rows.find((row) => row.phase === "overall")?.data.status).toBe("completed")
        expect(JSON.stringify(rows)).not.toContain(privateData.output)
      }),
    { config: (url) => ({ ...config(url), shell: "/bin/sh" }) },
  ),
)

shellTest("cancelling direct shell during output drain never persists completed command timing", () =>
  provideTmpdirServer(
    () =>
      Effect.gen(function* () {
        const f = yield* shellFixture()
        yield* awaitWithTimeout(f.gates.exited.await, "shell process did not exit")
        const cancel = yield* f.prompt.cancel(f.session.id).pipe(Effect.forkScoped)
        yield* Effect.addFinalizer(() => f.gates.cleanup.open.pipe(Effect.andThen(f.gates.save.open), Effect.asVoid))
        yield* awaitWithTimeout(f.gates.cleaning.await, "cancel did not reach process cleanup")
        expect(f.rows().filter((row) => row.phase === "command" || row.phase === "command_first_output")).toHaveLength(
          0,
        )
        yield* f.gates.cleanup.open
        yield* awaitWithTimeout(f.gates.saving.await, "cancel did not finalize its transcript")
        expect(f.rows().filter((row) => row.phase === "command")).toMatchObject([{ data: { status: "interrupted" } }])
        expect(f.rows().filter((row) => row.phase === "overall")).toHaveLength(0)
        yield* f.gates.save.open
        yield* awaitWithTimeout(Fiber.join(cancel), "shell cancellation did not finish")
        yield* awaitWithTimeout(Fiber.join(f.fiber), "cancelled shell did not settle")
        const rows = f.rows()
        expect(rows.filter((row) => row.phase === "command")).toHaveLength(1)
        expect(rows.find((row) => row.phase === "command")?.data.status).toBe("interrupted")
        expect(rows.find((row) => row.phase === "overall")?.data.status).toBe("interrupted")
        expect(rows.filter((row) => row.phase === "command_first_output")).toHaveLength(0)
        expect(rows.some((row) => row.data.status === "completed")).toBe(false)
      }),
    { config: (url) => ({ ...config(url), shell: "/bin/sh" }) },
  ),
)

for (const [name, flags] of [
  ["runtime override", RuntimeFlags.layer({ disableTiming: true, experimentalNativeLlm: false })],
  [
    "OPENCODE_DISABLE_TIMING",
    RuntimeFlags.defaultLayer.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_DISABLE_TIMING: "true" }))),
    ),
  ],
] as const) {
  const disabled = testEffect(services(flags))
  disabled.live(`${name} disables processor and auxiliary timing persistence without disabling responses`, () =>
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const f = yield* fixture()
          expect((yield* RuntimeFlags.Service).disableTiming).toBe(true)
          yield* llm.push(reply().text(privateData.text).tool("timing_probe", { value: privateData.args }))
          expect(yield* f.processor.process(f.input)).toBe("continue")
          yield* llm.text("auxiliary result")
          const events = yield* (yield* LLM.Service)
            .stream({ ...f.input, small: true, tools: {} })
            .pipe(Stream.runCollect)
          expect(events.some((event) => event.type === "text-delta")).toBe(true)
          expect(yield* llm.calls).toBe(2)
          expect(f.rows()).toHaveLength(0)
          expect(JSON.stringify(yield* (yield* Session.Service).messages({ sessionID: f.session.id }))).toContain(
            privateData.output,
          )
        }),
      { config },
    ),
  )
}
