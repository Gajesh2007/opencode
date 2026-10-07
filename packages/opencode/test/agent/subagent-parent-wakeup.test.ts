import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Option } from "effect"
import { Agent } from "@/agent/agent"
import type { TaskPromptOps } from "@/agent/child-session"
import { Collaboration, MAX_MAILBOX_MESSAGES, MAX_MAILBOX_PROMPT_CHARS } from "@/agent/collaboration"
import { SubagentLimit } from "@/agent/subagent-limit"
import { SubagentRun } from "@/agent/subagent-run"
import { Team } from "@/agent/team"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageV2 } from "@/session/message-v2"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SendMessageTool } from "@/tool/send_message"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

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
  SessionStatus.defaultLayer,
  SubagentLimit.defaultLayer,
  Team.defaultLayer,
  Truncate.defaultLayer,
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
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...ref,
      time: { created: Date.now(), completed: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  }
}

const setup = Effect.fn("ParentWakeupTest.setup")(function* (output: string) {
  const run = yield* SubagentRun.Service
  const jobs = yield* BackgroundJob.Service
  const collaboration = yield* Collaboration.Service
  const sessions = yield* Session.Service
  const status = yield* SessionStatus.Service
  const parent = yield* sessions.create({ title: "parent", agent: "build" })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: parent.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant = yield* sessions.updateMessage(
    reply({ sessionID: parent.id, messageID: user.id, parts: [] }, "delegating").info,
  )
  const batches: ReadonlyArray<Collaboration.Message>[] = []
  const resumed = yield* Deferred.make<void>()
  const ops: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
    prompt: (input) => Effect.succeed(reply(input, output)),
    loop: (input) =>
      Effect.gen(function* () {
        expect(input.sessionID).toBe(parent.id)
        yield* status.set(parent.id, { type: "busy" })
        yield* Deferred.succeed(resumed, undefined)
        // One completed parent turn consumes one real, payload-limited mailbox batch.
        batches.push(yield* collaboration.deliver({ sessionID: parent.id }).pipe(Effect.orDie))
        return reply({ sessionID: parent.id, parts: [] }, "batch consumed")
      }).pipe(Effect.ensuring(status.set(parent.id, { type: "idle" }))),
  }
  const context: Tool.Context = {
    sessionID: parent.id,
    messageID: assistant.id,
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps: ops },
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
  yield* status.set(parent.id, { type: "busy" })
  const complete = Effect.fn("ParentWakeupTest.complete")(function* (taskName: string) {
    const child = yield* run.run({ context, taskName, message: "Complete this task." })
    expect((yield* jobs.wait({ id: child.sessionID })).info?.status).toBe("completed")
    return child
  })
  const enqueue = Effect.fn("ParentWakeupTest.enqueue")(function* (taskName: string) {
    // Preload real completion mail without creating a second run-service notifier.
    yield* collaboration.registerRoot(parent.id)
    const child = yield* sessions.create({ parentID: parent.id, title: `[agent] ${taskName}`, agent: "build" })
    yield* collaboration.registerChild({ parentSessionID: parent.id, sessionID: child.id, taskName })
    yield* collaboration.complete({ sessionID: child.id, result: output })
  })
  return { run, jobs, collaboration, sessions, status, parent, context, batches, ops, resumed, complete, enqueue }
})

