import { afterEach, describe, expect } from "bun:test"
import { jsonSchema } from "ai"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { childToolOverrides, type TaskPromptOps } from "@/agent/child-session"
import { Collaboration } from "@/agent/collaboration"
import { SubagentLimit } from "@/agent/subagent-limit"
import { SubagentRun } from "@/agent/subagent-run"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { LLMRequestPrep } from "@/session/llm/request"
import { MessageV2 } from "@/session/message-v2"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import type { Tool } from "@/tool/tool"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

afterEach(disposeAllInstances)

const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }
const model = {
  id: ref.modelID,
  providerID: ref.providerID,
  api: { id: ref.modelID, url: "https://unused.invalid", npm: "@ai-sdk/openai-compatible" },
  name: "Permission fixture",
  capabilities: {
    temperature: false,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 16_000, output: 4_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
} satisfies Provider.Model
const it = testEffect(
  SubagentRun.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Agent.defaultLayer,
        BackgroundJob.defaultLayer,
        Collaboration.defaultLayer,
        Config.defaultLayer,
        Permission.defaultLayer,
        Plugin.defaultLayer,
        Session.defaultLayer,
        SessionStatus.defaultLayer,
        SubagentLimit.defaultLayer,
        RuntimeFlags.layer({}),
      ),
    ),
  ),
)

function reply(input: SessionPrompt.PromptInput): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID: input.sessionID,
      parentID: input.messageID ?? MessageID.ascending(),
      role: "assistant",
      mode: input.agent ?? "build",
      agent: input.agent ?? "build",
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now(), completed: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text: "done" }],
  }
}

const setup = Effect.fn("FollowupPermissionTest.setup")(function* (rules: Permission.Ruleset = []) {
  const agents = yield* Agent.Service
  const sessions = yield* Session.Service
  const permission = yield* Permission.Service
  const collaboration = yield* Collaboration.Service
  const run = yield* SubagentRun.Service
  const jobs = yield* BackgroundJob.Service
  const plugin = yield* Plugin.Service
  const flags = yield* RuntimeFlags.Service
  const requests: { sessionID: SessionID; permission: string; patterns: readonly string[] }[] = []
  const ops: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
    prompt: (input) =>
      Effect.gen(function* () {
        const user = yield* sessions.updateMessage({
          id: input.messageID ?? MessageID.ascending(),
          sessionID: input.sessionID,
          role: "user",
          agent: input.agent ?? "build",
          model: input.model ?? ref,
          tools: input.tools,
          time: { created: Date.now() },
        })
        const result = reply({ ...input, messageID: user.id })
        yield* sessions.updateMessage(result.info)
        yield* Effect.forEach(result.parts, (part) => sessions.updatePart(part))
        return result
      }),
    loop: (input) =>
      collaboration
        .inbox({ sessionID: input.sessionID, drain: true })
        .pipe(Effect.orDie, Effect.as(reply({ sessionID: input.sessionID, parts: [] }))),
  }
  const root = yield* sessions.create({ title: "permission root", agent: "build", permission: rules })
  yield* ops.prompt({ sessionID: root.id, model: ref, agent: "build", parts: [] })

  const context = Effect.fn("FollowupPermissionTest.context")(function* (sessionID: SessionID) {
    const session = yield* sessions.get(sessionID)
    const agent = yield* agents.get(session.agent ?? "build")
    const assistant = (yield* sessions.messages({ sessionID })).findLast((item) => item.info.role === "assistant")
    if (!assistant) return yield* Effect.die("fixture session needs an assistant turn")
    return {
      sessionID,
      messageID: assistant.info.id,
      agent: agent.name,
      abort: new AbortController().signal,
      messages: [],
      extra: { promptOps: ops },
      metadata: () => Effect.void,
      // Use the same policy boundary as SessionTools, not an allow-all ask stub.
      ask: (request) => {
        requests.push({ sessionID, permission: request.permission, patterns: request.patterns })
        return permission
          .ask({
            ...request,
            sessionID,
            ruleset: Permission.merge(agent.permission, session.permission ?? []),
          })
          .pipe(Effect.orDie)
      },
    } satisfies Tool.Context
  })

  const visible = Effect.fn("FollowupPermissionTest.visible")(function* (sessionID: SessionID) {
    const session = yield* sessions.get(sessionID)
    const user = (yield* sessions.messages({ sessionID })).findLast((item) => item.info.role === "user")
    if (!user || user.info.role !== "user") return yield* Effect.die("fixture session needs a user turn")
    const prepared = yield* LLMRequestPrep.prepare({
      user: user.info,
      sessionID,
      model,
      agent: yield* agents.get(session.agent ?? "build"),
      permission: session.permission,
      system: [],
      messages: [],
      tools: Object.fromEntries(
        ["spawn_agent", "followup_task", "task"].map((name) => [name, { inputSchema: jsonSchema({ type: "object" }) }]),
      ),
      provider: { id: ref.providerID, name: "test", source: "config", env: [], options: {}, models: {} },
      auth: undefined,
      plugin,
      flags,
      isWorkflow: false,
    })
    return Object.keys(prepared.tools)
  })

  const answer = Effect.fn("FollowupPermissionTest.answer")(function* (
    operation: Effect.Effect<SubagentRun.Result, Error>,
    sessionID: SessionID,
    reply: Permission.Reply,
  ) {
    const fiber = yield* operation.pipe(Effect.forkScoped)
    const pending = yield* pollWithTimeout(
      permission.list().pipe(Effect.map((requests) => requests.find((request) => request.sessionID === sessionID))),
      "inherited spawn policy did not request approval",
    )
    expect(pending).toMatchObject({ permission: "spawn_agent", patterns: ["*"] })
    yield* permission.reply({ requestID: pending.id, reply })
    return yield* Fiber.join(fiber)
  })

  return { agents, sessions, permission, collaboration, run, jobs, requests, root, context, visible, answer }
})

