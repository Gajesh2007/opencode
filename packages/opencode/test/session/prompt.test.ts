import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { NamedError } from "@opencode-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Collaboration } from "@/agent/collaboration"
import { SubagentRun } from "@/agent/subagent-run"
import { SubagentLimit } from "@/agent/subagent-limit"
import { Team } from "@/agent/team"
import { Memory } from "@/memory/memory"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Goal } from "../../src/session/goal"
import { MetaAgent } from "../../src/session/metaagent"
import { ReasoningReviewer } from "../../src/session/reasoning-reviewer"
import { Steering } from "../../src/session/steering"
import { Session } from "@/session/session"
import { SessionMessageTable } from "../../src/session/session.sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "../../src/v2/session"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "../../src/shell/shell"
import { ShellProcess } from "../../src/shell/process"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import * as Log from "@opencode-ai/core/util/log"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as Database from "../../src/storage/db"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { Reference } from "../../src/reference/reference"
import { RepositoryCache } from "../../src/reference/repository-cache"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const ultraRef = {
  providerID: ProviderID.make("ultra"),
  modelID: ModelID.make("gpt-5.6-terra"),
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: MessageV2.Part[]) {
  return parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
}

type CompletedToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }
type ErrorToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateError }

function completedTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

type PromptLayerInput = {
  processor?: "blocking"
  session?: Layer.Layer<Session.Service>
  system?: Layer.Layer<SystemPrompt.Service>
}

function makePrompt(input?: PromptLayerInput) {
  const deps = Layer.mergeAll(
    input?.session ?? Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    AppFileSystem.defaultLayer,
    BackgroundJob.defaultLayer,
    ShellProcess.defaultLayer,
    status,
    SyncEvent.defaultLayer,
    EventV2Bridge.defaultLayer,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provideMerge(SubagentRun.defaultLayer),
    Layer.provideMerge(Collaboration.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(RepositoryCache.defaultLayer),
    Layer.provide(Git.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(Layer.mergeAll(SubagentLimit.defaultLayer, Team.defaultLayer, Memory.defaultLayer)),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc =
    input?.processor === "blocking"
      ? blockingProcessor
      : SessionProcessor.layer.pipe(
          Layer.provide(summary),
          Layer.provide(Image.defaultLayer),
          Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
          Layer.provideMerge(deps),
        )
  const compact = SessionCompaction.layer.pipe(
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(proc),
    Layer.provideMerge(deps),
  )
  return SessionPrompt.layer.pipe(
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(summary),
    Layer.provideMerge(run),
    Layer.provideMerge(compact),
    Layer.provideMerge(proc),
    Layer.provideMerge(registry),
    Layer.provideMerge(trunc),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(
      Layer.mergeAll(
        input?.system ?? SystemPrompt.defaultLayer,
        Goal.defaultLayer,
        MetaAgent.defaultLayer,
        ReasoningReviewer.defaultLayer,
        Steering.defaultLayer,
        Memory.defaultLayer,
      ),
    ),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(deps),
    Layer.provide(summary),
  )
}

function makeHttp(input?: PromptLayerInput) {
  return Layer.mergeAll(TestLLMServer.layer, makePrompt(input))
}

function makeHttpNoLLMServer(input?: PromptLayerInput) {
  return makePrompt(input)
}

const it = testEffect(makeHttp())
const parallelPreparation = testEffect(
  makeHttp({
    system: Layer.effect(
      SystemPrompt.Service,
      Effect.gen(function* () {
        const environment = yield* Deferred.make<void>()
        return SystemPrompt.Service.of({
          skills: () => Deferred.await(environment).pipe(Effect.as("parallel skills")),
          environment: () => Deferred.succeed(environment, undefined).pipe(Effect.as(["parallel environment"])),
        })
      }),
    ),
  }),
)
const noLLMServer = testEffect(makeHttpNoLLMServer())
const raceNoLLMServer = testEffect(makeHttpNoLLMServer({ processor: "blocking" }))
let retractionInterleave:
  | {
      sessionID: SessionID
      messageID: MessageID
      active: MessageV2.Assistant
    }
  | undefined
const retractionInterleavedSession = Layer.effect(
  Session.Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return Session.Service.of({
      ...sessions,
      updateMessage: (message) => {
        const interleave = retractionInterleave
        if (
          message.role !== "assistant" ||
          !interleave ||
          message.sessionID !== interleave.sessionID ||
          message.parentID !== interleave.messageID
        ) {
          return sessions.updateMessage(message)
        }
        retractionInterleave = undefined
        return sessions.retractQueuedMessage({ sessionID: interleave.sessionID, messageID: interleave.messageID }).pipe(
          Effect.orDie,
          Effect.andThen(
            sessions.updateMessage({
              ...interleave.active,
              finish: "stop",
              time: { ...interleave.active.time, completed: Date.now() },
            }),
          ),
          Effect.andThen(sessions.updateMessage(message)),
        )
      },
    })
  }),
).pipe(Layer.provide(Session.defaultLayer))
const retracting = testEffect(makeHttp({ session: retractionInterleavedSession }))
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
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
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function ultraProviderCfg(url: string) {
  return {
    provider: {
      ultra: {
        name: "Ultra",
        id: "ultra",
        env: [],
        npm: "@ai-sdk/openai",
        models: {
          "gpt-5.6-terra": {
            id: "gpt-5.6-terra",
            name: "GPT-5.6 Terra",
            attachment: false,
            reasoning: true,
            temperature: false,
            tool_call: true,
            release_date: "2026-01-01",
            limit: { context: 128000, output: 16384 },
            cost: { input: 0, output: 0 },
          },
        },
        options: {
          apiKey: "test-key",
          baseURL: url,
        },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.writeWithDirs(file, text)
})

const ensureDir = Effect.fn("test.ensureDir")(function* (dir: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.ensureDir(dir)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<Config.Info>) {
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<Config.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// Wait for a session's runner to enter a busy state. SessionStatus is flipped to
// "busy" inside Runner.startShell's modifyEffect at the same moment the runner
// is registered, so this is a deterministic readiness signal — cancel can't
// no-op once we observe it.
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const hasBash = Effect.sync(() => Bun.which("bash") !== null)

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

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
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

noLLMServer.instance(
  "loop exits immediately when last assistant has stop finish",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    }),
  { config: cfg },
)

it.instance("loop calls LLM and returns assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    const parts = result.parts.filter((p) => p.type === "text")
    expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

it.instance("active goal reminder stays byte-stable across the steps of a turn", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Goal cache anchor",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      model: ref,
      noReply: true,
      parts: [{ type: "text", text: "find text files" }],
    })
    // The reminder lives in the system prompt, which providers with prefix
    // caching (Anthropic breakpoints, Bedrock cachePoint, OpenAI implicit)
    // treat as the cached-prefix anchor. Embedding live usage figures made it
    // mutate after every request and invalidated the whole prefix cache.
    yield* Effect.gen(function* () {
      yield* (yield* Goal.Service).create({
        sessionID: chat.id,
        objective: "find every file",
        tokenBudget: 100_000,
      })
    }).pipe(Effect.provide(Goal.defaultLayer))
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    yield* prompt.loop({ sessionID: chat.id })

    const systems = (yield* llm.inputs)
      .flatMap((body) => (Array.isArray(body.messages) ? body.messages : []))
      .filter((message): message is Record<string, unknown> => typeof message === "object" && message !== null)
      .filter((message) => message["role"] === "system")
      .map((message) => message["content"])
      .filter((content): content is string => typeof content === "string" && content.includes("<active_goal>"))
    expect(systems).toHaveLength(2)
    expect(systems[0]).toContain("Objective: find every file")
    // No live usage figures inside the cached system prefix.
    expect(systems[0]).not.toContain("Tokens used:")
    expect(systems[0]).not.toContain("Cost: $")
    // Byte-identical across steps even though usage accumulated between them.
    expect(systems[1]).toBe(systems[0])
  }),
)

