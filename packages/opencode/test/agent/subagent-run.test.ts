import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { childToolOverrides } from "@/agent/child-session"
import { Collaboration, MAX_MAILBOX_PAYLOAD_CHARS } from "@/agent/collaboration"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { SubagentRun } from "@/agent/subagent-run"
import { SubagentLimit } from "@/agent/subagent-limit"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { MessageV2 } from "@/session/message-v2"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import type { Tool } from "@/tool/tool"
import { Parameters as SpawnAgentParameters } from "@/tool/spawn_agent"
import { ProviderID, ModelID } from "@/provider/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }

const dependencies = Layer.mergeAll(
  Agent.defaultLayer,
  BackgroundJob.defaultLayer,
  Collaboration.defaultLayer,
  Config.defaultLayer,
  Plugin.defaultLayer,
  Session.defaultLayer,
  SubagentLimit.defaultLayer,
  RuntimeFlags.layer({}),
)
const it = testEffect(SubagentRun.layer.pipe(Layer.provideMerge(dependencies)))

function reply(input: SessionPrompt.PromptInput, text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "build",
      agent: input.agent ?? "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  }
}

const seed = Effect.fn("SubagentRunTest.seed")(function* () {
  const sessions = yield* Session.Service
  const parent = yield* sessions.create({ title: "parent", agent: "build" })
  const previousUser = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: parent.id,
    agent: "build",
    model: { ...ref, variant: "ultra", serviceTier: "priority", upstream: "origin" },
    time: { created: Date.now() },
  })
  yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID: previousUser.id,
    sessionID: parent.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now(), completed: Date.now() },
    finish: "stop",
  })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: parent.id,
    agent: "build",
    model: { ...ref, variant: "ultra", serviceTier: "priority", upstream: "origin" },
    time: { created: Date.now() },
  })
  const assistant = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: parent.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  })
  return { parent, assistant }
})

function context(input: {
  sessionID: Tool.Context["sessionID"]
  messageID: Tool.Context["messageID"]
  ops: {
    cancel(sessionID: Tool.Context["sessionID"]): Effect.Effect<void>
    resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
    prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
    loop(input: SessionPrompt.LoopInput): Effect.Effect<MessageV2.WithParts>
  }
  metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => Effect.Effect<void>
  ask?: Tool.Context["ask"]
}): Tool.Context {
  return {
    sessionID: input.sessionID,
    messageID: input.messageID,
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps: input.ops },
    messages: [],
    metadata: input.metadata ?? (() => Effect.void),
    ask: input.ask ?? (() => Effect.void),
  }
}