describe("agent.subagent-followup-permission", () => {
  for (const policy of ["default", "allow"] as const) {
    it.instance(`default child can follow up its completed grandchild with ${policy} spawn policy`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup(
          policy === "default" ? [] : [{ permission: "spawn_agent", pattern: "*", action: "allow" }],
        )
        const child = yield* fixture.run.run({
          context: yield* fixture.context(fixture.root.id),
          taskName: "child",
          message: "Delegate the work.",
        })
        expect((yield* fixture.jobs.wait({ id: child.sessionID })).info?.status).toBe("completed")

        const build = yield* fixture.agents.get("build")
        const childSession = yield* fixture.sessions.get(child.sessionID)
        const rules = Permission.merge(build.permission, childSession.permission ?? [])
        const overrides = childToolOverrides({ agent: build })
        expect(Permission.evaluate("spawn_agent", "*", rules).action).toBe("allow")
        expect(Permission.evaluate("task", "build", rules).action).toBe("deny")
        expect(overrides).toMatchObject({ task: false })
        expect(overrides).not.toHaveProperty("followup_task")
        expect(Permission.disabled(["spawn_agent", "followup_task", "task"], rules)).toEqual(new Set(["task"]))
        expect(yield* fixture.visible(child.sessionID)).toEqual(["followup_task", "spawn_agent"])

        const childContext = yield* fixture.context(child.sessionID)
        const grandchild = yield* fixture.run.run({
          context: childContext,
          taskName: "grandchild",
          message: "Complete the first task.",
        })
        expect(grandchild.path).toBe("/root/child/grandchild")
        expect((yield* fixture.jobs.wait({ id: grandchild.sessionID })).info?.status).toBe("completed")
        expect((yield* fixture.collaboration.member(grandchild.sessionID))?.status).toBe("completed")

        const resumed = yield* fixture.run.followup({
          context: childContext,
          target: grandchild.path,
          message: "Complete the follow-up task.",
        })
        expect(resumed).toEqual(grandchild)
        expect((yield* fixture.jobs.wait({ id: resumed.sessionID })).info?.status).toBe("completed")
        expect(fixture.requests.map((request) => request.permission)).toEqual([
          "spawn_agent",
          "spawn_agent",
          "spawn_agent",
        ])
        expect(yield* fixture.permission.list()).toEqual([])
        expect(Permission.evaluate("task", "build", rules).action).toBe("deny")
      }),
    )
  }

  for (const name of ["spawn_agent", "spawn_*", "*"]) {
    it.instance(`inherits ${name} ask for spawn and followup without enabling legacy task`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup([{ permission: name, pattern: "*", action: "ask" }])
        const child = yield* fixture.answer(
          fixture.run.run({
            context: yield* fixture.context(fixture.root.id),
            taskName: "child",
            message: "Delegate the work.",
          }),
          fixture.root.id,
          "once",
        )
        expect((yield* fixture.jobs.wait({ id: child.sessionID })).info?.status).toBe("completed")
        expect(yield* fixture.visible(child.sessionID)).toEqual(["followup_task", "spawn_agent"])

        const context = yield* fixture.context(child.sessionID)
        const grandchild = yield* fixture.answer(
          fixture.run.run({ context, taskName: "grandchild", message: "Complete the first task." }),
          child.sessionID,
          "once",
        )
        expect((yield* fixture.jobs.wait({ id: grandchild.sessionID })).info?.status).toBe("completed")
        const before = yield* fixture.collaboration.member(grandchild.sessionID)

        const rejected = yield* fixture
          .answer(
            fixture.run.followup({ context, target: grandchild.path, message: "Must require a new approval." }),
            child.sessionID,
            "reject",
          )
          .pipe(Effect.exit)
        if (Exit.isSuccess(rejected)) return yield* Effect.die("rejected followup must not start")
        expect(Cause.squash(rejected.cause)).toBeInstanceOf(Permission.RejectedError)
        expect(yield* fixture.collaboration.member(grandchild.sessionID)).toEqual(before)

        const resumed = yield* fixture.answer(
          fixture.run.followup({ context, target: grandchild.path, message: "Approved follow-up task." }),
          child.sessionID,
          "once",
        )
        expect(resumed).toEqual(grandchild)
        expect((yield* fixture.jobs.wait({ id: resumed.sessionID })).info?.status).toBe("completed")
        const rules = Permission.merge(
          (yield* fixture.agents.get("build")).permission,
          (yield* fixture.sessions.get(child.sessionID)).permission ?? [],
        )
        expect(Permission.evaluate("spawn_agent", "*", rules).action).toBe("ask")
        expect(Permission.evaluate("task", "build", rules).action).toBe("deny")
        expect(yield* fixture.permission.list()).toEqual([])
      }),
    )

    it.instance(`inherited ${name} deny blocks spawn and followup and hides both tools`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup()
        const child = yield* fixture.run.run({
          context: yield* fixture.context(fixture.root.id),
          taskName: "child",
          message: "Delegate the work.",
        })
        expect((yield* fixture.jobs.wait({ id: child.sessionID })).info?.status).toBe("completed")
        const grandchild = yield* fixture.run.run({
          context: yield* fixture.context(child.sessionID),
          taskName: "grandchild",
          message: "Complete the first task.",
        })
        expect((yield* fixture.jobs.wait({ id: grandchild.sessionID })).info?.status).toBe("completed")
        const before = yield* fixture.collaboration.member(grandchild.sessionID)
        const build = yield* fixture.agents.get("build")

        // Seed the derived restrictive policy around an already completed target.
        // This does not assume that changing a parent's policy updates live descendants.
        yield* fixture.sessions.setPermission({
          sessionID: child.sessionID,
          permission: deriveSubagentSessionPermission({
            parentSessionPermission: [{ permission: name, pattern: "*", action: "deny" }],
            parentAgent: build,
            subagent: build,
          }),
        })
        expect(yield* fixture.visible(child.sessionID)).toEqual([])
        const context = yield* fixture.context(child.sessionID)
        const spawn = yield* fixture.run
          .run({ context, taskName: "denied", message: "Must not create a child." })
          .pipe(Effect.exit)
        const followup = yield* fixture.run
          .followup({ context, target: grandchild.path, message: "Must not resume." })
          .pipe(Effect.exit)
        for (const denied of [spawn, followup]) {
          if (Exit.isSuccess(denied)) return yield* Effect.die("inherited denial must reject delegation")
          expect(Cause.squash(denied.cause)).toBeInstanceOf(Permission.DeniedError)
        }
        expect(fixture.requests.slice(-2).map((request) => request.permission)).toEqual(["spawn_agent", "spawn_agent"])
        expect((yield* fixture.sessions.children(child.sessionID)).map((session) => session.id)).toEqual([
          grandchild.sessionID,
        ])
        expect(yield* fixture.collaboration.member(grandchild.sessionID)).toEqual(before)
        expect(yield* fixture.permission.list()).toEqual([])
      }),
    )
  }

  it.instance("spawn allow does not advertise an explicitly denied followup tool", () =>
    Effect.gen(function* () {
      const fixture = yield* setup([
        { permission: "spawn_agent", pattern: "*", action: "allow" },
        { permission: "followup_task", pattern: "*", action: "deny" },
      ])
      const child = yield* fixture.run.run({
        context: yield* fixture.context(fixture.root.id),
        taskName: "child",
        message: "Complete the task.",
      })
      expect((yield* fixture.jobs.wait({ id: child.sessionID })).info?.status).toBe("completed")
      expect(yield* fixture.visible(child.sessionID)).toEqual(["spawn_agent"])
    }),
  )
})