it.instance("default-off meta-agent ignores persisted enabled lens during a turn", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const chat = yield* (yield* Session.Service).create({ title: "Pinned" })
    yield* Effect.gen(function* () {
      yield* (yield* MetaAgent.Service).set({ sessionID: chat.id, basePrompt: "PRIVATE_PERSISTED_LENS" })
    }).pipe(
      Effect.provide(
        Layer.fresh(MetaAgent.layer.pipe(Layer.provide(RuntimeFlags.layer({ experimentalMetaAgent: true })))),
      ),
    )
    const prompt = yield* SessionPrompt.Service
    yield* prompt.prompt({
      sessionID: chat.id,
      model: ref,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().reason("Checking the task").text("world").stop())
    yield* prompt.loop({ sessionID: chat.id })
    expect(yield* llm.hits).toHaveLength(1)
    const request = JSON.stringify((yield* llm.inputs)[0])
    expect(request).not.toContain("PRIVATE_PERSISTED_LENS")
    expect(request).not.toContain('"name":"metaagent"')
  }),
)

parallelPreparation.instance("prepares independent prompt inputs concurrently without reordering them", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const chat = yield* (yield* Session.Service).create({ title: "Pinned" })
    yield* prompt.prompt({
      sessionID: chat.id,
      model: ref,
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")
    yield* awaitWithTimeout(prompt.loop({ sessionID: chat.id }), "Prompt preparation did not run concurrently")
    const request = JSON.stringify((yield* llm.inputs)[0])
    expect(request).toContain("parallel environment")
    expect(request).toContain("parallel skills")
    expect(request.indexOf("parallel environment")).toBeLessThan(request.indexOf("parallel skills"))
  }),
)

it.instance("preserves an explicit default service tier so Ultrafast aliases can be reset", () =>
  Effect.gen(function* () {
    yield* useServerConfig(providerCfg)
    const chat = yield* (yield* Session.Service).create({ title: "Tier reset" })
    const result = yield* (yield* SessionPrompt.Service).prompt({
      sessionID: chat.id,
      model: ref,
      serviceTier: "default",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    expect(result.info).toMatchObject({ role: "user", model: { ...ref, serviceTier: "default" } })
  }),
)

it.instance("drains collaboration wake records without duplicating persisted mail", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const collaboration = yield* Collaboration.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* prompt.prompt({
      sessionID: chat.id,
      model: ref,
      agent: "build",
      variant: "ultra",
      reasoningMode: "pro",
      serviceTier: "priority",
      upstream: "origin",
      noReply: true,
      parts: [{ type: "text", text: "initial task" }],
    })
    yield* collaboration.registerRoot(chat.id)
    const child = SessionID.make("ses_prompt_mail_child")
    yield* collaboration.registerChild({ parentSessionID: chat.id, sessionID: child, taskName: "research" })
    yield* collaboration.send({
      sessionID: child,
      target: "..",
      kind: "MESSAGE",
      content: "found the relevant file",
      triggerTurn: false,
    })
    yield* llm.text("mail handled")

    const result = yield* prompt.loop({ sessionID: chat.id })
    const mailbox = (yield* sessions.messages({ sessionID: chat.id })).filter((message) =>
      message.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("found the relevant file"),
      ),
    )

    expect(result.parts.some((part) => part.type === "text" && part.text === "mail handled")).toBe(true)
    expect(mailbox).toHaveLength(1)
    expect(mailbox[0]?.info).toMatchObject({
      role: "user",
      agent: "build",
      model: { ...ref, variant: "ultra", reasoningMode: "pro", serviceTier: "priority", upstream: "origin" },
    })
    expect(yield* collaboration.hasMail(chat.id)).toBe(false)
    expect(JSON.stringify((yield* llm.inputs)[0])).toContain("found the relevant file")
  }),
)

it.instance("delivers one bounded collaboration-mail batch per model request", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const collaboration = yield* Collaboration.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* prompt.prompt({
      sessionID: chat.id,
      model: ref,
      agent: "build",
      variant: "ultra",
      noReply: true,
      parts: [{ type: "text", text: "initial task" }],
    })
    yield* collaboration.registerRoot(chat.id)
    const child = SessionID.make("ses_prompt_batch_child")
    yield* collaboration.registerChild({ parentSessionID: chat.id, sessionID: child, taskName: "research" })
    yield* Effect.forEach(
      Array.from({ length: 17 }, (_, index) => index),
      (index) =>
        collaboration.send({
          sessionID: child,
          target: "..",
          kind: "MESSAGE",
          content: `batch message ${index}`,
          triggerTurn: false,
        }),
      { discard: true },
    )
    yield* llm.text("first batch handled")

    yield* prompt.loop({ sessionID: chat.id })

    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(1)
    expect(JSON.stringify(inputs[0])).toContain("batch message 15")
    expect(JSON.stringify(inputs[0])).not.toContain("batch message 16")
    expect(
      (yield* sessions.messages({ sessionID: chat.id }))
        .flatMap((message) => message.parts)
        .find((part) => part.type === "text" && part.text.includes("batch message 16")),
    ).toMatchObject({ ignored: true })

    yield* llm.text("second batch handled")
    yield* prompt.loop({ sessionID: chat.id })
    expect(yield* llm.inputs).toHaveLength(2)
    expect(JSON.stringify((yield* llm.inputs)[1])).toContain("batch message 16")
  }),
)

it.instance("leaves unregistered sessions without collaboration mailbox prompts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* prompt.prompt({
      sessionID: chat.id,
      model: ref,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "ordinary work" }],
    })
    yield* llm.text("ordinary answer")

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(result.parts.some((part) => part.type === "text" && part.text === "ordinary answer")).toBe(true)
    expect(
      (yield* sessions.messages({ sessionID: chat.id })).some((message) =>
        message.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("<collaboration_mailbox>"),
        ),
      ),
    ).toBe(false)
  }),
)

