import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import {
  Collaboration,
  formatMailbox,
  MAX_MAILBOX_MESSAGES,
  MAX_MAILBOX_PAYLOAD_CHARS,
  MAX_MAILBOX_PROMPT_CHARS,
  resolvePath,
} from "@/agent/collaboration"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { ModelID, ProviderID } from "@/provider/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Collaboration.defaultLayer))
const session = (value: string) => SessionID.make(`ses_collaboration_${value}`)
const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test") }
const sessionModel = { providerID: model.providerID, id: model.modelID }

describe("agent.collaboration paths", () => {
  test("normalizes relative and canonical paths without escaping the root", () => {
    expect(resolvePath("/root/research", "scan")).toBe("/root/research/scan")
    expect(resolvePath("/root/research", "../editor")).toBe("/root/editor")
    expect(resolvePath("/root/research", "/root/editor")).toBe("/root/editor")
    expect(resolvePath("/root/research", "../../outside")).toBeUndefined()
  })
})

describe("agent.collaboration mailbox formatting", () => {
  test("labels each message and bounds a drained model prompt", () => {
    const formatted = formatMailbox(
      Array.from({ length: MAX_MAILBOX_MESSAGES + 1 }, (_, index) => ({
        id: `mail-${index}`,
        senderSessionID: session("format_sender"),
        recipientSessionID: session("format_recipient"),
        senderPath: "/root/research",
        recipientPath: "/root/editor",
        kind: "MESSAGE" as const,
        content: "x".repeat(100),
        triggerTurn: false,
        time: 0,
      })),
    )

    expect(formatted).toContain("Message Type: MESSAGE")
    expect(formatted).toContain("Task name/recipient: editor (/root/editor)")
    expect(formatted).toContain("Sender: /root/research")
    expect(formatted).toContain("Payload:\n")
    expect(formatted).toContain("1 additional message(s) remain queued for delivery.")
    expect(formatted.length).toBeLessThanOrEqual(MAX_MAILBOX_PROMPT_CHARS)
  })
})