describe("agent.subagent parent wakeup", () => {
  for (const scenario of [
    {
      name: "17 short completions exceed the message limit",
      count: MAX_MAILBOX_MESSAGES + 1,
      output: "done",
      first: 16,
    },
    { name: "two large completions exceed the character limit", count: 2, output: "x".repeat(13_000), first: 1 },
  ]) {
    it.instance(scenario.name, () =>
      Effect.gen(function* () {
        const test = yield* setup(scenario.output)
        yield* Effect.forEach(
          Array.from({ length: scenario.count }, (_, index) => index),
          (index) => test.complete(`child_${index}`),
        )

        expect(test.batches).toEqual([])
        const batch = yield* test.collaboration.inbox({ sessionID: test.parent.id })
        expect(batch).toHaveLength(scenario.first)
        expect(Collaboration.formatMailbox(batch).length).toBeLessThanOrEqual(MAX_MAILBOX_PROMPT_CHARS)
        const latest = yield* test.sessions.findMessage(test.parent.id, (message) => message.info.role === "user")
        if (Option.isNone(latest)) return yield* Effect.die("parent must have a completion placeholder")
        expect(batch.some((mail) => mail.messageID === latest.value.info.id)).toBe(false)

        yield* test.status.set(test.parent.id, { type: "idle" })
        yield* pollWithTimeout(
          Effect.sync(() => (test.batches.flat().length === scenario.count ? true : undefined)),
          `parent did not consume ${scenario.count} pending completions after becoming idle`,
          "3 seconds",
        )
        expect(test.batches.map((messages) => messages.length)).toEqual([scenario.first, 1])
        expect(new Set(test.batches.flat().map((message) => message.id)).size).toBe(scenario.count)
        expect(yield* test.collaboration.hasMail(test.parent.id)).toBe(false)
      }),
    )
  }

  it.instance("one completion notifier consumes every pending batch", () =>
    Effect.gen(function* () {
      const test = yield* setup("x".repeat(13_000))
      yield* test.enqueue("already_completed")
      yield* test.complete("notifier")
      expect(yield* test.collaboration.inbox({ sessionID: test.parent.id })).toHaveLength(1)
      yield* test.status.set(test.parent.id, { type: "idle" })
      yield* pollWithTimeout(
        Effect.sync(() => (test.batches.length === 2 ? true : undefined)),
        "a single notifier did not continue after delivering its first batch",
        "3 seconds",
      )
      expect(test.batches.map((messages) => messages.length)).toEqual([1, 1])
      expect(yield* test.collaboration.hasMail(test.parent.id)).toBe(false)
    }),
  )

  for (const timing of ["before becoming idle", "between batches"]) {
    it.instance(`does not resume over a newer genuine user turn ${timing}`, () =>
      Effect.gen(function* () {
        const test = yield* setup("x".repeat(13_000))
        yield* test.enqueue("already_completed")
        yield* test.complete("notifier")
        const user = () => {
          const id = MessageID.ascending()
          return test.sessions.appendMessageWithPart(
            {
              id,
              role: "user",
              sessionID: test.parent.id,
              agent: "build",
              model: ref,
              time: { created: Date.now() },
            },
            {
              id: PartID.ascending(),
              messageID: id,
              sessionID: test.parent.id,
              type: "text",
              text: "Stop the previous work and answer my new question.",
            },
          )
        }
        const loop = test.ops.loop
        if (timing === "before becoming idle") yield* user()
        if (timing === "between batches") {
          test.ops.loop = (input) => loop(input).pipe(Effect.tap(() => user().pipe(Effect.orDie)))
        }
        yield* test.status.set(test.parent.id, { type: "idle" })
        if (timing === "between batches") {
          yield* awaitWithTimeout(Deferred.await(test.resumed), "parent never consumed the first batch")
        }
        // Observe across more than two 300ms notifier retries; no readiness is inferred from this window.
        const unexpected = yield* pollWithTimeout(
          Effect.sync(() => (test.batches.length > (timing === "between batches" ? 1 : 0) ? true : undefined)),
          "no unexpected continuation",
          "700 millis",
        ).pipe(Effect.option)
        expect(Option.isNone(unexpected)).toBe(true)
        expect(yield* test.collaboration.hasMail(test.parent.id)).toBe(true)
      }),
    )
  }

  for (const pendingCompletion of [true, false]) {
    it.instance(
      pendingCompletion
        ? "ordinary send_message mail can accompany a pending completion wakeup"
        : "ordinary send_message mail alone does not wake a parent with an old notifier",
      () =>
        Effect.gen(function* () {
          const test = yield* setup("done")
          const child = yield* test.complete("notifier")
          if (!pendingCompletion) yield* test.collaboration.deliver({ sessionID: test.parent.id })
          const send = yield* (yield* SendMessageTool).init()
          expect(
            (yield* send.execute(
              { target: "/root", message: "Ordinary coordination, not a new task." },
              { ...test.context, sessionID: child.sessionID },
            )).output,
          ).toContain("queued")
          const pending = yield* test.collaboration.inbox({ sessionID: test.parent.id })
          expect(pending.at(-1)).toMatchObject({ kind: "MESSAGE", triggerTurn: false })
          yield* test.status.set(test.parent.id, { type: "idle" })
          if (pendingCompletion) {
            yield* pollWithTimeout(
              Effect.sync(() => (test.batches.flat().length === 2 ? true : undefined)),
              "ordinary mail blocked the pending completion wakeup",
            )
            expect(test.batches.flat().map((message) => message.kind)).toEqual(["FINAL_ANSWER", "MESSAGE"])
            expect(yield* test.collaboration.hasMail(test.parent.id)).toBe(false)
            return
          }
          expect(Option.isNone(yield* Deferred.await(test.resumed).pipe(Effect.timeoutOption("700 millis")))).toBe(true)
          expect(yield* test.collaboration.inbox({ sessionID: test.parent.id })).toEqual(pending)
        }),
    )
  }

  for (const outcome of ["no progress", "failure", "aborted reply"]) {
    it.instance(`stops a single notifier after a loop with ${outcome}`, () =>
      Effect.gen(function* () {
        const test = yield* setup("x".repeat(13_000))
        yield* test.enqueue("already_completed")
        yield* test.complete("notifier")
        const calls: SessionPrompt.LoopInput[] = []
        const loop = test.ops.loop
        test.ops.loop = (input) =>
          Effect.gen(function* () {
            calls.push(input)
            yield* Deferred.succeed(test.resumed, undefined)
            if (outcome === "no progress") return reply({ sessionID: input.sessionID, parts: [] }, "no delivery")
            const result = yield* loop(input)
            if (outcome === "failure") return yield* Effect.die(new Error("parent loop failed"))
            if (result.info.role !== "assistant") return yield* Effect.die("expected an assistant reply")
            return {
              ...result,
              info: { ...result.info, error: new MessageV2.AbortedError({ message: "Cancelled" }).toObject() },
            }
          })
        yield* test.status.set(test.parent.id, { type: "idle" })
        yield* awaitWithTimeout(Deferred.await(test.resumed), "parent never resumed")
        expect(
          Option.isNone(
            yield* pollWithTimeout(
              Effect.sync(() => (calls.length > 1 ? true : undefined)),
              "no unexpected continuation",
              "700 millis",
            ).pipe(Effect.option),
          ),
        ).toBe(true)
        expect(calls).toHaveLength(1)
        expect(test.batches).toHaveLength(outcome === "no progress" ? 0 : 1)
        expect(yield* test.collaboration.hasMail(test.parent.id)).toBe(true)
      }),
    )
  }

  for (const newer of ["no new mail", "ordinary mail", "late child completion", "new parent work"]) {
    it.instance(`respects explicit parent cancellation with ${newer}`, () =>
      Effect.gen(function* () {
        const test = yield* setup("done")
        const child = yield* test.complete("first")
        yield* test.complete("second")
        const release = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        if (newer === "late child completion") {
          test.ops.prompt = (input) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(reply(input, "old work finished late")),
            )
        }
        const late =
          newer === "late child completion"
            ? yield* test.run.run({ context: test.context, taskName: "late", message: "Old work still in progress." })
            : undefined
        if (late) yield* awaitWithTimeout(Deferred.await(entered), "old child never started")
        const latest = yield* test.sessions.findMessage(test.parent.id, (message) => message.info.role === "user")
        if (Option.isNone(latest)) return yield* Effect.die("parent must have completion mail")
        const cancelled = yield* MessageV2.get({ sessionID: test.parent.id, messageID: test.context.messageID })
        if (cancelled.info.role !== "assistant") return yield* Effect.die("expected an assistant reply")
        expect(cancelled.info.id < latest.value.info.id).toBe(true)
        const completed = latest.value.info.time.created + 1
        yield* test.sessions.updateMessage({
          ...cancelled.info,
          time: { ...cancelled.info.time, completed },
          error: new MessageV2.AbortedError({ message: "Explicit parent cancellation" }).toObject(),
        })
        if (newer === "ordinary mail" || late) {
          // Give new mail a strictly later timestamp without assuming scheduler timing.
          yield* pollWithTimeout(
            Effect.sync(() => (Date.now() > completed ? true : undefined)),
            "clock did not advance past cancellation",
          )
        }
        if (newer === "ordinary mail") {
          const send = yield* (yield* SendMessageTool).init()
          yield* send.execute(
            { target: "/root", message: "This message must not restart cancelled work." },
            { ...test.context, sessionID: child.sessionID },
          )
        }
        if (late) {
          yield* Deferred.succeed(release, undefined)
          expect((yield* test.jobs.wait({ id: late.sessionID })).info?.status).toBe("completed")
        }
        if (newer === "new parent work") {
          const id = MessageID.ascending()
          yield* test.sessions.appendMessageWithPart(
            {
              id,
              role: "user",
              sessionID: test.parent.id,
              agent: "build",
              model: ref,
              time: { created: Date.now() },
            },
            {
              id: PartID.ascending(),
              messageID: id,
              sessionID: test.parent.id,
              type: "text",
              text: "Start a new delegated task.",
            },
          )
          const assistant = yield* test.sessions.updateMessage(
            reply({ sessionID: test.parent.id, messageID: id, parts: [] }, "delegating new work").info,
          )
          const restarted = yield* test.run.run({
            context: { ...test.context, messageID: assistant.id },
            taskName: "after_cancel",
            message: "Newly authorized work.",
          })
          expect((yield* test.jobs.wait({ id: restarted.sessionID })).info?.status).toBe("completed")
        }
        yield* test.status.set(test.parent.id, { type: "idle" })
        if (newer === "new parent work") {
          yield* pollWithTimeout(
            Effect.sync(() => (test.batches.flat().length === 3 ? true : undefined)),
            "completion of newly authorized work did not resume its parent",
          )
          expect(yield* test.collaboration.hasMail(test.parent.id)).toBe(false)
          return
        }
        expect(Option.isNone(yield* Deferred.await(test.resumed).pipe(Effect.timeoutOption("700 millis")))).toBe(true)
        expect(yield* test.collaboration.inbox({ sessionID: test.parent.id })).toHaveLength(
          newer === "no new mail" ? 2 : 3,
        )
      }),
    )
  }

  it.instance("explicitly cancelling a child produces neither completion mail nor a parent wakeup", () =>
    Effect.gen(function* () {
      const test = yield* setup("unused")
      const entered = yield* Deferred.make<void>()
      test.ops.prompt = () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
      const child = yield* test.run.run({
        context: test.context,
        taskName: "cancelled",
        message: "Wait for cancellation.",
      })
      yield* awaitWithTimeout(Deferred.await(entered), "child never entered its turn")
      expect((yield* test.jobs.cancel(child.sessionID))?.status).toBe("cancelled")
      expect((yield* test.collaboration.member(child.sessionID))?.status).toBe("interrupted")
      yield* test.status.set(test.parent.id, { type: "idle" })
      expect(Option.isNone(yield* Deferred.await(test.resumed).pipe(Effect.timeoutOption("700 millis")))).toBe(true)
      expect(yield* test.collaboration.hasMail(test.parent.id)).toBe(false)
    }),
  )
})