it.instance("preserves inherited permissions when applying child tool visibility", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const child = yield* sessions.create({
      permission: [{ permission: "edit", pattern: "*", action: "deny" }],
    })
    yield* prompt.prompt({
      sessionID: child.id,
      model: ref,
      agent: "build",
      noReply: true,
      tools: { spawn_agent: true, task: false },
      parts: [{ type: "text", text: "child task" }],
    })

    expect((yield* sessions.get(child.id)).permission).toEqual(
      expect.arrayContaining([
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "spawn_agent", pattern: "*", action: "allow" },
        { permission: "task", pattern: "*", action: "deny" },
      ]),
    )
  }),
)

it.instance("injects explicit-only collaboration guidance for Ultra-capable non-Ultra models", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(ultraProviderCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Pinned" })
    yield* (yield* Collaboration.Service).registerRoot(session.id)
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      model: ultraRef,
      variant: "max",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")

    yield* prompt.loop({ sessionID: session.id })

    expect(JSON.stringify((yield* llm.inputs)[0])).toContain("Subagent delegation is explicit-only")
  }),
)

it.instance("only injects collaboration guidance for registered roots and descendants", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(ultraProviderCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const collaboration = yield* Collaboration.Service
    const root = yield* sessions.create({ title: "Pinned" })
    yield* prompt.prompt({
      sessionID: root.id,
      agent: "build",
      model: ultraRef,
      variant: "ultra",
      noReply: true,
      parts: [{ type: "text", text: "root task" }],
    })
    yield* llm.text("root complete")
    yield* prompt.loop({ sessionID: root.id })

    expect((yield* collaboration.member(root.id))?.parentSessionID).toBeUndefined()

    const child = yield* sessions.create({ parentID: root.id, title: "[agent] child" })
    yield* collaboration.registerChild({ parentSessionID: root.id, sessionID: child.id, taskName: "research" })
    yield* prompt.prompt({
      sessionID: child.id,
      agent: "build",
      model: ultraRef,
      variant: "ultra",
      noReply: true,
      parts: [{ type: "text", text: "child task" }],
    })
    yield* llm.text("child complete")
    yield* prompt.loop({ sessionID: child.id })

    const legacyChild = yield* sessions.create({ parentID: root.id, title: "[agent] legacy child" })
    yield* prompt.prompt({
      sessionID: legacyChild.id,
      agent: "build",
      model: ultraRef,
      variant: "ultra",
      noReply: true,
      parts: [{ type: "text", text: "legacy child task" }],
    })
    yield* llm.text("legacy child complete")
    yield* prompt.loop({ sessionID: legacyChild.id })

    const inputs = yield* llm.inputs
    const rootInput = JSON.stringify(inputs.find((input) => JSON.stringify(input).includes("root task")))
    const childInput = JSON.stringify(inputs.find((input) => JSON.stringify(input).includes("child task")))
    const legacyChildInput = JSON.stringify(inputs.find((input) => JSON.stringify(input).includes("legacy child task")))

    expect(rootInput).toContain("Spawned agents may spawn their own well-scoped subagents")
    expect(rootInput).toContain("All descendants share the same root collaboration control plane")
    expect(childInput).toContain("You can spawn your own well-scoped subagents using spawn_agent")
    expect(childInput).toContain("Results return to your direct parent")
    expect(legacyChildInput).not.toContain("<collaboration>")
    const legacyInput = inputs.find((input) => JSON.stringify(input).includes("legacy child task"))
    expect(legacyInput?.tools).not.toContainEqual(expect.objectContaining({ name: "spawn_agent" }))
  }),
)

noLLMServer.instance(
  "prompt emits v2 prompted and synthetic events",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(SessionV2.layer),
      )
      const row = Database.use((db) =>
        db.select().from(SessionMessageTable).where(Database.eq(SessionMessageTable.session_id, chat.id)).get(),
      )
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { config: cfg },
)

it.instance("static loop returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("static loop consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello one" }],
    })

    yield* llm.text("world one")

    const first = yield* prompt.loop({ sessionID: session.id })
    expect(first.info.role).toBe("assistant")
    expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello two" }],
    })

    yield* llm.text("world two")

    const second = yield* prompt.loop({ sessionID: session.id })
    expect(second.info.role).toBe("assistant")
    expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

retracting.instance("does not infer or execute tools for a successfully retracted queued message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const firstUser = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: chat.id,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    const active: MessageV2.Assistant = {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: firstUser.id,
      sessionID: chat.id,
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
    }
    yield* sessions.updateMessage(active)
    const queued = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: chat.id,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    retractionInterleave = { sessionID: chat.id, messageID: queued.id, active }

    const result = yield* prompt.loop({ sessionID: chat.id })

    expect(result.info.id).toBe(active.id)
    expect((yield* sessions.messages({ sessionID: chat.id })).map((message) => message.info.id)).toEqual([
      firstUser.id,
      active.id,
    ])
    expect(yield* llm.hits).toHaveLength(0)
  }),
)

it.instance("loop continues when finish is tool-calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("glob tool keeps instance context during prompt runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Glob context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "find text files" }],
    })
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const tool = msgs
      .flatMap((msg) => msg.parts)
      .find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
      )
    if (!tool) return

    expect(tool.state.output).toContain(file)
    expect(tool.state.output).not.toContain("No context found for instance")
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
  }),
)

it.instance("loop continues when finish is stop but assistant has tool parts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().tool("first", { value: "first" }).stop())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("failed subtask preserves metadata on error tool state", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: {
        general: {
          model: "test/missing-model",
        },
      },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.tool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
    expect(taskMsg?.info.role).toBe("assistant")
    if (!taskMsg || taskMsg.info.role !== "assistant") return

    const tool = errorTool(taskMsg.parts)
    if (!tool) return

    expect(tool.state.error).toContain("Tool execution failed")
    expect(tool.state.metadata).toBeDefined()
    expect(tool.state.metadata?.sessionId).toBeDefined()
    expect(tool.state.metadata?.model).toEqual({
      providerID: ProviderID.make("test"),
      modelID: ModelID.make("missing-model"),
    })
  }),
)