describe("agent.collaboration", () => {
  it.instance("registers a rooted tree and resolves relative targets", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const root = session("root")
      const research = session("research")
      const scan = session("scan")
      const editor = session("editor")
      yield* collaboration.registerRoot(root)
      yield* collaboration.registerChild({ parentSessionID: root, sessionID: research, taskName: "research" })
      yield* collaboration.registerChild({
        parentSessionID: research,
        sessionID: scan,
        taskName: "scan",
        lastTask: "search files",
      })
      yield* collaboration.registerChild({ parentSessionID: root, sessionID: editor, taskName: "editor" })

      expect((yield* collaboration.member(scan))?.path).toBe("/root/research/scan")
      expect((yield* collaboration.resolve({ sessionID: research, target: "scan" }))?.sessionID).toBe(scan)
      expect((yield* collaboration.resolve({ sessionID: research, target: "../editor" }))?.sessionID).toBe(editor)
      expect((yield* collaboration.resolve({ sessionID: scan, target: "/root/editor" }))?.sessionID).toBe(editor)
      expect(
        (yield* collaboration.setStatus({ sessionID: scan, status: "running", lastTask: "inspect matches" })).lastTask,
      ).toBe("inspect matches")
      expect((yield* collaboration.list(research, ".")).map((member) => member.path)).toEqual([
        "/root/research",
        "/root/research/scan",
      ])
    }),
  )

  it.instance("rejects invalid and duplicate sibling task names", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const root = session("invalid_root")
      yield* collaboration.registerRoot(root)
      const invalid = yield* collaboration
        .registerChild({ parentSessionID: root, sessionID: session("invalid"), taskName: "Not valid" })
        .pipe(Effect.flip)
      expect(invalid._tag).toBe("CollaborationInvalidTaskName")

      yield* collaboration.registerChild({ parentSessionID: root, sessionID: session("first"), taskName: "worker_1" })
      const duplicate = yield* collaboration
        .registerChild({ parentSessionID: root, sessionID: session("second"), taskName: "worker_1" })
        .pipe(Effect.flip)
      expect(duplicate._tag).toBe("CollaborationDuplicateSiblingTaskName")
    }),
  )

  it.instance("hydrates persisted nested agents with conservative statuses", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root" })
      const research = yield* sessions.create({ parentID: root.id, title: "[agent] research" })
      const scan = yield* sessions.create({ parentID: research.id, title: "[agent] scan" })
      const editor = yield* sessions.create({ parentID: root.id, title: "[agent] editor" })

      const researchUser = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: research.id,
        role: "user",
        time: { created: 0 },
        agent: "build",
        model,
      })
      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: research.id,
        role: "assistant",
        parentID: researchUser.id,
        time: { created: 0, completed: 1 },
        mode: "build",
        agent: "build",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        ...model,
      })
      const scanUser = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: scan.id,
        role: "user",
        time: { created: 0 },
        agent: "build",
        model,
      })
      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: scan.id,
        role: "assistant",
        parentID: scanUser.id,
        time: { created: 0, completed: 1 },
        mode: "build",
        agent: "build",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        ...model,
        error: new MessageV2.AbortedError({ message: "Aborted" }).toObject(),
      })
      const editorUser = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: editor.id,
        role: "user",
        time: { created: 0 },
        agent: "build",
        model,
      })
      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: editor.id,
        role: "assistant",
        parentID: editorUser.id,
        time: { created: 0 },
        mode: "build",
        agent: "build",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        ...model,
      })

      expect((yield* collaboration.member(scan.id))?.path).toBe("/root/research/scan")
      expect((yield* collaboration.member(research.id))?.status).toBe("completed")
      expect((yield* collaboration.member(scan.id))?.status).toBe("interrupted")
      expect((yield* collaboration.member(editor.id))?.status).toBe("interrupted")
      expect((yield* collaboration.resolve({ sessionID: scan.id, target: "../.." }))?.sessionID).toBe(root.id)
      expect((yield* collaboration.list(root.id)).map((member) => member.path)).toEqual([
        "/root",
        "/root/editor",
        "/root/research",
        "/root/research/scan",
      ])

      yield* collaboration.setStatus({ sessionID: research.id, status: "running" })
      expect((yield* collaboration.ensure(research.id))?.status).toBe("running")
    }),
  )

  it.instance("disambiguates duplicate persisted sibling task names", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root" })
      yield* sessions.create({ parentID: root.id, title: "[agent] worker" })
      yield* sessions.create({ parentID: root.id, title: "[agent] worker" })

      expect((yield* collaboration.list(root.id)).map((member) => member.path)).toEqual([
        "/root",
        "/root/worker",
        "/root/worker~2",
      ])
    }),
  )

  it.instance("shares the child-turn cap across nested descendants and releases permits on interruption", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const root = session("permits_root")
      const parent = session("permits_parent")
      const childA = session("permits_a")
      const childB = session("permits_b")
      const childC = session("permits_c")
      const nested = session("permits_nested")
      yield* collaboration.registerRoot(root)
      yield* collaboration.registerChild({ parentSessionID: root, sessionID: parent, taskName: "parent" })
      yield* collaboration.registerChild({ parentSessionID: root, sessionID: childA, taskName: "child_a" })
      yield* collaboration.registerChild({ parentSessionID: root, sessionID: childB, taskName: "child_b" })
      yield* collaboration.registerChild({ parentSessionID: root, sessionID: childC, taskName: "child_c" })
      yield* collaboration.registerChild({ parentSessionID: parent, sessionID: nested, taskName: "nested" })

      const allEntered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fourthEntered = yield* Deferred.make<void>()
      let entered = 0
      const hold = (sessionID: SessionID) =>
        collaboration.withChildPermit(
          sessionID,
          Effect.gen(function* () {
            entered++
            if (entered === 3) yield* Deferred.succeed(allEntered, undefined)
            yield* Deferred.await(release)
          }),
        )

      const holders = yield* Effect.forEach([parent, childA, childB], (sessionID) =>
        hold(sessionID).pipe(Effect.forkChild),
      )
      yield* Deferred.await(allEntered)
      const fourth = yield* collaboration
        .withChildPermit(nested, Deferred.succeed(fourthEntered, undefined))
        .pipe(Effect.forkChild)
      yield* Effect.sleep("10 millis")
      expect(yield* Deferred.isDone(fourthEntered)).toBe(false)

      yield* Deferred.succeed(release, undefined)
      yield* Effect.forEach(holders, Fiber.join)
      yield* Deferred.await(fourthEntered)
      yield* Fiber.join(fourth)

      const held = yield* collaboration.withChildPermit(childC, Effect.never).pipe(Effect.forkChild)
      yield* Effect.sleep("10 millis")
      yield* Fiber.interrupt(held)
      expect(yield* collaboration.withChildPermit(nested, Effect.succeed("released"))).toBe("released")
    }),
  )

  it.instance("wakes mailbox waiters without consuming mail and drains only on request", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
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

      const waiting = yield* collaboration.wait({ sessionID: root.id, timeout: 1_000 }).pipe(Effect.forkChild)
      yield* collaboration.send({
        sessionID: child.id,
        target: "..",
        kind: "MESSAGE",
        content: "found it",
        triggerTurn: true,
      })
      expect(yield* collaboration.hasMail(root.id)).toBe(true)
      expect(yield* Fiber.join(waiting)).toBe("activity")
      expect(
        (yield* collaboration.inbox({ sessionID: root.id, drain: false })).map((message) => message.content),
      ).toEqual(["found it"])
      expect((yield* collaboration.inbox({ sessionID: root.id, drain: true })).length).toBe(1)
      expect((yield* collaboration.inbox({ sessionID: root.id, drain: true })).length).toBe(0)
      expect(yield* collaboration.hasMail(root.id)).toBe(false)
      expect(yield* collaboration.wait({ sessionID: root.id, timeout: 1 })).toBe("timeout")
    }),
  )

  it.instance("persists bounded mail before queueing the wake record", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root" })
      const child = yield* sessions.create({ parentID: root.id, title: "[agent] worker" })
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
        content: "mail persisted immediately",
        triggerTurn: false,
      })
      yield* collaboration.complete({ sessionID: child.id, result: "x".repeat(MAX_MAILBOX_PAYLOAD_CHARS + 1) })

      const mail = (yield* sessions.messages({ sessionID: root.id }))
        .flatMap((message) => message.parts)
        .filter((part): part is MessageV2.TextPart => part.type === "text" && part.synthetic === true)
        .map((part) => part.text)
      expect(mail).toHaveLength(2)
      expect(mail[0]).toContain(`Sender: /root/worker (session: ${child.id})`)
      expect(mail[0]).toContain(`Recipient session: ${root.id}`)
      expect(mail[0]).toContain("mail persisted immediately")
      expect(mail[1]).toContain(`full sender context in session ${child.id}`)
      const history = yield* sessions.messages({ sessionID: root.id })
      expect(history).toHaveLength(3)
      expect(history.map((message) => message.info.role)).toEqual(["user", "user", "user"])
      expect(history.slice(1).every((message) => message.parts.length === 1)).toBe(true)
      expect(history.slice(1).map((message) => message.parts[0]?.messageID)).toEqual(
        history.slice(1).map((message) => message.info.id),
      )
      expect(mail).toEqual(
        expect.arrayContaining([
          expect.stringContaining("mail persisted immediately"),
          expect.stringContaining("<FINAL_ANSWER>"),
        ]),
      )
      expect(yield* collaboration.hasMail(root.id)).toBe(true)
    }),
  )

  it.instance("drains mailbox records in bounded batches without dropping the remainder", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
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
      yield* Effect.forEach(
        Array.from({ length: MAX_MAILBOX_MESSAGES + 1 }, (_, index) => index),
        (index) =>
          collaboration.send({
            sessionID: child.id,
            target: "..",
            kind: "MESSAGE",
            content: `message ${index}`,
            triggerTurn: false,
          }),
        { discard: true },
      )

      const first = yield* collaboration.inbox({ sessionID: root.id, drain: true })
      const second = yield* collaboration.inbox({ sessionID: root.id, drain: true })
      expect(first).toHaveLength(MAX_MAILBOX_MESSAGES)
      expect(second.map((message) => message.content)).toEqual([`message ${MAX_MAILBOX_MESSAGES}`])
      expect(yield* collaboration.hasMail(root.id)).toBe(false)
    }),
  )

  it.instance("delivers one durable mailbox batch and leaves the remainder ignored", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
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
      yield* Effect.forEach(
        Array.from({ length: MAX_MAILBOX_MESSAGES + 1 }, (_, index) => index),
        (index) =>
          collaboration.send({
            sessionID: child.id,
            target: "..",
            kind: "MESSAGE",
            content: `message ${index}`,
            triggerTurn: false,
          }),
        { discard: true },
      )

      expect(yield* collaboration.deliver({ sessionID: root.id })).toHaveLength(MAX_MAILBOX_MESSAGES)
      const pending = (yield* sessions.messages({ sessionID: root.id }))
        .flatMap((message) => message.parts)
        .filter((part): part is MessageV2.TextPart => part.type === "text" && part.synthetic === true)
      expect(pending.filter((part) => part.ignored !== true)).toHaveLength(MAX_MAILBOX_MESSAGES)
      expect(pending.filter((part) => part.ignored === true)).toHaveLength(1)
      expect(yield* collaboration.hasMail(root.id)).toBe(true)
    }),
  )

  it.instance("hydrates each ignored pending placeholder once after in-memory state is lost", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
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
      const queued = yield* collaboration.send({
        sessionID: child.id,
        target: "..",
        kind: "MESSAGE",
        content: "survives restart",
        triggerTurn: false,
      })
      if (!queued) throw new Error("mail was not queued")

      yield* collaboration.remove(root.id)
      expect((yield* collaboration.member(root.id))?.path).toBe("/root")
      const first = yield* collaboration.inbox({ sessionID: root.id })
      const second = yield* collaboration.inbox({ sessionID: root.id })
      expect(first).toMatchObject([{ id: queued.id, content: "survives restart" }])
      expect(second).toHaveLength(1)
    }),
  )

  it.instance("claims each queued mailbox record for only one concurrent consumer", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
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
      yield* Effect.forEach(
        ["first", "second"],
        (content) =>
          collaboration.send({
            sessionID: child.id,
            target: "..",
            kind: "MESSAGE",
            content,
            triggerTurn: false,
          }),
        { discard: true },
      )

      const claims = yield* Effect.all(
        [collaboration.claimInbox({ sessionID: root.id }), collaboration.claimInbox({ sessionID: root.id })],
        { concurrency: "unbounded" },
      )
      expect(claims.flat()).toHaveLength(2)
      expect(claims.filter((claim) => claim.length > 0)).toHaveLength(1)
      expect(yield* collaboration.hasMail(root.id)).toBe(false)
    }),
  )

  it.instance("releases an interrupted claimed mailbox batch", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
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
      yield* collaboration.send({
        sessionID: child.id,
        target: "..",
        kind: "MESSAGE",
        content: "release me",
        triggerTurn: false,
      })

      const handling = yield* Effect.acquireUseRelease(
        collaboration.claimInbox({ sessionID: root.id }),
        () => Effect.never,
        (claimed) => collaboration.releaseClaimedInbox({ sessionID: root.id, messages: claimed }),
      ).pipe(Effect.forkChild)
      yield* Effect.sleep("10 millis")
      yield* Fiber.interrupt(handling)

      expect((yield* collaboration.inbox({ sessionID: root.id })).map((message) => message.content)).toEqual([
        "release me",
      ])
    }),
  )

  it.instance("returns acknowledged mail and requeues an unacknowledged remainder", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
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
      yield* Effect.forEach(
        ["acknowledged", "retry me"],
        (content) =>
          collaboration.send({
            sessionID: child.id,
            target: "..",
            kind: "MESSAGE",
            content,
            triggerTurn: false,
          }),
        { discard: true },
      )
      const claimed = yield* collaboration.claimInbox({ sessionID: root.id })
      const last = claimed[1]
      if (!last?.messageID || !last.partID) throw new Error("expected a durable mailbox part")
      yield* sessions.removePart({ sessionID: root.id, messageID: last.messageID, partID: last.partID })

      expect(
        (yield* collaboration.acknowledge({ sessionID: root.id, messages: claimed })).map((message) => message.content),
      ).toEqual(["acknowledged"])
      expect((yield* sessions.messages({ sessionID: root.id })).map((message) => message.info.role)).toEqual([
        "user",
        "user",
      ])
      expect((yield* collaboration.inbox({ sessionID: root.id })).map((message) => message.content)).toEqual([
        "retry me",
      ])
    }),
  )

  it.instance("accepts ordinary mail at the limit and rejects larger content", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
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
      const content = "x".repeat(MAX_MAILBOX_PAYLOAD_CHARS)
      expect(
        (yield* collaboration.send({
          sessionID: child.id,
          target: "..",
          kind: "MESSAGE",
          content,
          triggerTurn: false,
        }))?.content,
      ).toBe(content)
      expect(
        yield* collaboration
          .send({
            sessionID: child.id,
            target: "..",
            kind: "NEW_TASK",
            content: `${content}x`,
            triggerTurn: false,
          })
          .pipe(Effect.flip),
      ).toMatchObject({
        _tag: "CollaborationMailboxPayloadTooLarge",
        maximum: MAX_MAILBOX_PAYLOAD_CHARS,
        received: MAX_MAILBOX_PAYLOAD_CHARS + 1,
      })
    }),
  )

  it.instance("truncates oversized final answers with a sender-session reference", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
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
      yield* collaboration.complete({ sessionID: child.id, result: "x".repeat(MAX_MAILBOX_PAYLOAD_CHARS + 1) })

      const mail = (yield* collaboration.inbox({ sessionID: root.id }))[0]
      if (!mail) throw new Error("expected a final answer")
      const formatted = formatMailbox([mail])
      expect(formatted).toContain("Payload truncated. Read the full sender context in session")
      expect(formatted).toContain(child.id)
      expect(formatted.length).toBeLessThanOrEqual(MAX_MAILBOX_PROMPT_CHARS)
    }),
  )

  it.instance("creates a chronological placeholder for a recipient without user history", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root", agent: "build", model: sessionModel })
      const child = yield* sessions.create({
        parentID: root.id,
        title: "[agent] fresh",
        agent: "build",
        model: sessionModel,
      })
      yield* collaboration.registerRoot(root.id)
      yield* collaboration.registerChild({ parentSessionID: root.id, sessionID: child.id, taskName: "fresh" })
      const queued = yield* collaboration.send({
        sessionID: root.id,
        target: "fresh",
        kind: "MESSAGE",
        content: "work from this request only",
        triggerTurn: false,
      })

      expect(queued).toMatchObject({ recipientSessionID: child.id, content: "work from this request only" })
      expect(yield* sessions.messages({ sessionID: child.id })).toMatchObject([
        {
          info: { role: "user", agent: "build", model },
          parts: [expect.objectContaining({ ignored: true, synthetic: true })],
        },
      ])
      expect(yield* collaboration.inbox({ sessionID: child.id })).toMatchObject([
        { content: "work from this request only" },
      ])
    }),
  )

  it.instance("keeps a child retryable until final-answer persistence succeeds", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root" })
      const child = yield* sessions.create({
        parentID: root.id,
        title: "[agent] worker",
        agent: "build",
        model: sessionModel,
      })
      yield* collaboration.registerRoot(root.id)
      yield* collaboration.registerChild({ parentSessionID: root.id, sessionID: child.id, taskName: "worker" })

      const failure = yield* collaboration.complete({ sessionID: child.id, result: "result" }).pipe(Effect.flip)
      expect(failure._tag).toBe("CollaborationMailboxPersistenceError")
      expect((yield* collaboration.member(child.id))?.status).toBe("pending")
      expect(yield* collaboration.inbox({ sessionID: root.id })).toEqual([])

      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: root.id,
        agent: "build",
        model,
        time: { created: Date.now() },
      })
      expect((yield* collaboration.complete({ sessionID: child.id, result: "result" })).status).toBe("completed")
      expect(yield* collaboration.inbox({ sessionID: root.id })).toHaveLength(1)
    }),
  )

  it.instance("delivers completion only to the direct parent without triggering a parent turn", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
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

      expect((yield* collaboration.complete({ sessionID: child.id, result: "all tests pass" })).status).toBe(
        "completed",
      )
      const message = (yield* collaboration.inbox({ sessionID: root.id, drain: true }))[0]
      expect(message).toMatchObject({
        senderPath: "/root/worker",
        recipientPath: "/root",
        kind: "FINAL_ANSWER",
        triggerTurn: false,
        content: "<FINAL_ANSWER>\nall tests pass\n</FINAL_ANSWER>",
      })
    }),
  )

  it.instance("delivers only the first terminal result", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
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

      yield* collaboration.complete({ sessionID: child.id, result: "first result" })
      yield* collaboration.complete({ sessionID: child.id, error: "late error" })

      expect(yield* collaboration.member(child.id)).toMatchObject({ status: "completed", result: "first result" })
      expect(yield* collaboration.inbox({ sessionID: root.id, drain: true })).toHaveLength(1)
    }),
  )

  it.instance("removes descendants and then cleans up the complete root", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const root = session("remove_root")
      const child = session("remove_child")
      const grandchild = session("remove_grandchild")
      const sibling = session("remove_sibling")
      yield* collaboration.registerRoot(root)
      yield* collaboration.registerChild({ parentSessionID: root, sessionID: child, taskName: "child" })
      yield* collaboration.registerChild({ parentSessionID: child, sessionID: grandchild, taskName: "grandchild" })
      yield* collaboration.registerChild({ parentSessionID: root, sessionID: sibling, taskName: "sibling" })

      yield* collaboration.remove(child)
      expect(yield* collaboration.member(child)).toBeUndefined()
      expect(yield* collaboration.member(grandchild)).toBeUndefined()
      expect((yield* collaboration.list(root)).map((member) => member.path)).toEqual(["/root", "/root/sibling"])

      yield* collaboration.remove(root)
      expect(yield* collaboration.member(root)).toBeUndefined()
      expect(yield* collaboration.member(sibling)).toBeUndefined()
    }),
  )

  it.instance("removes a collaboration subtree when its session is deleted", () =>
    Effect.gen(function* () {
      const collaboration = yield* Collaboration.Service
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "root" })
      const child = yield* sessions.create({ parentID: root.id, title: "[agent] worker" })
      yield* collaboration.registerRoot(root.id)
      yield* collaboration.registerChild({ parentSessionID: root.id, sessionID: child.id, taskName: "worker" })

      yield* sessions.remove(root.id)
      yield* Effect.sleep("10 millis")
      expect(yield* collaboration.member(root.id)).toBeUndefined()
      expect(yield* collaboration.member(child.id)).toBeUndefined()
    }),
  )
})