describe("agent.subagent-run", () => {
  it.instance("inherits nested spawn_agent ask, deny, and allow rules", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      if (!build) return yield* Effect.die("build agent is required for this test")
      const tools = childToolOverrides({ agent: build, primaryTools: ["shell"] })
      expect(Permission.evaluate("spawn_agent", "*", build.permission).action).toBe("allow")
      expect(Permission.evaluate("send_message", "*", build.permission).action).toBe("allow")
      expect("spawn_agent" in tools).toBe(false)
      expect("followup_task" in tools).toBe(false)
      expect("inbox" in tools).toBe(false)
      expect(Object.entries(tools)).toContainEqual(["shell", false])
      const defaultChild = deriveSubagentSessionPermission({
        parentSessionPermission: [],
        parentAgent: build,
        subagent: build,
      })
      expect(Permission.evaluate("spawn_agent", "*", Permission.merge(build.permission, defaultChild)).action).toBe(
        "allow",
      )
      const inherited = deriveSubagentSessionPermission({
        parentSessionPermission: [{ permission: "spawn_agent", pattern: "*", action: "deny" }],
        parentAgent: build,
        subagent: build,
      })
      expect(Permission.evaluate("spawn_agent", "*", Permission.merge(build.permission, inherited)).action).toBe("deny")

      const asked = deriveSubagentSessionPermission({
        parentSessionPermission: [{ permission: "spawn_agent", pattern: "*", action: "ask" }],
        parentAgent: build,
        subagent: build,
      })
      expect(Permission.evaluate("spawn_agent", "*", Permission.merge(build.permission, asked)).action).toBe("ask")

      const wildcardAsked = deriveSubagentSessionPermission({
        parentSessionPermission: [{ permission: "*", pattern: "*", action: "ask" }],
        parentAgent: build,
        subagent: build,
      })
      expect(Permission.evaluate("spawn_agent", "*", Permission.merge(build.permission, wildcardAsked)).action).toBe(
        "ask",
      )

      const patternedAsked = deriveSubagentSessionPermission({
        parentSessionPermission: [{ permission: "spawn_*", pattern: "*", action: "ask" }],
        parentAgent: build,
        subagent: build,
      })
      expect(Permission.evaluate("spawn_agent", "*", Permission.merge(build.permission, patternedAsked)).action).toBe(
        "ask",
      )

      const allowed = deriveSubagentSessionPermission({
        parentSessionPermission: [{ permission: "spawn_agent", pattern: "*", action: "allow" }],
        parentAgent: build,
        subagent: build,
      })
      expect(Permission.evaluate("spawn_agent", "*", Permission.merge(build.permission, allowed)).action).toBe("allow")
    }),
  )

  it.instance("forks the current context, runs in the background, and sends its final answer to its parent", () =>
    Effect.gen(function* () {
      const background = yield* BackgroundJob.Service
      const collaboration = yield* Collaboration.Service
      const run = yield* SubagentRun.Service
      const sessions = yield* Session.Service
      const release = yield* Deferred.make<void>()
      const seeded = yield* seed()
      const prompts: SessionPrompt.PromptInput[] = []
      const metadata: Record<string, unknown>[] = []
      const ops = {
        cancel: () => Effect.void,
        resolvePromptParts: (text: string) => Effect.succeed([{ type: "text" as const, text }]),
        prompt: (input: SessionPrompt.PromptInput) =>
          Effect.gen(function* () {
            prompts.push(input)
            yield* Deferred.await(release)
            return reply(input, "cache key is missing the provider")
          }),
        loop: (input: SessionPrompt.LoopInput) =>
          Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "unused")),
      }
      const result = yield* run.run({
        context: context({
          sessionID: seeded.parent.id,
          messageID: seeded.assistant.id,
          ops,
          metadata: (input) =>
            Effect.sync(() => {
              if (input.metadata) metadata.push(input.metadata)
            }),
        }),
        taskName: "inspect_cache",
        message: "Find the cache bug.",
      })

      expect(result.path).toBe("/root/inspect_cache")
      expect((yield* sessions.get(result.sessionID)).parentID).toBe(seeded.parent.id)
      expect((yield* sessions.messages({ sessionID: result.sessionID })).map((message) => message.info.role)).toEqual([
        "user",
        "assistant",
        "user",
      ])
      expect((yield* background.get(result.sessionID))?.metadata).toMatchObject({
        parentSessionId: seeded.parent.id,
        sessionId: result.sessionID,
      })
      expect(metadata[0]).toMatchObject({ parentSessionId: seeded.parent.id, sessionId: result.sessionID })
      yield* pollWithTimeout(
        collaboration
          .member(result.sessionID)
          .pipe(Effect.map((member) => (member?.status === "running" ? member : undefined))),
        "child did not start",
      )
      const prompt = yield* pollWithTimeout(
        Effect.sync(() => prompts[0]),
        "child did not send its prompt",
      )
      expect(prompt.model).toEqual(ref)
      expect(prompt.variant).toBe("ultra")
      expect(prompt.serviceTier).toBe("priority")
      expect(prompt.upstream).toBe("origin")

      yield* Deferred.succeed(release, undefined)
      yield* pollWithTimeout(
        collaboration.inbox({ sessionID: seeded.parent.id }).pipe(Effect.map((messages) => messages[0])),
        "child final answer was not queued",
      ).pipe(
        Effect.tap((message) =>
          Effect.sync(() => {
            expect(message.kind).toBe("FINAL_ANSWER")
            expect(message.content).toContain("cache key is missing the provider")
          }),
        ),
      )
    }),
  )

  it.instance("queues mail for a fresh fork_turns none child before it has a user turn", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const run = yield* SubagentRun.Service
      const sessions = yield* Session.Service
      const seeded = yield* seed()
      const release = yield* Deferred.make<void>()
      const result = yield* run.run({
        context: context({
          sessionID: seeded.parent.id,
          messageID: seeded.assistant.id,
          ops: {
            cancel: () => Effect.void,
            resolvePromptParts: (text) => Effect.succeed([{ type: "text" as const, text }]),
            prompt: (input) => Deferred.await(release).pipe(Effect.as(reply(input, "done"))),
            loop: (input) => Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "unused")),
          },
        }),
        taskName: "fresh",
        message: "Work from this request only.",
        forkTurns: "none",
      })

      expect(
        yield* collaboration.send({
          sessionID: seeded.parent.id,
          target: result.path,
          kind: "MESSAGE",
          content: "wait for the parent before starting",
          triggerTurn: false,
        }),
      ).toMatchObject({
        recipientSessionID: result.sessionID,
        content: "wait for the parent before starting",
      })
      expect(yield* sessions.messages({ sessionID: result.sessionID })).toMatchObject([
        {
          info: { role: "user", agent: "build" },
          parts: [expect.objectContaining({ ignored: true, synthetic: true })],
        },
      ])
      yield* Deferred.succeed(release, undefined)
    }),
  )

  it.instance("retains successful child output when final-answer delivery fails", () =>
    Effect.gen(function* () {
      const background = yield* BackgroundJob.Service
      const collaboration = yield* Collaboration.Service
      const run = yield* SubagentRun.Service
      const sessions = yield* Session.Service
      const seeded = yield* seed()
      const release = yield* Deferred.make<void>()
      const result = yield* run.run({
        context: context({
          sessionID: seeded.parent.id,
          messageID: seeded.assistant.id,
          ops: {
            cancel: () => Effect.void,
            resolvePromptParts: (text) => Effect.succeed([{ type: "text" as const, text }]),
            prompt: (input) => Deferred.await(release).pipe(Effect.as(reply(input, "valid child output"))),
            loop: (input) => Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "unused")),
          },
        }),
        taskName: "delivery_failure",
        message: "Complete normally.",
      })
      yield* pollWithTimeout(
        collaboration
          .member(result.sessionID)
          .pipe(Effect.map((member) => (member?.status === "running" ? member : undefined))),
        "child did not start",
      )
      yield* Effect.forEach(
        (yield* sessions.messages({ sessionID: seeded.parent.id })).filter((message) => message.info.role === "user"),
        (message) => sessions.removeMessage({ sessionID: seeded.parent.id, messageID: message.info.id }),
        { discard: true },
      )
      yield* Deferred.succeed(release, undefined)

      const job = yield* pollWithTimeout(
        background.get(result.sessionID).pipe(Effect.map((item) => (item?.status === "error" ? item : undefined))),
        "child delivery failure was not recorded",
      )
      expect(job.output).toBe("valid child output")
      expect(job.error).toContain("final answer delivery failed")
      expect(yield* collaboration.member(result.sessionID)).toMatchObject({
        status: "errored",
        result: "valid child output",
        error: expect.stringContaining("final answer delivery failed"),
      })
      expect(yield* collaboration.inbox({ sessionID: seeded.parent.id })).toEqual([])
    }),
  )

  it.instance("limits forked context to positive fork_turns", () =>
    Effect.gen(function* () {
      const run = yield* SubagentRun.Service
      const sessions = yield* Session.Service
      const seeded = yield* seed()
      const result = yield* run.run({
        context: context({
          sessionID: seeded.parent.id,
          messageID: seeded.assistant.id,
          ops: {
            cancel: () => Effect.void,
            resolvePromptParts: (text) => Effect.succeed([{ type: "text" as const, text }]),
            prompt: (input) => Effect.succeed(reply(input, "done")),
            loop: (input) => Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "unused")),
          },
        }),
        taskName: "recent",
        message: "Use only the latest turn.",
        forkTurns: 1,
      })

      expect((yield* sessions.messages({ sessionID: result.sessionID })).map((message) => message.info.role)).toEqual([
        "user",
      ])
    }),
  )

  it.instance("keeps all, none, and last-turn forks available to nested children", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const run = yield* SubagentRun.Service
      const sessions = yield* Session.Service
      const seeded = yield* seed()
      const ops = {
        cancel: () => Effect.void,
        resolvePromptParts: (text: string) => Effect.succeed([{ type: "text" as const, text }]),
        prompt: (input: SessionPrompt.PromptInput) => Effect.succeed(reply(input, "done")),
        loop: (input: SessionPrompt.LoopInput) =>
          Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "unused")),
      }
      const parent = yield* run.run({
        context: context({ sessionID: seeded.parent.id, messageID: seeded.assistant.id, ops }),
        taskName: "parent",
        message: "Delegate this work.",
      })
      const parentUser = (yield* sessions.messages({ sessionID: parent.sessionID })).findLast(
        (message) => message.info.role === "user",
      )
      if (!parentUser || parentUser.info.role !== "user") return yield* Effect.die("nested parent needs a user turn")
      const parentAssistant = yield* sessions.updateMessage(
        reply(
          { sessionID: parent.sessionID, messageID: parentUser.info.id, model: ref, agent: "build", parts: [] },
          "delegate",
        ).info,
      )
      const asked: string[] = []
      const nestedContext = context({
        sessionID: parent.sessionID,
        messageID: parentAssistant.id,
        ops,
        ask: (request) =>
          Effect.sync(() => {
            asked.push(request.permission)
          }),
      })
      const all = yield* run.run({
        context: nestedContext,
        taskName: "full_context",
        message: "Use the complete context.",
        forkTurns: "all",
      })
      const none = yield* run.run({
        context: nestedContext,
        taskName: "fresh_context",
        message: "Use only this request.",
        forkTurns: "none",
      })
      const recent = yield* run.run({
        context: nestedContext,
        taskName: "recent_context",
        message: "Use the latest turn.",
        forkTurns: 1,
      })

      expect((yield* sessions.get(all.sessionID)).parentID).toBe(parent.sessionID)
      expect((yield* sessions.get(none.sessionID)).parentID).toBe(parent.sessionID)
      expect((yield* sessions.get(recent.sessionID)).parentID).toBe(parent.sessionID)
      expect(
        (yield* sessions.messages({ sessionID: all.sessionID })).filter((message) => message.info.role === "user"),
      ).toHaveLength(2)
      expect(yield* sessions.messages({ sessionID: none.sessionID })).toEqual([])
      expect((yield* sessions.messages({ sessionID: recent.sessionID })).map((message) => message.info.role)).toEqual([
        "user",
      ])
      expect((yield* collaboration.member(all.sessionID))?.path).toBe("/root/parent/full_context")
      expect(asked).toEqual(["spawn_agent", "spawn_agent", "spawn_agent"])
    }),
  )

  it.instance("honors an explicit spawn_agent denial before creating a nested child", () =>
    Effect.gen(function* () {
      const run = yield* SubagentRun.Service
      const sessions = yield* Session.Service
      const seeded = yield* seed()
      const ops = {
        cancel: () => Effect.void,
        resolvePromptParts: (text: string) => Effect.succeed([{ type: "text" as const, text }]),
        prompt: (input: SessionPrompt.PromptInput) => Effect.succeed(reply(input, "done")),
        loop: (input: SessionPrompt.LoopInput) =>
          Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "unused")),
      }
      const parent = yield* run.run({
        context: context({ sessionID: seeded.parent.id, messageID: seeded.assistant.id, ops }),
        taskName: "parent",
        message: "Delegate this work.",
      })
      const parentUser = (yield* sessions.messages({ sessionID: parent.sessionID })).findLast(
        (message) => message.info.role === "user",
      )
      if (!parentUser || parentUser.info.role !== "user") return yield* Effect.die("nested parent needs a user turn")
      const parentAssistant = yield* sessions.updateMessage(
        reply(
          { sessionID: parent.sessionID, messageID: parentUser.info.id, model: ref, agent: "build", parts: [] },
          "delegate",
        ).info,
      )
      const denied = yield* run
        .run({
          context: context({
            sessionID: parent.sessionID,
            messageID: parentAssistant.id,
            ops,
            ask: (request) =>
              request.permission === "spawn_agent"
                ? Effect.die(new Error("spawn_agent explicitly denied"))
                : Effect.void,
          }),
          taskName: "denied_child",
          message: "This must not start.",
        })
        .pipe(Effect.exit)

      expect(denied._tag).toBe("Failure")
      expect(yield* sessions.children(parent.sessionID)).toEqual([])
    }),
  )

  it.instance("resumes an idle child with its saved model settings and reports to the direct parent", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const run = yield* SubagentRun.Service
      const seeded = yield* seed()
      const prompts: SessionPrompt.PromptInput[] = []
      const ops = {
        cancel: () => Effect.void,
        resolvePromptParts: (text: string) => Effect.succeed([{ type: "text" as const, text }]),
        prompt: (input: SessionPrompt.PromptInput) =>
          Effect.sync(() => {
            prompts.push(input)
            return reply(input, input.parts[0]?.type === "text" ? input.parts[0].text : "done")
          }),
        loop: (input: SessionPrompt.LoopInput) =>
          Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "unused")),
      }
      const initial = yield* run.run({
        context: context({ sessionID: seeded.parent.id, messageID: seeded.assistant.id, ops }),
        taskName: "inspect",
        message: "Inspect the cache.",
      })
      yield* pollWithTimeout(
        collaboration
          .member(initial.sessionID)
          .pipe(Effect.map((member) => (member?.status === "completed" ? member : undefined))),
        "child did not finish its initial turn",
      )

      const resumed = yield* run.followup({
        context: context({ sessionID: seeded.parent.id, messageID: seeded.assistant.id, ops }),
        target: initial.path,
        message: "Check the invalidation path too.",
      })
      expect(resumed).toEqual(initial)
      yield* pollWithTimeout(
        collaboration
          .member(initial.sessionID)
          .pipe(Effect.map((member) => (member?.status === "completed" ? member : undefined))),
        "child did not finish its follow-up turn",
      )
      expect(prompts.at(-1)).toMatchObject({
        model: ref,
        variant: "ultra",
        serviceTier: "priority",
        upstream: "origin",
      })
      const finalAnswers = (yield* collaboration.inbox({ sessionID: seeded.parent.id })).filter(
        (message) => message.kind === "FINAL_ANSWER",
      )
      expect(finalAnswers).toHaveLength(2)
      expect(finalAnswers.at(-1)?.content).toContain("Check the invalidation path too.")
    }),
  )

  it.instance("claims only one concurrent follow-up before starting it", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const run = yield* SubagentRun.Service
      const seeded = yield* seed()
      const releaseFollowup = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      const releaseClaim = yield* Deferred.make<void>()
      let asked = 0
      let prompts = 0
      const ops = {
        cancel: () => Effect.void,
        resolvePromptParts: (text: string) => Effect.succeed([{ type: "text" as const, text }]),
        prompt: (input: SessionPrompt.PromptInput) => {
          prompts++
          if (prompts === 1) return Effect.succeed(reply(input, "initial result"))
          return Deferred.await(releaseFollowup).pipe(Effect.as(reply(input, "follow-up result")))
        },
        loop: (input: SessionPrompt.LoopInput) =>
          Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "unused")),
      }
      const initial = yield* run.run({
        context: context({ sessionID: seeded.parent.id, messageID: seeded.assistant.id, ops }),
        taskName: "inspect",
        message: "Inspect the cache.",
      })
      yield* pollWithTimeout(
        collaboration
          .member(initial.sessionID)
          .pipe(Effect.map((member) => (member?.status === "completed" ? member : undefined))),
        "child did not finish its initial turn",
      )

      const race = yield* Effect.all(
        ["First follow-up.", "Second follow-up."].map((message) =>
          Effect.exit(
            run.followup({
              context: context({
                sessionID: seeded.parent.id,
                messageID: seeded.assistant.id,
                ops,
                ask: () =>
                  Effect.gen(function* () {
                    asked++
                    if (asked === 2) yield* Deferred.succeed(entered, undefined)
                    yield* Deferred.await(releaseClaim)
                  }),
              }),
              target: initial.path,
              message,
            }),
          ),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Deferred.succeed(releaseClaim, undefined)
      const results = yield* Fiber.join(race)
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1)
      expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1)
      expect(yield* collaboration.member(initial.sessionID)).toMatchObject({ status: "running" })

      yield* Deferred.succeed(releaseFollowup, undefined)
      yield* pollWithTimeout(
        collaboration
          .member(initial.sessionID)
          .pipe(Effect.map((member) => (member?.status === "completed" ? member : undefined))),
        "claimed follow-up did not finish",
      )
      expect(prompts).toBe(2)
    }),
  )

  it.instance("restores the prior status when follow-up startup fails", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const run = yield* SubagentRun.Service
      const seeded = yield* seed()
      const ops = {
        cancel: () => Effect.void,
        resolvePromptParts: (text: string) => Effect.succeed([{ type: "text" as const, text }]),
        prompt: (input: SessionPrompt.PromptInput) => Effect.succeed(reply(input, "done")),
        loop: (input: SessionPrompt.LoopInput) =>
          Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "unused")),
      }
      const initial = yield* run.run({
        context: context({ sessionID: seeded.parent.id, messageID: seeded.assistant.id, ops }),
        taskName: "inspect",
        message: "Inspect the cache.",
      })
      yield* pollWithTimeout(
        collaboration
          .member(initial.sessionID)
          .pipe(Effect.map((member) => (member?.status === "completed" ? member : undefined))),
        "child did not finish its initial turn",
      )

      const failure = yield* run
        .followup({
          context: context({
            sessionID: seeded.parent.id,
            messageID: seeded.assistant.id,
            ops,
            metadata: () => Effect.die("startup failed"),
          }),
          target: initial.path,
          message: "Try again.",
        })
        .pipe(Effect.exit)
      expect(failure._tag).toBe("Failure")
      expect(yield* collaboration.member(initial.sessionID)).toMatchObject({
        status: "completed",
        lastTask: "Inspect the cache.",
      })
    }),
  )

  it.instance("does not deliver a final answer when the child turn is aborted", () =>
    Effect.gen(function* () {
      const background = yield* BackgroundJob.Service
      const collaboration = yield* Collaboration.Service
      const run = yield* SubagentRun.Service
      const seeded = yield* seed()
      const result = yield* run.run({
        context: context({
          sessionID: seeded.parent.id,
          messageID: seeded.assistant.id,
          ops: {
            cancel: () => Effect.void,
            resolvePromptParts: (text) => Effect.succeed([{ type: "text" as const, text }]),
            prompt: (input) =>
              Effect.succeed(reply(input, "partial result")).pipe(
                Effect.map((result) => ({
                  ...result,
                  info: {
                    ...result.info,
                    error: new MessageV2.AbortedError({ message: "Aborted" }).toObject(),
                  },
                })),
              ),
            loop: (input) => Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "unused")),
          },
        }),
        taskName: "cancelled",
        message: "Stop this task.",
      })

      yield* pollWithTimeout(
        background.get(result.sessionID).pipe(Effect.map((job) => (job?.status === "cancelled" ? job : undefined))),
        "child did not stop",
      )
      expect((yield* collaboration.member(result.sessionID))?.status).toBe("interrupted")
      expect(yield* collaboration.inbox({ sessionID: seeded.parent.id })).toEqual([])
    }),
  )

  it.instance("enforces the shared root-plus-three child cap across nested descendants", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const run = yield* SubagentRun.Service
      const sessions = yield* Session.Service
      const seeded = yield* seed()
      const release = yield* Deferred.make<void>()
      const ops = {
        cancel: () => Effect.void,
        resolvePromptParts: (text: string) => Effect.succeed([{ type: "text" as const, text }]),
        prompt: (input: SessionPrompt.PromptInput) => Deferred.await(release).pipe(Effect.as(reply(input, "done"))),
        loop: (input: SessionPrompt.LoopInput) =>
          Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "unused")),
      }
      const children = yield* Effect.forEach(["parent", "one", "two"], (taskName) =>
        run.run({
          context: context({ sessionID: seeded.parent.id, messageID: seeded.assistant.id, ops }),
          taskName,
          message: `Task ${taskName}`,
        }),
      )

      yield* pollWithTimeout(
        Effect.forEach(children, (child) => collaboration.member(child.sessionID)).pipe(
          Effect.map((members) =>
            members.filter((member) => member?.status === "running").length === 3 ? members : undefined,
          ),
        ),
        "three children did not acquire the collaboration permits",
      )
      const parentAssistant = yield* sessions.updateMessage(
        reply({ sessionID: children[0]!.sessionID, model: ref, agent: "build", parts: [] }, "working").info,
      )
      const nested = yield* run.run({
        context: context({ sessionID: children[0]!.sessionID, messageID: parentAssistant.id, ops }),
        taskName: "nested",
        message: "Nested task",
      })
      expect((yield* collaboration.member(nested.sessionID))?.status).toBe("pending")
      yield* Deferred.succeed(release, undefined)
    }),
  )

  it.instance("rejects invalid task names, invalid fork counts, and unregistered nested parents", () =>
    Effect.gen(function* () {
      const run = yield* SubagentRun.Service
      const sessions = yield* Session.Service
      const seeded = yield* seed()
      const base = context({
        sessionID: seeded.parent.id,
        messageID: seeded.assistant.id,
        ops: {
          cancel: () => Effect.void,
          resolvePromptParts: (text) => Effect.succeed([{ type: "text" as const, text }]),
          prompt: (input) => Effect.succeed(reply(input, "done")),
          loop: (input) => Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "unused")),
        },
      })
      expect(
        (yield* run.run({ context: base, taskName: "not valid", message: "x" }).pipe(Effect.flip)).message,
      ).toContain("task_name")
      expect(
        (yield* run.run({ context: base, taskName: "valid", message: "x", forkTurns: 0 }).pipe(Effect.flip)).message,
      ).toContain("positive integer")
      expect(Schema.decodeUnknownExit(SpawnAgentParameters)({ task_name: "Not_Valid", message: "x" })._tag).toBe(
        "Failure",
      )
      expect(
        Schema.decodeUnknownExit(SpawnAgentParameters)({ task_name: "valid", message: "x", fork_turns: 1 })._tag,
      ).toBe("Success")
      expect(
        Schema.decodeUnknownExit(SpawnAgentParameters)({ task_name: "valid", message: "x", fork_turns: 0 })._tag,
      ).toBe("Failure")
      expect(
        Schema.decodeUnknownExit(SpawnAgentParameters)({ task_name: "valid", message: "x", fork_turns: 1.5 })._tag,
      ).toBe("Failure")
      expect(
        Schema.decodeUnknownExit(SpawnAgentParameters)({
          task_name: "valid",
          message: "x".repeat(MAX_MAILBOX_PAYLOAD_CHARS),
        })._tag,
      ).toBe("Success")
      expect(
        Schema.decodeUnknownExit(SpawnAgentParameters)({
          task_name: "valid",
          message: "x".repeat(MAX_MAILBOX_PAYLOAD_CHARS + 1),
        })._tag,
      ).toBe("Failure")

      const unregistered = yield* sessions.create({ parentID: seeded.parent.id, title: "unregistered" })
      const nested = context({
        sessionID: unregistered.id,
        messageID: seeded.assistant.id,
        ops: {
          cancel: () => Effect.void,
          resolvePromptParts: (text) => Effect.succeed([{ type: "text" as const, text }]),
          prompt: (input) => Effect.succeed(reply(input, "done")),
          loop: (input) => Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "unused")),
        },
      })
      expect(
        (yield* run.run({ context: nested, taskName: "child", message: "x" }).pipe(Effect.flip)).message,
      ).toContain("not registered")
    }),
  )
})