it.instance("nudges a subagent that finishes without a written reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Empty subagent reply" })

    // Parent delegates via the task tool. The subagent's first turn is reasoning + stop
    // with NO text (an empty reply) — previously this returned an empty <task_result>.
    // The nudge continues the subagent, which then produces a real answer.
    yield* llm.tool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* llm.push(reply().reason("thinking about it").stop())
    yield* llm.push(reply().text("FINAL ANSWER from subagent").stop())
    yield* llm.text("parent done")

    const result = yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      parts: [{ type: "text", text: "delegate the task" }],
    })
    expect(result.info.role).toBe("assistant")

    // parent task-call + subagent empty turn + subagent nudge + parent done = 4
    expect(yield* llm.calls).toBe(4)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "build")
    const tool = taskMsg ? completedTool(taskMsg.parts) : undefined
    expect(tool?.state.output).toContain("FINAL ANSWER from subagent")
  }),
)

it.instance(
  "running subtask preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          const tool = taskMsg?.parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running subtask metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBeDefined()
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  5_000,
)

it.instance(
  "running task tool preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "build")
          const tool = assistant?.parts.find(
            (part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "task",
          )
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running task metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBe("inspect bug")
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  10_000,
)

it.instance(
  "loop sets status to busy then idle",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service

      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect((yield* status.get(chat.id)).type).toBe("busy")
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  3_000,
)

// Cancel semantics

it.instance(
  "cancel interrupts loop and resolves with an assistant message",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id)

      yield* llm.hang

      yield* user(chat.id, "more")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
      }
    }),
  3_000,
)

it.instance(
  "cancel records MessageAbortedError on interrupted process",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const info = exit.value.info
        if (info.role === "assistant") {
          expect(info.error?.name).toBe("MessageAbortedError")
        }
      }
    }),
  3_000,
)

raceNoLLMServer.instance(
  "finalizes assistant when cancelled before processor creation completes",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Processor creation race" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })

      const firstCreate = defer<void>()
      processorCreateStarted.push(firstCreate.resolve)
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => firstCreate.promise)

      yield* prompt.cancel(chat.id)
      const firstExit = yield* Fiber.await(first)
      expect(Exit.isSuccess(firstExit)).toBe(true)

      let messages = yield* sessions.messages({ sessionID: chat.id })
      const firstInterrupted = messages.at(-1)
      expect(firstInterrupted?.info.role).toBe("assistant")
      expect(firstInterrupted?.parts).toHaveLength(0)
      if (firstInterrupted?.info.role === "assistant") {
        expect(firstInterrupted.info.finish).toBeUndefined()
        expect(firstInterrupted.info.time.completed).toBeNumber()
        expect(firstInterrupted.info.error?.name).toBe("MessageAbortedError")
      }

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })

      const secondCreate = defer<void>()
      processorCreateStarted.push(secondCreate.resolve)
      const second = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => secondCreate.promise)

      yield* prompt.cancel(chat.id)
      const secondExit = yield* Fiber.await(second)
      expect(Exit.isSuccess(secondExit)).toBe(true)

      messages = yield* sessions.messages({ sessionID: chat.id })
      const poisonMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          !message.info.finish &&
          !message.info.time.completed &&
          !message.info.error,
      )
      expect(poisonMessages).toHaveLength(0)

      const interruptedMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          message.info.time.completed &&
          message.info.error?.name === "MessageAbortedError",
      )
      expect(interruptedMessages).toHaveLength(2)

      const lastUser = messages.at(-2)
      const lastAssistant = messages.at(-1)
      expect(lastUser?.info.role).toBe("user")
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastUser?.info.role === "user" && lastAssistant?.info.role === "assistant") {
        expect(lastAssistant.info.parentID).toBe(lastUser?.info.id)
      }
    }),
  { config: cfg },
  3_000,
)

noLLMServer.instance(
  "cancel finalizes subtask tool state",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()
      const registry = yield* ToolRegistry.Service
      const { task } = yield* registry.named()
      const original = task.execute
      task.execute = (_args, ctx) =>
        Effect.callback<never>((_resume) => {
          ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
          if (ctx.abort.aborted) succeedVoid(aborted)
          succeedVoid(ready)
          return Effect.sync(() => succeedVoid(aborted))
        })
      yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

      const { prompt, chat } = yield* boot()
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for task tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      yield* awaitWithTimeout(Deferred.await(aborted), "timed out waiting for task tool abort", "10 seconds")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = toolPart(taskMsg.parts)
      expect(tool?.type).toBe("tool")
      if (!tool) return

      expect(tool.state.status).not.toBe("running")
      expect(taskMsg.info.time.completed).toBeDefined()
      expect(taskMsg.info.finish).toBeDefined()
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "cancel propagates from slash command subtask to child session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
      const sessionID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
      expect(typeof sessionID).toBe("string")
      if (typeof sessionID !== "string") throw new Error("missing child session id")
      const childID = SessionID.make(sessionID)
      expect((yield* status.get(childID)).type).toBe("busy")

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* status.get(childID)).type).toBe("idle")
    }),
  10_000,
)

it.instance(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
        expect(exitA.value.info.id).toBe(exitB.value.info.id)
      }
    }),
  { git: true },
  3_000,
)

// Interrupt semantics: the turn stops, its subagents keep running, and queued input may start a new turn.

// The task tool part of the session's latest assistant message from `agent`.
const taskTool = Effect.fn("test.taskTool")(function* (sessionID: SessionID, agent: string) {
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
  const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === agent)
  return assistant ? toolPart(assistant.parts) : undefined
})

// The subagent session of a running task tool call, once it exists.
const runningTask = (sessionID: SessionID, agent: string) =>
  pollWithTimeout(
    taskTool(sessionID, agent).pipe(
      Effect.map((tool) => {
        const childID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
        return typeof childID === "string" ? SessionID.make(childID) : undefined
      }),
    ),
    "timed out waiting for a running subagent",
  )

it.instance(
  "interrupt stops the turn but leaves its foreground subagent running",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const jobs = yield* BackgroundJob.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const childID = yield* runningTask(chat.id, "build")
      yield* llm.wait(2)

      expect(yield* prompt.interrupt({ sessionID: chat.id })).toEqual({ interrupted: true, resumed: false })
      expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* jobs.get(childID))?.status).toBe("running")
      expect((yield* status.get(childID)).type).toBe("busy")

      // The call returned while the turn was stopping, so its result tells the model what happened.
      const tool = yield* taskTool(chat.id, "build")
      expect(tool?.state.status).toBe("completed")
      if (tool?.state.status === "completed") {
        expect(tool.state.metadata.background).toBe(true)
        expect(tool.state.output).toContain("interrupted the main turn")
      }

      // Aborting the session still stops everything it spawned.
      yield* prompt.cancel(chat.id)
      expect((yield* jobs.get(childID))?.status).toBe("cancelled")
      expect((yield* status.get(childID)).type).toBe("idle")
    }),
  10_000,
)

