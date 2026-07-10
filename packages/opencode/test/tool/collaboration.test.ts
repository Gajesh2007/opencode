import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "@/agent/agent"
import type { TaskPromptOps } from "@/agent/child-session"
import { Collaboration } from "@/agent/collaboration"
import { BackgroundJob } from "@/background/job"
import { Team } from "@/agent/team"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { InterruptAgentTool, ListAgentsTool, WaitAgentTool } from "@/tool/collaboration"
import { InboxTool } from "@/tool/inbox"
import { SendMessageTool } from "@/tool/send_message"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    Collaboration.defaultLayer,
    Session.defaultLayer,
    Team.defaultLayer,
    Truncate.defaultLayer,
  ),
)
const session = (value: string) => SessionID.make(`ses_collaboration_tool_${value}`)
const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test") }
const sessionModel = { providerID: model.providerID, id: model.modelID }

function context(sessionID: SessionID, ops?: TaskPromptOps): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    ...(ops ? { extra: { promptOps: ops } } : {}),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("tool.collaboration", () => {
  it.instance("wakes with and drains caller mailbox content exactly once", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const tool = yield* WaitAgentTool
      const def = yield* tool.init()
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root", agent: "build", model: sessionModel })
      const child = yield* sessions.create({
        parentID: root.id,
        title: "[agent] worker",
        agent: "build",
        model: sessionModel,
      })
      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: root.id,
        agent: "build",
        model,
        time: { created: Date.now() },
      })
      yield* collaboration.registerRoot(root.id)
      yield* collaboration.registerChild({ parentSessionID: root.id, sessionID: child.id, taskName: "worker" })

      const waiting = yield* def.execute({ timeout: 1 }, context(root.id)).pipe(Effect.forkChild)
      yield* collaboration.send({
        sessionID: child.id,
        target: "..",
        kind: "MESSAGE",
        content: "private coordination detail",
        triggerTurn: false,
      })
      const result = yield* Fiber.join(waiting)
      expect(result.output).toContain("status: activity")
      expect(result.output).toContain("private coordination detail")
      expect(result.output.match(/private coordination detail/g)).toHaveLength(1)
      expect(result.metadata).toMatchObject({ status: "activity", count: 1 })
      expect(yield* collaboration.inbox({ sessionID: root.id })).toEqual([])
      expect((yield* sessions.messages({ sessionID: root.id })).flatMap((message) => message.parts)).not.toContainEqual(
        expect.objectContaining({ type: "text", text: expect.stringContaining("private coordination detail") }),
      )
      expect((yield* def.execute({ timeout: 0 }, context(root.id))).output).toBe("status: timeout")
    }),
  )

  it.instance("reads collaboration mail for registered callers", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const tool = yield* InboxTool
      const def = yield* tool.init()
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root", agent: "build", model: sessionModel })
      const child = yield* sessions.create({
        parentID: root.id,
        title: "[agent] worker",
        agent: "build",
        model: sessionModel,
      })
      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: root.id,
        agent: "build",
        model,
        time: { created: Date.now() },
      })
      yield* collaboration.registerRoot(root.id)
      yield* collaboration.registerChild({ parentSessionID: root.id, sessionID: child.id, taskName: "worker" })
      yield* collaboration.send({
        sessionID: child.id,
        target: "..",
        kind: "MESSAGE",
        content: "mail for the root",
        triggerTurn: false,
      })

      const result = yield* def.execute({}, context(root.id))
      expect(result.metadata).toMatchObject({ task_path: "/root", count: 1 })
      expect(result.output).toContain("mail for the root")
      expect(yield* collaboration.inbox({ sessionID: root.id })).toEqual([])
      expect((yield* sessions.messages({ sessionID: root.id })).flatMap((message) => message.parts)).not.toContainEqual(
        expect.objectContaining({ type: "text", text: expect.stringContaining("mail for the root") }),
      )
    }),
  )

  it.instance("falls back to the legacy Team inbox for unregistered callers", () =>
    Effect.gen(function* () {
      const team = yield* Team.Service
      const tool = yield* InboxTool
      const def = yield* tool.init()
      const recipient = session("legacy_inbox")
      yield* team.register({ team: "legacy", name: "reader", sessionID: recipient })
      yield* team.send({ team: "legacy", from: "writer", to: "reader", message: "legacy mail" })

      const result = yield* def.execute({}, context(recipient))
      expect(result.metadata).toMatchObject({ team: "legacy", count: 1 })
      expect(result.output).toContain("legacy mail")
    }),
  )

  it.instance("drains collaboration and Team mail for members of both", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const team = yield* Team.Service
      const tool = yield* InboxTool
      const def = yield* tool.init()
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root", agent: "build", model: sessionModel })
      const child = yield* sessions.create({
        parentID: root.id,
        title: "[agent] worker",
        agent: "build",
        model: sessionModel,
      })
      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: root.id,
        agent: "build",
        model,
        time: { created: Date.now() },
      })
      yield* collaboration.registerRoot(root.id)
      yield* collaboration.registerChild({ parentSessionID: root.id, sessionID: child.id, taskName: "worker" })
      yield* team.register({ team: "review", name: "lead", sessionID: root.id })
      yield* collaboration.send({
        sessionID: child.id,
        target: "..",
        kind: "MESSAGE",
        content: "collaboration mail",
        triggerTurn: false,
      })
      yield* team.send({ team: "review", from: "writer", to: "lead", message: "team mail" })

      const result = yield* def.execute({}, context(root.id))
      expect(result.metadata).toMatchObject({ task_path: "/root", team: "review", count: 2 })
      expect(result.output).toContain("collaboration mail")
      expect(result.output).toContain("team mail")
      expect(yield* collaboration.inbox({ sessionID: root.id })).toEqual([])
      expect(yield* team.inbox({ team: "review", recipient: "lead" })).toEqual([])
    }),
  )

  it.instance("keeps Team mail queued when collaboration acknowledgement cannot be delivered", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const team = yield* Team.Service
      const tool = yield* InboxTool
      const def = yield* tool.init()
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root", agent: "build", model: sessionModel })
      const child = yield* sessions.create({
        parentID: root.id,
        title: "[agent] worker",
        agent: "build",
        model: sessionModel,
      })
      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: root.id,
        agent: "build",
        model,
        time: { created: Date.now() },
      })
      yield* collaboration.registerRoot(root.id)
      yield* collaboration.registerChild({ parentSessionID: root.id, sessionID: child.id, taskName: "worker" })
      yield* team.register({ team: "review", name: "lead", sessionID: root.id })
      yield* collaboration.send({
        sessionID: child.id,
        target: "..",
        kind: "MESSAGE",
        content: "collaboration mail",
        triggerTurn: false,
      })
      yield* team.send({ team: "review", from: "writer", to: "lead", message: "team mail" })
      const mail = (yield* collaboration.inbox({ sessionID: root.id }))[0]
      if (!mail?.messageID || !mail.partID) throw new Error("expected a durable collaboration mail part")
      yield* sessions.removePart({ sessionID: root.id, messageID: mail.messageID, partID: mail.partID })

      expect((yield* def.execute({}, context(root.id)).pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* team.inbox({ team: "review", recipient: "lead", drain: false })).toMatchObject([
        { message: "team mail" },
      ])
    }),
  )

  it.instance("queues local collaboration messages without starting a target turn", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const tool = yield* SendMessageTool
      const def = yield* tool.init()
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root", agent: "build", model: sessionModel })
      const child = yield* sessions.create({
        parentID: root.id,
        title: "[agent] worker",
        agent: "build",
        model: sessionModel,
      })
      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: child.id,
        agent: "build",
        model,
        time: { created: Date.now() },
      })
      yield* collaboration.registerRoot(root.id)
      yield* collaboration.registerChild({ parentSessionID: root.id, sessionID: child.id, taskName: "worker" })

      const result = yield* def.execute({ target: "worker", message: "Please inspect this." }, context(root.id))
      expect(result.output).toContain("/root/worker")
      expect(yield* collaboration.member(child.id)).toMatchObject({ status: "pending" })
      expect(yield* collaboration.inbox({ sessionID: child.id })).toMatchObject([
        { kind: "MESSAGE", content: "Please inspect this.", triggerTurn: false },
      ])
    }),
  )

  it.instance("reports partial multi-recipient delivery without duplicating successes", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const tool = yield* SendMessageTool
      const def = yield* tool.init()
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root", agent: "build", model: sessionModel })
      const child = yield* sessions.create({
        parentID: root.id,
        title: "[agent] worker",
        agent: "build",
        model: sessionModel,
      })
      yield* collaboration.registerRoot(root.id)
      yield* collaboration.registerChild({ parentSessionID: root.id, sessionID: child.id, taskName: "worker" })

      const result = yield* def.execute(
        { recipients: ["worker", "missing", "worker"], message: "Please inspect this." },
        context(root.id),
      )
      expect(result.output).toContain("/root/worker: queued")
      expect(result.output).toContain("missing: failed")
      expect(result.output).toContain("Retry only the failed targets.")
      expect(yield* collaboration.inbox({ sessionID: child.id })).toHaveLength(1)

      const failure = yield* def
        .execute({ recipients: ["missing"], message: "Please inspect this." }, context(root.id))
        .pipe(Effect.exit)
      expect(Exit.isFailure(failure)).toBe(true)
      if (Exit.isFailure(failure)) expect(Cause.pretty(failure.cause)).toContain("Unable to queue message")
    }),
  )

  it.instance("deduplicates relative and canonical aliases for one recipient", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const tool = yield* SendMessageTool
      const def = yield* tool.init()
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root", agent: "build", model: sessionModel })
      const child = yield* sessions.create({
        parentID: root.id,
        title: "[agent] worker",
        agent: "build",
        model: sessionModel,
      })
      yield* collaboration.registerRoot(root.id)
      yield* collaboration.registerChild({ parentSessionID: root.id, sessionID: child.id, taskName: "worker" })

      const result = yield* def.execute(
        { recipients: ["worker", "/root/worker"], message: "Please inspect this." },
        context(root.id),
      )

      expect(result.title).toBe("to 1 agent")
      expect(result.metadata).toMatchObject({ task_paths: ["/root/worker"] })
      expect(result.output).toBe("/root/worker: queued")
      expect(yield* collaboration.inbox({ sessionID: child.id })).toHaveLength(1)
      const placeholders = (yield* sessions.messages({ sessionID: child.id }))
        .flatMap((message) => message.parts)
        .filter((part): part is MessageV2.TextPart => part.type === "text" && part.synthetic === true)
      expect(placeholders).toHaveLength(1)
    }),
  )

  it.instance("retains named-team delivery when a local path does not resolve", () =>
    Effect.gen(function* () {
      const team = yield* Team.Service
      const tool = yield* SendMessageTool
      const def = yield* tool.init()
      const lead = session("team_lead")
      const worker = session("team_worker")
      yield* team.register({ team: "review", name: "lead", sessionID: lead })
      yield* team.register({ team: "review", name: "worker", sessionID: worker })

      const result = yield* def.execute({ to: "worker", message: "Review the diff." }, context(lead))
      expect(result.output).toContain("queued")
      expect((yield* team.inbox({ team: "review", recipient: "worker" }))[0]?.message).toBe("Review the diff.")
    }),
  )

  it.instance("interrupts a child without queueing a final answer", () =>
    Effect.gen(function* () {
      const background = yield* BackgroundJob.Service
      const collaboration = yield* Collaboration.Service
      const tool = yield* InterruptAgentTool
      const def = yield* tool.init()
      const root = session("interrupt_root")
      const child = session("interrupt_child")
      const cancelled: SessionID[] = []
      const ops: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.push(sessionID)
          }),
        resolvePromptParts: () => Effect.die("unexpected prompt resolution"),
        prompt: () => Effect.die("unexpected prompt"),
        loop: () => Effect.die("unexpected loop"),
      }
      yield* collaboration.registerRoot(root)
      yield* collaboration.registerChild({ parentSessionID: root, sessionID: child, taskName: "worker" })
      yield* collaboration.setStatus({ sessionID: child, status: "running" })
      yield* background.start({ id: child, type: "test", run: Effect.never })

      const result = yield* def.execute({ target: "worker" }, context(root, ops))
      expect(result.output).toContain("status: interrupted")
      expect(cancelled).toEqual([child])
      expect(yield* collaboration.member(child)).toMatchObject({ status: "interrupted" })
      expect(yield* collaboration.inbox({ sessionID: root })).toEqual([])
    }),
  )

  it.instance("lists canonical paths and filters by a relative path prefix", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const tool = yield* ListAgentsTool
      const def = yield* tool.init()
      const root = session("list_root")
      const worker = session("list_worker")
      const nested = session("list_nested")
      const sibling = session("list_sibling")
      yield* collaboration.registerRoot(root)
      yield* collaboration.registerChild({
        parentSessionID: root,
        sessionID: worker,
        taskName: "worker",
        lastTask: "inspect cache",
      })
      yield* collaboration.registerChild({ parentSessionID: worker, sessionID: nested, taskName: "nested" })
      yield* collaboration.registerChild({ parentSessionID: root, sessionID: sibling, taskName: "sibling" })

      const result = yield* def.execute({ path_prefix: "worker" }, context(root))
      expect(result.output).toContain("task_path: /root/worker")
      expect(result.output).toContain("task_path: /root/worker/nested")
      expect(result.output).toContain("last_task: inspect cache")
      expect(result.output).not.toContain("/root/sibling")
    }),
  )
})
