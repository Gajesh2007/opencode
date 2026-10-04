import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Collaboration } from "@/agent/collaboration"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { TaskStatusTool } from "@/tool/task_status"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ModelID, ProviderID } from "@/provider/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    Collaboration.defaultLayer,
    Bus.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    RuntimeFlags.layer(flags),
  )

const it = testEffect(layer())

describe("tool.task_status", () => {
  it.instance("returns the waited turn's result when a follow-up reuses its job id", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({})
      yield* jobs.start({ id: chat.id, type: "task", run: Effect.succeed("original result") })
      const tool = yield* TaskStatusTool.pipe(
        Effect.provideService(BackgroundJob.Service, {
          ...jobs,
          wait: (input) =>
            jobs.wait(input).pipe(Effect.tap(() => jobs.start({ id: chat.id, type: "task", run: Effect.never }))),
        }),
      )
      const def = yield* tool.init()
      const result = yield* def.execute(
        { task_id: chat.id, wait: true, timeout_ms: 1_000 },
        {
          sessionID: chat.id,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      expect((yield* jobs.get(chat.id))?.status).toBe("running")
      expect(result.metadata).toMatchObject({ state: "completed", timed_out: false })
      expect(result.output).toContain("original result")
    }),
  )

  for (const type of ["spawn_agent", "followup_task"]) {
    it.instance(`distinguishes pending ${type} work from execution, including timed waits`, () =>
      Effect.gen(function* () {
        const collaboration = yield* Collaboration.Service
        const jobs = yield* BackgroundJob.Service
        const sessions = yield* Session.Service
        const def = yield* (yield* TaskStatusTool).init()
        const root = yield* sessions.create({})
        const child = yield* sessions.create({ parentID: root.id, title: "[agent] worker" })
        yield* collaboration.registerRoot(root.id)
        yield* collaboration.registerChild({ parentSessionID: root.id, sessionID: child.id, taskName: "worker" })
        if (type === "followup_task") {
          yield* collaboration.setStatus({ sessionID: child.id, status: "completed" })
          expect(yield* collaboration.claimFollowup({ sessionID: child.id, lastTask: "Resume" })).toBeDefined()
          expect(yield* collaboration.claimFollowup({ sessionID: child.id, lastTask: "Duplicate" })).toBeUndefined()
        }
        const start = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        yield* jobs.start({
          id: child.id,
          type,
          run: Effect.gen(function* () {
            yield* Deferred.await(start)
            yield* collaboration.setStatus({ sessionID: child.id, status: "running" })
            yield* Deferred.await(finish)
            return "all done"
          }),
        })
        const ctx = {
          sessionID: root.id,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }
        const pending = yield* def.execute({ task_id: child.id }, ctx)
        expect(pending.metadata.state).toBe("pending")
        expect(pending.output).toContain("has not begun executing")
        expect(pending.output).toContain("<task_result>")
        const waited = yield* def.execute({ task_id: child.id, wait: true, timeout_ms: 10 }, ctx)
        expect(waited.metadata).toMatchObject({ state: "pending", timed_out: true })

        yield* Deferred.succeed(start, undefined)
        yield* pollWithTimeout(
          collaboration
            .member(child.id)
            .pipe(Effect.map((member) => (member?.status === "running" ? member : undefined))),
          "child did not start",
        )
        expect((yield* def.execute({ task_id: child.id }, ctx)).metadata.state).toBe("running")
        yield* Deferred.succeed(finish, undefined)
        const completed = yield* def.execute({ task_id: child.id, wait: true, timeout_ms: 1_000 }, ctx)
        expect(completed.metadata.state).toBe("completed")
        expect(completed.output).toContain("all done")
      }),
    )
  }

  it.instance("returns completed background job output", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const tool = yield* TaskStatusTool
      const def = yield* tool.init()
      const chat = yield* sessions.create({})

      yield* jobs.start({ id: chat.id, type: "task", run: Effect.succeed("all done") })

      const result = yield* def.execute(
        { task_id: chat.id, wait: true, timeout_ms: 1_000 },
        {
          sessionID: chat.id,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("state: completed")
      expect(result.output).toContain("all done")
      expect(result.metadata.timed_out).toBe(false)
    }),
  )

  it.instance("wait=true times out while the background job is running", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const tool = yield* TaskStatusTool
      const def = yield* tool.init()
      const chat = yield* sessions.create({})

      yield* jobs.start({ id: chat.id, type: "task", run: Effect.never })

      const result = yield* def.execute(
        { task_id: chat.id, wait: true, timeout_ms: 50 },
        {
          sessionID: chat.id,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("state: running")
      expect(result.output).toContain("Timed out after 50ms")
      expect(result.metadata.timed_out).toBe(true)
    }),
  )

  it.instance("reads persisted collaboration agent output without a live background job", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tool = yield* TaskStatusTool
      const def = yield* tool.init()
      const child = yield* sessions.create({ title: "[agent] worker" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: child.id,
        agent: "build",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        time: { created: Date.now() },
      })
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: user.id,
        sessionID: child.id,
        mode: "build",
        agent: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test"),
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: child.id,
        type: "text",
        text: "durable agent result",
      })

      const result = yield* def.execute(
        { task_id: child.id },
        {
          sessionID: child.id,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("state: completed")
      expect(result.output).toContain("durable agent result")
    }),
  )
})