it.instance(
  "interrupt leaves a slash command subtask's subagent running",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const jobs = yield* BackgroundJob.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const childID = yield* runningTask(chat.id, "general")
      yield* llm.wait(1)

      expect(yield* prompt.interrupt({ sessionID: chat.id })).toEqual({ interrupted: true, resumed: false })
      expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
      expect((yield* jobs.get(childID))?.status).toBe("running")
      expect((yield* status.get(childID)).type).toBe("busy")
      const tool = yield* taskTool(chat.id, "general")
      expect(tool?.state.status).toBe("completed")
      if (tool?.state.status === "completed") expect(tool.state.output).toContain("interrupted the main turn")

      yield* prompt.cancel(chat.id)
      expect((yield* jobs.get(childID))?.status).toBe("cancelled")
    }),
  10_000,
)

it.instance(
  "interrupt with resume starts a new turn for input queued behind the interrupted one",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* llm.text("handled the queued message")
      yield* user(chat.id, "first")

      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const queuedID = MessageID.ascending()
      const queued = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: queuedID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "queued follow-up" }],
        })
        .pipe(Effect.forkChild)
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(Effect.map((msgs) => (msgs.some((msg) => msg.info.id === queuedID) ? true : undefined))),
        "timed out waiting for the queued prompt to save",
      )

      expect(yield* prompt.interrupt({ sessionID: chat.id, resume: true })).toEqual({
        interrupted: true,
        resumed: true,
      })
      expect(Exit.isSuccess(yield* Fiber.await(first))).toBe(true)
      expect(Exit.isSuccess(yield* Fiber.await(queued))).toBe(true)

      const answer = yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((msgs) =>
              msgs.find(
                (msg) =>
                  msg.info.role === "assistant" &&
                  msg.info.parentID === queuedID &&
                  msg.info.time.completed !== undefined,
              ),
            ),
          ),
        "the queued input never got a reply",
      )
      expect(answer.parts.some((part) => part.type === "text" && part.text === "handled the queued message")).toBe(true)
      expect(yield* llm.calls).toBe(2)
      expect(JSON.stringify((yield* llm.inputs).at(-1)?.messages)).toContain("queued follow-up")
    }),
  10_000,
)

it.instance(
  "interrupt without queued input leaves the session stopped",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const run = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "first")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      // Background completion notices are synthetic, not queued user input.
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "Background task completed", synthetic: true }],
      })

      expect(yield* prompt.interrupt({ sessionID: chat.id, resume: true })).toEqual({
        interrupted: true,
        resumed: false,
      })
      expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
      yield* run.assertNotBusy(chat.id)
      // Wakeups such as a finished background task cannot restart it either.
      yield* prompt.loop({ sessionID: chat.id })
      expect(yield* llm.calls).toBe(1)
    }),
  10_000,
)

// Queue semantics

noLLMServer.instance("concurrent loop callers get same result", () =>
  Effect.gen(function* () {
    const { prompt, run, chat } = yield* boot()
    yield* seed(chat.id, { finish: "stop" })

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })

    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    yield* run.assertNotBusy(chat.id)
  }),
)

it.instance(
  "concurrent loop callers all receive same error result",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.fail("boom")
      yield* user(chat.id, "hello")

      const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
        concurrency: "unbounded",
      })
      expect(a.info.id).toBe(b.info.id)
      expect(a.info.role).toBe("assistant")
    }),
  3_000,
)

it.instance(
  "prompt submitted during an active run is included in the next LLM input",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.hold("first", deferredAsPromise(gate))
      yield* llm.text("second")

      const a = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "first" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)

      const id = MessageID.ascending()
      const b = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "second" }],
        })
        .pipe(Effect.forkChild)

      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((msgs) =>
              msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined,
            ),
          ),
        "timed out waiting for second prompt to save",
      )

      yield* Deferred.succeed(gate, void 0)

      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      expect(yield* llm.calls).toBe(2)

      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const assistants = msgs.filter((msg) => msg.info.role === "assistant")
      expect(assistants).toHaveLength(2)
      const last = assistants.at(-1)
      if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
      expect(last.info.parentID).toBe(id)
      expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(2)
      expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("second")
    }),
  3_000,
)

it.instance(
  "assertNotBusy fails with BusyError when loop running",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const run = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
      }

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  3_000,
)

noLLMServer.instance("assertNotBusy succeeds when idle", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({})
    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

// Shell semantics

it.instance(
  "shell rejects with BusyError when loop running",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
      }

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  3_000,
)

unixNoLLMServer(
  "shell captures stdout and stderr in completed tool output",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "printf out && printf err >&2",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("out")
      expect(tool.state.output).toContain("err")
      expect(tool.state.metadata.output).toContain("out")
      expect(tool.state.metadata.output).toContain("err")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell completes a fast command on the preferred shell",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("pwd")
      expect(tool.state.output).toContain(dir)
      expect(tool.state.metadata.output).toContain(dir)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return

        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "[[ 1 -eq 1 ]] && printf configured",
        })

        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output).toContain("configured")
      }),
    ),
  { config: { ...cfg, shell: "bash" } },
  30_000,
)

unixNoLLMServer(
  "shell commands can change directory after startup",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const parent = path.dirname(dir)
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "cd .. && pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain(parent)
      expect(tool.state.metadata.output).toContain(parent)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell lists files from the project directory",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      yield* writeText(path.join(dir, "README.md"), "# e2e\n")

      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command ls",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("command ls")
      expect(tool.state.output).toContain("README.md")
      expect(tool.state.metadata.output).toContain("README.md")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell captures stderr from a failing command",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("not found")
      expect(tool.state.metadata.output).toContain("not found")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const fiber = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
          .pipe(Effect.forkChild)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
            const taskMsg = msgs.find((item) => item.info.role === "assistant")
            const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
            if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return true
          }),
          "timed out waiting for running shell metadata",
        )

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  { config: cfg },
  30_000,
)

it.instance(
  "loop waits while shell runs and starts after shell exits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("after-shell")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(loop)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  3_000,
)

it.instance(
  "shell completion resumes queued loop callers",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("done")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
        expect(ea.value.info.id).toBe(eb.value.info.id)
        expect(ea.value.info.role).toBe("assistant")
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  3_000,
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: "bash",
          command: {
            probe: {
              template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "probe",
          arguments: "",
        })

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
      }),
    ),
  30_000,
)

