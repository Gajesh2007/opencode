import { afterEach, expect } from "bun:test"
import { randomBytes } from "node:crypto"
import { heapStats } from "bun:jsc"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Collaboration } from "@/agent/collaboration"
import { SubagentLimit } from "@/agent/subagent-limit"
import { SubagentRun } from "@/agent/subagent-run"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { ModelID, ProviderID } from "@/provider/schema"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import type { Tool } from "@/tool/tool"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Opt in: each invocation is a fresh Bun process with test/preload.ts isolation.
const enabled = process.env.OPENCODE_MEMORY_BENCH === "1"
const phase = process.env.OPENCODE_MEMORY_PHASE ?? "jobs"
const refs: WeakRef<object>[] = []
const size = 1024 * 1024
async function sample(phase: string, count: number) {
  for (let index = 0; index < 5; index++) {
    Bun.gc(true)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  Bun.gc(true)
  const memory = process.memoryUsage()
  const stats = heapStats()
  console.log(
    JSON.stringify({
      phase,
      count,
      ...memory,
      jscHeap: stats.heapSize,
      jscExtra: stats.extraMemorySize,
      liveContexts: refs.filter((ref) => ref.deref()).length,
    }),
  )
}

afterEach(async () => {
  if (!enabled) return
  await disposeAllInstances()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await sample("disposed", 0)
})

const dependencies = Layer.mergeAll(
  Agent.defaultLayer,
  BackgroundJob.defaultLayer,
  Collaboration.defaultLayer,
  Config.defaultLayer,
  Plugin.defaultLayer,
  Session.defaultLayer,
  SessionStatus.defaultLayer,
  SubagentLimit.defaultLayer,
  RuntimeFlags.layer({ subagentConcurrency: 1 }),
)
const it = testEffect(SubagentRun.layer.pipe(Layer.provideMerge(dependencies)))
const ref = { modelID: ModelID.make("test-model"), providerID: ProviderID.make("test") }

function reply(input: SessionPrompt.PromptInput, text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID: input.sessionID,
      parentID: input.messageID ?? MessageID.ascending(),
      role: "assistant",
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...ref,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  }
}

;(enabled ? it.instance : it.instance.skip)(
  "measures terminal receipts and permit-queued contexts",
  () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const run = yield* SubagentRun.Service
      const sessions = yield* Session.Service
      const limit = yield* SubagentLimit.Service
      const parent = yield* sessions.create({ title: "memory fixture", agent: "build" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: parent.id,
        role: "user",
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      })
      const assistant = reply({ sessionID: parent.id, messageID: user.id, parts: [] }, "seed")
      yield* sessions.updateMessage(assistant.info)
      const ops = {
        cancel: () => Effect.void,
        resolvePromptParts: (text: string) => Effect.succeed([{ type: "text" as const, text }]),
        prompt: (input: SessionPrompt.PromptInput) => Effect.succeed(reply(input, "small result")),
        loop: (input: SessionPrompt.LoopInput) =>
          Effect.succeed(reply({ sessionID: input.sessionID, parts: [] }, "unused")),
      }
      // Warm service state before sampling, without retaining fixture output in the caller.
      yield* jobs.start({ id: "warm", type: "fixture", run: Effect.succeed("warm") })
      yield* jobs.wait({ id: "warm" }).pipe(Effect.asVoid)
      yield* Effect.promise(() => sample("warm", 0))
      for (let batch = 0; phase === "jobs" && batch < 3; batch++) {
        for (let index = 0; index < 16; index++) {
          const id = `fixture_${batch}_${index}`
          yield* jobs.start({ id, type: "fixture", run: Effect.sync(() => randomBytes(size / 2).toString("hex")) })
          yield* jobs.wait({ id }).pipe(Effect.asVoid)
        }
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
        yield* Effect.promise(() => sample("completed", (batch + 1) * 16))
      }
      if (phase === "jobs") {
        expect((yield* jobs.get("fixture_0_0"))?.output?.length).toBe(size)
        expect((yield* jobs.wait({ id: "fixture_0_0" })).info?.output?.length).toBe(size)
        expect((yield* jobs.list()).length).toBe(49)
        return
      }
      if (phase === "queue") {
        const warmChild = yield* run.run({
          context: {
            sessionID: parent.id,
            messageID: assistant.info.id,
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            extra: { promptOps: ops },
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
          taskName: "warm_child",
          message: "warm child services",
        })
        yield* jobs.wait({ id: warmChild.sessionID }).pipe(Effect.asVoid)
      }
      const held = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const blocker = yield* limit
        .withPermit(Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))))
        .pipe(Effect.forkScoped)
      yield* Deferred.await(held)
      yield* Effect.promise(() => sample("queue_start", 0))
      for (let batch = 0; batch < 3; batch++) {
        for (let index = 0; index < 8; index++) {
          yield* Effect.suspend(() => {
            const context: Tool.Context = {
              sessionID: parent.id,
              messageID: assistant.info.id,
              agent: "build",
              abort: new AbortController().signal,
              messages: [reply({ sessionID: parent.id, parts: [] }, randomBytes(size / 2).toString("hex"))],
              extra: { promptOps: ops },
              metadata: () => Effect.void,
              ask: () => Effect.void,
            }
            refs.push(new WeakRef(context))
            return run
              .run({ context, taskName: `queued_${batch}_${index}`, message: "fixture task" })
              .pipe(Effect.asVoid)
          })
        }
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
        yield* Effect.promise(() => sample("queued", (batch + 1) * 8))
      }
      const queued = (yield* jobs.list()).filter((job) => job.status === "running").map((job) => job.id)
      expect(queued.length).toBe(24)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(blocker)
      yield* Effect.forEach(queued, (id) => jobs.wait({ id }).pipe(Effect.asVoid), { discard: true })
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
      yield* Effect.promise(() => sample("drained", queued.length))
    }),
  { config: { experimental: { subagent_concurrency: 1 } } },
  120_000,
)
