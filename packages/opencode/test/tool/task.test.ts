import { afterEach, describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { Agent } from "../../src/agent/agent"
import { SubagentLimit } from "@/agent/subagent-limit"
import { Team } from "@/agent/team"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    Plugin.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    SubagentLimit.defaultLayer,
    Team.defaultLayer,
    ToolRegistry.defaultLayer,
    RuntimeFlags.layer(flags),
  )

const it = testEffect(layer())
const background = testEffect(layer())

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (
  opts: { title?: string; userModel?: MessageV2.User["model"] } = {},
) {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: opts.title ?? "Pinned" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: opts.userModel ?? ref,
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
  return { chat, user, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
    loop: (input) => Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, opts?.text ?? "done")),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`task_id: ${child.id}`)
      expect(seen?.sessionID).toBe(child.id)
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  // A subagent the interrupted turn waited for. It finishes once `finish` resolves; its completion notice for the
  // parent lands in `delivered`.
  function slowSubagent() {
    const started = defer<SessionPrompt.PromptInput>()
    const finish = defer<void>()
    const delivered = defer<SessionPrompt.PromptInput>()
    const cancelled: SessionID[] = []
    const promptOps: TaskPromptOps = {
      ...stubOps(),
      cancel: (sessionID) =>
        Effect.sync(() => {
          cancelled.push(sessionID)
        }),
      prompt: (input) => {
        if (input.noReply)
          return Effect.sync(() => {
            delivered.resolve(input)
            return reply(input, "")
          })
        started.resolve(input)
        return Effect.promise(() => finish.promise).pipe(Effect.as(reply(input, "subagent result")))
      },
    }
    return { started, finish, delivered, cancelled, promptOps }
  }

  it.instance("execute leaves the subagent running in the background when the abort signal fires", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()
      const subagent = slowSubagent()
      const abort = new AbortController()

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps: subagent.promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const child = yield* Effect.promise(() => subagent.started.promise)
      abort.abort()
      const result = yield* awaitWithTimeout(Fiber.join(fiber), "task call did not return after the abort")
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("interrupted the main turn")
      expect((yield* jobs.get(child.sessionID))?.status).toBe("running")
      expect(subagent.cancelled).toEqual([])

      // The detached subagent still reports its result to the parent session.
      subagent.finish.resolve()
      const notice = yield* Effect.promise(() => subagent.delivered.promise)
      expect(notice.sessionID).toBe(chat.id)
      expect(JSON.stringify(notice.parts)).toContain("subagent result")
    }),
  )

  it.instance("execute leaves the subagent running when the call itself is interrupted", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()
      const subagent = slowSubagent()

      // A /command subtask runs the tool inside the turn's fiber, so interrupting the turn interrupts the call.
      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: subagent.promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const child = yield* Effect.promise(() => subagent.started.promise)
      yield* Fiber.interrupt(fiber)
      const job = yield* jobs.get(child.sessionID)
      expect(job?.status).toBe("running")
      expect(job?.background).toBe(true)
      expect(subagent.cancelled).toEqual([])

      subagent.finish.resolve()
      const notice = yield* Effect.promise(() => subagent.delivered.promise)
      expect(JSON.stringify(notice.parts)).toContain("subagent result")
    }),
  )

  it.instance("a stopped parent records a background result without announcing or starting a turn", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()
      const toasts: string[] = []
      yield* (yield* bus.subscribe(TuiEvent.ToastShow)).pipe(
        Stream.runForEach((event) => Effect.sync(() => toasts.push(event.properties.message))),
        Effect.forkScoped,
      )
      const checked = defer<SessionID>()
      const loops: SessionID[] = []
      const promptOps: TaskPromptOps = {
        ...stubOps({ text: "subagent result" }),
        // Records the notice like the real `noReply` prompt, so the idle parent sees it as its newest message.
        prompt: (input) =>
          input.noReply
            ? sessions
                .updateMessage({
                  id: MessageID.ascending(),
                  role: "user",
                  sessionID: input.sessionID,
                  agent: input.agent ?? "build",
                  model: input.model ?? ref,
                  time: { created: Date.now() },
                })
                .pipe(Effect.map((info) => ({ info, parts: [] })))
            : Effect.succeed(reply(input, "subagent result")),
        loop: (input) =>
          Effect.sync(() => {
            loops.push(input.sessionID)
            return reply({ sessionID: input.sessionID, parts: [] }, "resumed")
          }),
        stopped: (sessionID) =>
          Effect.sync(() => {
            checked.resolve(sessionID)
            return true
          }),
      }

      yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(
        yield* awaitWithTimeout(
          Effect.promise(() => checked.promise),
          "wakeup never checked the parent",
        ),
      ).toBe(chat.id)
      // The wakeup returns right after the check; give a toast or loop the chance to (wrongly) follow it.
      yield* Effect.sleep("200 millis")
      expect(toasts).toEqual([])
      expect(loops).toEqual([])
      const latest = yield* sessions.messages({ sessionID: chat.id, limit: 1 })
      expect(latest[0]?.info.role).toBe("user")
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`task_id: ${result.metadata.sessionId}`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "workflow",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "allow",
          },
          {
            permission: "read",
            pattern: "*",
            action: "allow",
          },
        ])
        expect(seen?.tools).toEqual({
          todowrite: false,
          workflow: false,
          bash: false,
          read: false,
        })
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("fork=true inherits the parent session context into a bounded child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed({ title: "Parent" })
      const def = yield* (yield* TaskTool).init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "forked", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        { description: "dig deeper", prompt: "continue the investigation", fork: true },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      // a NEW forked session, distinct from the parent and linked as its child
      const forkedID = SessionID.make(result.metadata.sessionId as string)
      expect(forkedID).not.toBe(chat.id)
      const forked = yield* sessions.get(forkedID)
      expect(forked.parentID).toBe(chat.id)

      // the fork ran on the forked session, which inherited the parent's prior messages
      expect(seen?.sessionID).toBe(forkedID)
      const inherited = yield* sessions.findMessage(forkedID, (m) => m.info.role === "user")
      expect(Option.isSome(inherited)).toBe(true)

      // a fork cannot fork again: task is denied on the forked session
      expect(forked.permission?.some((r) => r.permission === "task" && r.action === "deny")).toBe(true)

      expect(result.output).toContain("forked")
    }),
  )

  it.instance("team spawn registers the lead and the named member in the shared roster", () =>
    Effect.gen(function* () {
      const teamSvc = yield* Team.Service
      const { chat, assistant } = yield* seed()
      const def = yield* (yield* TaskTool).init()
      const promptOps = stubOps({ text: "ok" })

      const result = yield* def.execute(
        { description: "scan files", prompt: "scan the repo", subagent_type: "general", team: "alpha", name: "scanner" },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const childID = SessionID.make(result.metadata.sessionId as string)
      expect((yield* teamSvc.whoami(childID))?.name).toBe("scanner")
      expect((yield* teamSvc.whoami(chat.id))?.name).toBe("lead")
      const roster = yield* teamSvc.roster("alpha")
      expect(roster.map((m) => m.name).sort()).toEqual(["lead", "scanner"])
    }),
  )

  it.instance("execute propagates parent service tier, upstream, and variant to the subagent prompt", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed({
        userModel: {
          ...ref,
          serviceTier: "fast",
          upstream: "anthropic",
          variant: "thinking",
        },
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

      yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(seen?.serviceTier).toBe("fast")
      expect(seen?.upstream).toBe("anthropic")
      expect(seen?.variant).toBe("thinking")
    }),
  )

  it.instance(
    "execute lets the subagent agent's pinned variant win over the inherited parent variant",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed({
          userModel: {
            ...ref,
            serviceTier: "fast",
            variant: "parent-variant",
          },
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "pinned",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        // Subagent agent has its own `variant` config — it should win even
        // when the parent's user message has a different variant. The tier
        // (no agent override exists) still inherits.
        expect(seen?.variant).toBe("agent-variant")
        expect(seen?.serviceTier).toBe("fast")
      }),
    {
      config: {
        agent: {
          pinned: {
            mode: "subagent",
            variant: "agent-variant",
          },
        },
      },
    },
  )

  it.instance("accepts background execution without any experimental gating", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      // Background mode is now first-class — the call should succeed and
      // return a "task started" stub with a jobId on metadata.
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const result = exit.value as { metadata: { jobId?: string }; output: string }
        expect(typeof result.metadata.jobId).toBe("string")
        expect(result.output).toContain("Background task started")
      }
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("state: running")
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent resume loop", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.noReply
                  ? Effect.gen(function* () {
                      const user = yield* sessions.updateMessage({
                        id: input.messageID ?? MessageID.ascending(),
                        role: "user",
                        sessionID: input.sessionID,
                        agent: input.agent ?? "build",
                        model: input.model ?? ref,
                        time: { created: Date.now() },
                      })
                      const parts = input.parts.map((part) => ({
                        ...part,
                        id: part.id ?? PartID.ascending(),
                        messageID: user.id,
                        sessionID: input.sessionID,
                      }))
                      yield* Effect.forEach(parts, (part) => sessions.updatePart(part), { discard: true })
                      return { info: user, parts }
                    })
                  : Effect.succeed(reply(input, "background done")),
              loop: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("interrupting a parent run stops its turn but leaves its subagents running", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      const turn = yield* startTurn(chat.id)

      expect(yield* runState.interrupt(chat.id)).toBe(true)
      expect((yield* awaitWithTimeout(Fiber.join(turn), "interrupted turn did not settle")).info.id).toBe(
        stopped.info.id,
      )
      expect((yield* jobs.get(child.id))?.status).toBe("running")
      // Automatic work (goal mode, completion wakeups) must not restart the session.
      expect((yield* runState.continuation(chat.id)).aborted).toBe(true)
      expect(yield* runState.interrupt(chat.id)).toBe(false)
    }),
  )

  it.instance("stopping subagents cancels them recursively but leaves the session's own turn and shells", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root" })
      // The session is itself a subagent: stopping its subagents must not stop it.
      const chat = yield* sessions.create({ parentID: root.id, title: "chat" })
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })
      const subagent = (id: SessionID, parentID: SessionID) =>
        jobs.start({ id, type: "task", metadata: { parentSessionId: parentID, sessionId: id }, run: Effect.never })
      yield* subagent(chat.id, root.id)
      yield* subagent(child.id, chat.id)
      yield* subagent(grandchild.id, child.id)
      yield* jobs.start({
        id: "shell_stop_subagents",
        type: "shell",
        metadata: { ownerSessionID: chat.id },
        run: Effect.never,
      })
      const turn = yield* startTurn(chat.id)
      // A child's run fiber lives outside its job, so stopping the job alone would leave the child busy.
      const childTurn = yield* startTurn(child.id)

      expect((yield* runState.stopSubagents(chat.id)).toSorted()).toEqual([child.id, grandchild.id].toSorted())
      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
      expect((yield* awaitWithTimeout(Fiber.join(childTurn), "child turn was not stopped")).info.id).toBe(
        stopped.info.id,
      )
      expect((yield* jobs.get(chat.id))?.status).toBe("running")
      expect((yield* jobs.get("shell_stop_subagents"))?.status).toBe("running")
      expect(Exit.isFailure(yield* runState.assertNotBusy(chat.id).pipe(Effect.exit))).toBe(true)
      expect((yield* runState.continuation(chat.id)).aborted).toBe(false)

      yield* runState.cancel(chat.id)
      yield* Fiber.join(turn)
    }),
  )
})

const stopped = reply({ sessionID: SessionID.make("ses_stopped"), parts: [] }, "stopped")

// Starts a turn that runs until it is cancelled, then resolves with `stopped`.
const startTurn = Effect.fn("TaskToolTest.startTurn")(function* (sessionID: SessionID) {
  const runState = yield* SessionRunState.Service
  const turn = yield* runState.ensureRunning(sessionID, Effect.succeed(stopped), Effect.never).pipe(Effect.forkChild)
  yield* pollWithTimeout(
    runState
      .assertNotBusy(sessionID)
      .pipe(Effect.match({ onFailure: () => true as const, onSuccess: () => undefined })),
    `turn for ${sessionID} never started`,
  )
  return turn
})