unixNoLLMServer(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        yield* prompt.cancel(chat.id)

        const status = yield* SessionStatus.Service
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(busy)).toBe(true)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* AppFileSystem.Service
        const ready = path.join(dir, ".trap-ready")

        const sh = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            // Touch marker AFTER trap installs so the test waits for the actual
            // ignore-TERM state before cancelling; otherwise SIGTERM can arrive
            // before `trap` runs and the escalation path is never exercised.
            command: `trap '' TERM; touch "${ready}"; sleep 30`,
          })
          .pipe(Effect.forkChild)

        yield* Effect.gen(function* () {
          while (!(yield* afs.existsSafe(ready))) {
            yield* Effect.sleep(Duration.millis(10))
          }
        }).pipe(Effect.timeout(Duration.seconds(5)))

        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Interrupted bash truncation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run bash" }],
      })

      yield* llm.tool("bash", {
        command:
          'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; sleep 0.1; printf "__large_output_ready__\\n"; sleep 30',
        description: "Print many lines",
        timeout: 30_000,
        workdir: path.resolve(dir),
      })

      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((messages) =>
              messages.some((message) =>
                message.parts.some(
                  (part) =>
                    part.type === "tool" &&
                    part.state.status === "running" &&
                    part.state.metadata?.output?.includes("__large_output_ready__"),
                ),
              )
                ? true
                : undefined,
            ),
          ),
        "shell did not publish its large output before cancellation",
      )
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isFailure(exit)) return

      const tool = completedTool(exit.value.parts)
      if (!tool) return

      expect(tool.state.metadata.truncated).toBe(true)
      expect(typeof tool.state.metadata.outputPath).toBe("string")
      expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
      expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
      expect(tool.state.output).not.toContain("Tool execution aborted")
    }),
  { git: true },
  30_000,
)

unixNoLLMServer(
  "cancel interrupts loop queued behind shell",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 30" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(loop)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const tool = completedTool(exit.value.parts)
        expect(tool?.state.output).toContain("User aborted the command")
      }

      yield* Fiber.await(sh)
    }),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const a = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(a)
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

// Moving a `!` command to the background (Ctrl+B)

// Prints, then keeps running until a `release` file appears in the project directory.
const blockingCommand =
  "printf 'line1\\nline2\\nline3\\n'; while [ ! -e release ]; do sleep 0.05; done; printf 'line4\\n'; exit 3"

// Upper bound for each readiness signal below; process startup is slow on a loaded machine.
const backgroundWait = "15 seconds"

const startBlockingShell = Effect.fn("test.startBlockingShell")(function* (sessionID: SessionID) {
  const prompt = yield* SessionPrompt.Service
  const fiber = yield* prompt.shell({ sessionID, agent: "build", command: blockingCommand }).pipe(Effect.forkChild)
  const shellID = yield* pollWithTimeout(
    Effect.gen(function* () {
      const part = (yield* MessageV2.filterCompactedEffect(sessionID))
        .flatMap((message) => message.parts)
        .findLast((part): part is MessageV2.ToolPart => part.type === "tool" && part.state.status === "running")
      if (part?.state.status !== "running" || !part.state.metadata?.output?.includes("line3")) return
      return ShellProcess.ID.make(part.state.metadata.shellID)
    }),
    "shell never published its first output",
    backgroundWait,
  )
  return { fiber, shellID }
})

const backgroundShell = Effect.fn("test.backgroundShell")(function* (sessionID: SessionID) {
  const started = yield* startBlockingShell(sessionID)
  const jobs = yield* BackgroundJob.Service
  // Output can be published a moment before the call starts blocking on its job.
  const moved = yield* pollWithTimeout(
    jobs.backgroundAll({ sessionID }).pipe(Effect.map((moved) => (moved.length ? moved : undefined))),
    "shell never blocked its session",
    backgroundWait,
  )
  expect(moved.map((job) => job.id)).toEqual([started.shellID])
  const result = yield* awaitWithTimeout(
    Fiber.join(started.fiber),
    "backgrounded shell call did not return",
    backgroundWait,
  )
  return { ...started, moved, result }
})

const shellNotices = Effect.fn("test.shellNotices")(function* (sessionID: SessionID) {
  const messages = yield* (yield* Session.Service).messages({ sessionID }).pipe(Effect.orDie)
  return messages
    .flatMap((message) => message.parts)
    .filter((part): part is MessageV2.TextPart => part.type === "text" && part.metadata?.source === "shell")
})

const awaitShellNotices = (sessionID: SessionID) =>
  pollWithTimeout(
    shellNotices(sessionID).pipe(Effect.map((notices) => (notices.length ? notices : undefined))),
    "backgrounded shell never reported its exit",
    backgroundWait,
  )

unixNoLLMServer(
  "ctrl+b moves a running ! command to the background and records its completion without a new turn",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { run, sessions, chat } = yield* boot()
        const shells = yield* ShellProcess.Service
        const status = yield* SessionStatus.Service

        const { shellID, moved, result } = yield* backgroundShell(chat.id)
        expect(moved).toMatchObject([{ id: shellID, type: "shell", title: blockingCommand }])
        const file = (yield* shells.get(shellID)).file
        const tool = completedTool(result.parts)
        expect(tool?.state.metadata).toEqual({
          output: "line1\nline2\nline3",
          description: "",
          shellID,
          background: true,
          outputPath: file,
        })
        expect(tool?.state.output).toBe(
          `The user moved this command to the background (shell ID: ${shellID}). It is still running; output is streaming to: ${file}\n\nOutput so far:\nline1\nline2\nline3`,
        )
        expect((yield* status.get(chat.id)).type).toBe("idle")
        yield* run.assertNotBusy(chat.id)
        expect(yield* shells.get(shellID)).toMatchObject({ status: "running", background: true })
        expect(yield* shellNotices(chat.id)).toEqual([])

        yield* writeText(path.join(dir, "release"), "")
        const [notice] = yield* awaitShellNotices(chat.id)
        expect(notice.synthetic).toBe(true)
        expect(notice.metadata).toEqual({
          source: "shell",
          user: true,
          shellID,
          command: blockingCommand,
          state: "exited",
          exit: 3,
        })
        expect(notice.text).toBe(
          [
            "The following shell command was executed by the user and finished in the background:",
            `<shell id="${shellID}" state="exited" command="${blockingCommand}">`,
            "line1\nline2\nline3\nline4",
            "",
            "Exited with code 3",
            "</shell>",
          ].join("\n"),
        )
        // The `!` command's own reply is the only assistant message: the notice waits for the next turn.
        const messages = yield* sessions.messages({ sessionID: chat.id })
        expect(messages.filter((message) => message.info.role === "assistant")).toHaveLength(1)
        expect(messages.at(-1)?.parts).toEqual([notice])
        expect((yield* status.get(chat.id)).type).toBe("idle")
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "backgrounded ! command previews and notices keep to the tool output limits",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { chat } = yield* boot()
        const shells = yield* ShellProcess.Service

        const { shellID, result } = yield* backgroundShell(chat.id)
        const file = (yield* shells.get(shellID)).file
        const tool = completedTool(result.parts)
        expect(tool?.state.metadata.output).toBe("...\nline2\nline3")
        expect(tool?.state.metadata.outputPath).toBe(file)
        expect(tool?.state.output).toEndWith("Output so far:\n...\nline2\nline3")

        yield* writeText(path.join(dir, "release"), "")
        const [notice] = yield* awaitShellNotices(chat.id)
        expect(notice.text).toBe(
          [
            "The following shell command was executed by the user and finished in the background:",
            `<shell id="${shellID}" state="exited" command="${blockingCommand}">`,
            `...output truncated...\n\nFull output saved to: ${file}\n\nline3\nline4`,
            "",
            "Exited with code 3",
            "</shell>",
          ].join("\n"),
        )
      }),
    ),
  { git: true, config: { ...cfg, tool_output: { max_lines: 2, max_bytes: 1024 } } },
  30_000,
)

unixNoLLMServer(
  "esc leaves a backgrounded ! command running but still kills a foreground one",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { prompt, chat } = yield* boot()
        const shells = yield* ShellProcess.Service

        const backgrounded = yield* backgroundShell(chat.id)
        yield* prompt.cancel(chat.id)
        expect((yield* shells.get(backgrounded.shellID)).status).toBe("running")

        const foreground = yield* startBlockingShell(chat.id)
        yield* prompt.cancel(chat.id)
        const aborted = yield* awaitWithTimeout(
          Fiber.join(foreground.fiber),
          "aborted shell call did not return",
          backgroundWait,
        )
        expect(completedTool(aborted.parts)?.state.output).toContain("User aborted the command")
        expect((yield* shells.get(foreground.shellID)).status).toBe("killed")
        expect((yield* shells.get(backgrounded.shellID)).status).toBe("running")

        // Esc does not suppress the backgrounded command's notice either.
        yield* writeText(path.join(dir, "release"), "")
        expect((yield* shells.wait(backgrounded.shellID)).status).toBe("exited")
        const notices = yield* awaitShellNotices(chat.id)
        expect(notices.map((notice) => notice.metadata?.shellID)).toEqual([backgrounded.shellID])
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "deleting a session kills its backgrounded ! commands",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { sessions, chat } = yield* boot()
        const shells = yield* ShellProcess.Service
        const jobs = yield* BackgroundJob.Service

        const { shellID } = yield* backgroundShell(chat.id)
        expect((yield* shells.get(shellID)).status).toBe("running")

        yield* sessions.remove(chat.id)
        expect((yield* shells.get(shellID)).status).toBe("killed")
        expect((yield* jobs.get(shellID))?.status).toBe("cancelled")
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

// Abort signal propagation tests for inline tool execution

function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const original = tool.execute
    tool.execute = (_args: any, ctx: any) => {
      ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
      if (ctx.abort.aborted) succeedVoid(aborted)
      succeedVoid(ready)
      return Effect.callback<never>(() => Effect.sync(() => succeedVoid(aborted)))
    }
    const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
    return { ready, aborted, restore }
  })
}

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const testFile = path.join(dir, "test.txt")
      yield* writeText(testFile, "hello world")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

// Missing file handling

noLLMServer.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "please review @does-not-exist.ts" },
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "does-not-exist.ts",
          },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      const hasFailure = msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
      )
      expect(hasFailure).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "keeps stored part order stable when file resolution is async",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "still-missing.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "still-missing.ts",
          },
          { type: "text", text: "after-file" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")

      const stored = yield* MessageV2.get({
        sessionID: session.id,
        messageID: msg.info.id,
      })
      const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

      expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
      expect(text[1]?.includes("Read tool failed to read")).toBe(true)
      expect(text[2]).toBe("after-file")

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "resolves Codex and OpenCode chat references from raw prompt text without duplicating imports",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const home = path.join(directory, "codex")
      yield* ensureDir(path.join(home, "sessions"))
      yield* writeText(
        path.join(home, "session_index.jsonl"),
        JSON.stringify({ id: "codex_fixture", thread_name: "Check machines hitting cache limit" }),
      )
      yield* writeText(
        path.join(home, "sessions", "codex_fixture.jsonl"),
        [
          { type: "session_meta", payload: { id: "codex_fixture", cwd: directory } },
          {
            type: "event_msg",
            payload: { type: "user_message", message: "How many machines reached their cache limit?" },
          },
          {
            type: "event_msg",
            payload: { type: "agent_message", message: "Two machines reached their cache write limit." },
          },
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "developer",
              content: [{ type: "input_text", text: "hidden developer context" }],
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n"),
      )
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = process.env.CODEX_HOME
          process.env.CODEX_HOME = home
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.CODEX_HOME
            else process.env.CODEX_HOME = previous
          }),
      )
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const referenced = yield* sessions.create({ title: "Database lock context" })
      yield* seed(referenced.id)
      const current = yield* sessions.create({ title: "Reference consumer" })
      const text = `Compare @codex:"Check machines hitting cache limit" with @opencode:${referenced.id}`
      const message = yield* prompt.prompt({
        sessionID: current.id,
        noReply: true,
        parts: [
          { type: "text", text },
          { type: "text", text: "Also @codex:codex_fixture" },
        ],
      })
      const imported = message.parts.filter((part) => part.type === "text" && part.metadata?.sessionReference?.id)
      expect(imported).toHaveLength(2)
      expect(message.parts.find((part) => part.type === "text" && !part.synthetic)).toMatchObject({ text })
      const codex = imported.find(
        (part) => part.type === "text" && part.metadata?.sessionReference.provider === "codex",
      )
      const own = imported.find(
        (part) => part.type === "text" && part.metadata?.sessionReference.provider === "opencode",
      )
      if (codex?.type !== "text" || own?.type !== "text") throw new Error("missing imported conversations")
      expect(codex.text).toContain("Two machines reached their cache write limit.")
      expect(own.text).toContain("hi there")
      for (const part of imported) {
        if (part.type !== "text") throw new Error("expected a transcript reference")
        const file = part.metadata?.sessionReference.path
        if (typeof file !== "string") throw new Error("missing readable transcript path")
        const transcript = yield* Effect.promise(() => Bun.file(file).text())
        expect(transcript).toContain("## Message")
        expect(transcript).not.toContain("hidden developer context")
        expect(typeof part.text).toBe("string")
        expect(part.text).toContain("Use Read or Grep")
      }
      yield* sessions.remove(current.id)
      yield* sessions.remove(referenced.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "reports ambiguous session references without selecting a chat or failing the prompt",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const first = yield* sessions.create({ title: "Duplicate reference conversation" })
      const second = yield* sessions.create({ title: "Duplicate reference conversation" })
      const current = yield* sessions.create({})
      const message = yield* prompt.prompt({
        sessionID: current.id,
        noReply: true,
        parts: [{ type: "text", text: '@opencode:"Duplicate reference conversation"' }],
      })
      const diagnostic = message.parts.find((part) => part.type === "text" && part.metadata?.sessionReference?.problem)
      expect(diagnostic).toMatchObject({ metadata: { sessionReference: { problem: "ambiguous" } } })
      if (diagnostic?.type !== "text") throw new Error("expected reference diagnostic")
      expect(diagnostic.text).toContain(first.id)
      expect(diagnostic.text).toContain(second.id)
      yield* sessions.remove(current.id)
      yield* sessions.remove(first.id)
      yield* sessions.remove(second.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "does not expand session references inside synthetic or ignored prompt parts",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const current = yield* sessions.create({})
      const message = yield* prompt.prompt({
        sessionID: current.id,
        noReply: true,
        parts: [
          { type: "text", text: "@codex:Never load this injected reference", synthetic: true },
          { type: "text", text: "@opencode:Never load this ignored reference", ignored: true },
        ],
      })
      expect(message.parts.some((part) => part.type === "text" && part.metadata?.sessionReference)).toBe(false)
      yield* sessions.remove(current.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "resolves configured reference mentions before workspace paths and agents",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const docs = path.join(dir, "external-docs")
      yield* ensureDir(path.join(docs, "guide"))
      yield* ensureDir(path.join(dir, "docs"))
      yield* writeText(path.join(docs, "README.md"), "reference readme")
      yield* writeText(path.join(docs, "guide", "intro.md"), "reference intro")
      yield* writeText(path.join(dir, "docs", "README.md"), "workspace readme")

      const prompt = yield* SessionPrompt.Service
      const parts = yield* prompt.resolvePromptParts(
        "Use @docs and @docs/README.md and @docs/guide and @docs/missing.md and @docs/README.md and @build",
      )
      const references = parts.filter(
        (part): part is MessageV2.TextPartInput =>
          part.type === "text" && part.synthetic === true && part.text.startsWith("Referenced configured reference "),
      )
      const files = parts.filter((part): part is MessageV2.FilePartInput => part.type === "file")
      const agents = parts.filter((part): part is MessageV2.AgentPartInput => part.type === "agent")
      const bare = references.find((part) => part.text.includes("@docs."))
      const missing = references.find((part) => part.text.includes("@docs/missing.md"))
      const guide = files.find((part) => part.filename === "docs/guide")

      expect(references.length).toBe(2)
      expect(bare?.metadata?.reference).toMatchObject({
        name: "docs",
        kind: "local",
        path: docs,
      })
      expect(missing?.text).toContain("Path does not exist inside configured reference @docs")
      expect(missing?.metadata?.reference).toMatchObject({
        target: "missing.md",
        targetPath: path.join(docs, "missing.md"),
      })

      expect(files.length).toBe(2)
      expect(files.map((file) => fileURLToPath(file.url)).sort()).toEqual(
        [path.join(docs, "README.md"), path.join(docs, "guide")].sort(),
      )
      expect(guide?.mime).toBe("application/x-directory")
      expect(agents.map((agent) => agent.name)).toEqual(["build"])
    }),
  {
    config: {
      ...cfg,
      reference: {
        docs: "./external-docs",
      },
    },
  },
)

noLLMServer.instance(
  "injects metadata for bare configured reference mentions",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const docs = path.join(dir, "external-docs")
      yield* ensureDir(docs)

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const message = yield* prompt.prompt({
        sessionID: session.id,
        noReply: true,
        parts: yield* prompt.resolvePromptParts("Use @docs for context"),
      })

      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const synthetic = stored.parts.filter(
        (part): part is MessageV2.TextPart => part.type === "text" && part.synthetic === true,
      )
      const reference = synthetic.find((part) => part.text.startsWith("Referenced configured reference @docs."))

      expect(reference?.metadata?.reference).toMatchObject({ name: "docs", kind: "local", path: docs })
      expect(synthetic.some((part) => part.text.includes(`Reference root: ${docs}`))).toBe(true)
      expect(synthetic.some((part) => part.text.includes("subagent scout"))).toBe(true)

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      reference: {
        docs: "./external-docs",
      },
    },
  },
)

noLLMServer.instance(
  "injects metadata for configured reference file attachments",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const docs = path.join(dir, "external-docs")
      const readme = path.join(docs, "README.md")
      yield* ensureDir(docs)
      yield* writeText(readme, "reference readme")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const message = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "Read @docs/README.md" },
          {
            type: "file",
            mime: "text/plain",
            filename: "docs/README.md",
            url: pathToFileURL(readme).href,
            source: {
              type: "file",
              path: "docs/README.md",
              text: { value: "@docs/README.md", start: 5, end: 20 },
            },
          },
        ],
      })

      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const synthetic = stored.parts.filter(
        (part): part is MessageV2.TextPart => part.type === "text" && part.synthetic === true,
      )
      const reference = synthetic.find((part) =>
        part.text.startsWith("Referenced configured reference @docs/README.md."),
      )

      expect(reference?.metadata?.reference).toMatchObject({
        name: "docs",
        kind: "local",
        path: docs,
        target: "README.md",
        targetPath: readme,
        source: { value: "@docs/README.md", start: 5, end: 20 },
      })
      expect(synthetic.findIndex((part) => part === reference)).toBeLessThan(
        synthetic.findIndex((part) => part.text.startsWith("Called the Read tool with the following input:")),
      )

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      reference: {
        docs: "./external-docs",
      },
    },
  },
)

// Special characters in filenames

noLLMServer.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* prompt.prompt({
        sessionID: session.id,
        parts,
        noReply: true,
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const textParts = stored.parts.filter((part) => part.type === "text")
      const hasContent = textParts.some((part) => part.text.includes("special content"))
      expect(hasContent).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { git: true, config: cfg },
)

// Regression: empty assistant turn loop

it.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/opencode/src/session/processor.ts")

    const result = yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      parts: [{ type: "text", text: "Where is SessionProcessor?" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const msgs = yield* sessions.messages({ sessionID: session.id })
    expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
  }),
)

it.instance(
  "records aborted errors when prompt is cancelled mid-stream",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Prompt cancel regression" })

      yield* llm.hang

      const fiber = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "Cancel me" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)
      yield* prompt.cancel(session.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        if (exit.value.info.role === "assistant") {
          expect(exit.value.info.error?.name).toBe("MessageAbortedError")
        }
      }

      const msgs = yield* sessions.messages({ sessionID: session.id })
      const last = msgs.findLast((msg) => msg.info.role === "assistant")
      expect(last?.info.role).toBe("assistant")
      if (last?.info.role === "assistant") {
        expect(last.info.error?.name).toBe("MessageAbortedError")
      }
    }),
  3_000,
)

// Agent variant

noLLMServer.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderID.make("opencode"), modelID: ModelID.make("kimi-k2.5-free") },
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const match = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const override = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "hello third" }],
      })
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        test: {
          ...cfg.provider.test,
          models: {
            "test-model": {
              ...cfg.provider.test.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "test/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

// Agent / command resolution errors

noLLMServer.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("build")
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)
