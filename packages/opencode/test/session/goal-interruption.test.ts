import { expect } from "bun:test"
import { Context, Deferred, Effect, Fiber, Latch, Layer } from "effect"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Goal } from "@/session/goal"
import { GoalDriver } from "@/session/goal-driver"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Steering } from "@/session/steering"
import { SessionStatus } from "@/session/status"
import { ModelID, ProviderID } from "@/provider/schema"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

class Harness extends Context.Service<
  Harness,
  {
    entered: Deferred.Deferred<void>
    release: Deferred.Deferred<Steering.SteerResult>
    loops: SessionID[]
    holdLoop: boolean
    loopEntered: Deferred.Deferred<void>
    loopRelease: Deferred.Deferred<void>
  }
>()("goal-interruption/Harness") {}

const harness = Layer.effect(
  Harness,
  Effect.gen(function* () {
    return {
      entered: yield* Deferred.make<void>(),
      release: yield* Deferred.make<Steering.SteerResult>(),
      loops: [],
      holdLoop: false,
      loopEntered: yield* Deferred.make<void>(),
      loopRelease: yield* Deferred.make<void>(),
    }
  }),
)
const steering = Layer.effect(
  Steering.Service,
  Effect.gen(function* () {
    const test = yield* Harness
    return Steering.Service.of({
      steer: () => Deferred.succeed(test.entered, undefined).pipe(Effect.andThen(Deferred.await(test.release))),
    })
  }),
)
const prompt = Layer.effect(
  SessionPrompt.Service,
  Effect.gen(function* () {
    const test = yield* Harness
    const sessions = yield* Session.Service
    const state = yield* SessionRunState.Service
    return SessionPrompt.Service.of({
      cancel: () => Effect.die("unexpected prompt.cancel"),
      prompt: () => Effect.die("unexpected prompt.prompt"),
      command: () => Effect.die("unexpected prompt.command"),
      shell: () => Effect.die("unexpected prompt.shell"),
      resolvePromptParts: () => Effect.die("unexpected prompt.resolvePromptParts"),
      loop: (input, signal) =>
        Effect.gen(function* () {
          if (test.holdLoop) {
            yield* Deferred.succeed(test.loopEntered, undefined)
            yield* Deferred.await(test.loopRelease)
          }
          const messages = yield* sessions.messages({ sessionID: input.sessionID })
          return yield* state.ensureRunning(
            input.sessionID,
            Effect.succeed(messages[messages.length - 1]),
            Effect.sync(() => {
              test.loops.push(input.sessionID)
              return messages[messages.length - 1]
            }),
            signal,
          )
        }).pipe(Effect.orDie),
    })
  }),
).pipe(Layer.provide(Layer.mergeAll(harness, Session.defaultLayer, SessionRunState.defaultLayer)))
const deps = Layer.mergeAll(
  Bus.defaultLayer,
  Goal.defaultLayer,
  Session.defaultLayer,
  SessionRunState.defaultLayer,
  BackgroundJob.defaultLayer,
  steering.pipe(Layer.provide(harness)),
  prompt,
  harness,
)
const it = testEffect(GoalDriver.layer.pipe(Layer.provideMerge(deps)))

const setup = Effect.fn("test.goalInterruption.setup")(function* (tokenBudget?: number) {
  const sessions = yield* Session.Service
  const goals = yield* Goal.Service
  const root = (yield* TestInstance).directory
  const chat = yield* sessions.create({ title: "Goal interruption fixture" })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: chat.id,
    role: "user",
    agent: "build",
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("no-provider") },
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID: chat.id,
    type: "text",
    text: "Finish the objective",
  })
  yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: chat.id,
    role: "assistant",
    parentID: user.id,
    agent: "build",
    mode: "build",
    modelID: user.model.modelID,
    providerID: user.model.providerID,
    path: { cwd: root, root },
    time: { created: Date.now(), completed: Date.now() },
    finish: "end_turn",
    cost: 0,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  yield* goals.create({ sessionID: chat.id, objective: "Finish the objective", tokenBudget })
  return chat.id
})

for (const type of ["continue", "complete", "blocked"] as const) {
  it.instance(`explicit stop invalidates pending ${type} steering`, () =>
    Effect.gen(function* () {
      const driver = yield* GoalDriver.Service
      const state = yield* SessionRunState.Service
      const test = yield* Harness
      const id = yield* setup()
      const pending = yield* driver.onIdle(id).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(test.entered), "steering did not start")

      yield* state.cancel(id)
      yield* Deferred.succeed(test.release, { type, message: "Steering finished after stop" })
      yield* Fiber.join(pending)

      expect(test.loops).toEqual([])
      const messages = yield* MessageV2.filterCompactedEffect(id)
      expect(messages.filter((message) => message.info.role === "user")).toHaveLength(1)
      const goal = yield* (yield* Goal.Service).get(id)
      expect(goal?.status).toBe("active")
      expect(goal?.blockedTurns).toBe(0)
    }),
  )
}

for (const budget of [undefined, 1]) {
  it.instance(`late idle after stop cannot inject ${budget ? "budget" : "continuation"} ping`, () =>
    Effect.gen(function* () {
      const driver = yield* GoalDriver.Service
      const state = yield* SessionRunState.Service
      const test = yield* Harness
      const id = yield* setup(budget)
      yield* Deferred.succeed(test.release, { type: "continue" as const, message: "keep going" })
      yield* state.cancel(id)

      yield* driver.onIdle(id)
      yield* driver.onIdle(id)

      expect(test.loops).toEqual([])
      expect(
        (yield* MessageV2.filterCompactedEffect(id)).filter((message) => message.info.role === "user"),
      ).toHaveLength(1)
      expect((yield* (yield* Goal.Service).get(id))?.status).toBe("active")
    }),
  )
}

it.instance("new work never revives a stale steering generation", () =>
  Effect.gen(function* () {
    const driver = yield* GoalDriver.Service
    const state = yield* SessionRunState.Service
    const test = yield* Harness
    const id = yield* setup()
    const pending = yield* driver.onIdle(id).pipe(Effect.forkChild)
    yield* awaitWithTimeout(Deferred.await(test.entered), "steering did not start")
    const old = yield* state.continuation(id)

    yield* state.cancel(id)
    yield* state.resume(id)
    yield* Deferred.succeed(test.release, { type: "continue" as const, message: "stale direction" })
    yield* Fiber.join(pending)

    expect(old.aborted).toBe(true)
    expect((yield* state.continuation(id)).aborted).toBe(false)
    expect(test.loops).toEqual([])
    expect((yield* MessageV2.filterCompactedEffect(id)).filter((message) => message.info.role === "user")).toHaveLength(
      1,
    )
  }),
)

it.instance("duplicate idle callbacks account and steer a finished turn only once", () =>
  Effect.gen(function* () {
    const driver = yield* GoalDriver.Service
    const test = yield* Harness
    const id = yield* setup()
    const first = yield* driver.onIdle(id).pipe(Effect.forkChild)
    yield* awaitWithTimeout(Deferred.await(test.entered), "steering did not start")
    const duplicate = yield* driver.onIdle(id).pipe(Effect.forkChild)
    yield* Deferred.succeed(test.release, { type: "continue" as const, message: "keep going" })
    yield* Fiber.join(first)
    yield* Fiber.join(duplicate)

    expect(test.loops).toEqual([id])
    expect((yield* (yield* Goal.Service).get(id))?.tokensUsed).toBe(15)
  }),
)

it.instance("internal runner interruption does not pause goal continuation", () =>
  Effect.gen(function* () {
    const driver = yield* GoalDriver.Service
    const state = yield* SessionRunState.Service
    const test = yield* Harness
    const id = yield* setup()
    const messages = yield* MessageV2.filterCompactedEffect(id)
    const interrupted = Effect.succeed(messages[messages.length - 1])

    yield* state.ensureRunning(id, interrupted, Effect.interrupt)
    expect((yield* state.continuation(id)).aborted).toBe(false)
    yield* Deferred.succeed(test.release, { type: "continue" as const, message: "keep going" })
    yield* driver.onIdle(id)
    expect(test.loops).toEqual([id])
  }),
)

it.instance("old goal resume cannot borrow a genuinely new user's generation", () =>
  Effect.gen(function* () {
    const driver = yield* GoalDriver.Service
    const state = yield* SessionRunState.Service
    const test = yield* Harness
    const id = yield* setup()
    test.holdLoop = true
    yield* Deferred.succeed(test.release, { type: "continue" as const, message: "keep going" })
    const pending = yield* driver.onIdle(id).pipe(Effect.forkChild)
    yield* awaitWithTimeout(Deferred.await(test.loopEntered), "goal resume was not entered")
    yield* state.cancel(id)
    yield* state.resume(id)
    yield* Deferred.succeed(test.loopRelease, undefined)
    yield* Fiber.join(pending)
    expect(test.loops).toEqual([])
    expect((yield* state.continuation(id)).aborted).toBe(false)
  }),
)

it.instance("slow cancellation cleanup cannot stop a newer user generation", () =>
  Effect.gen(function* () {
    const state = yield* SessionRunState.Service
    const jobs = yield* BackgroundJob.Service
    const id = yield* setup()
    const started = yield* Deferred.make<void>()
    const cancelling = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    yield* jobs.start({
      id: "goal-cancel-cleanup",
      type: "test",
      metadata: { parentSessionId: id },
      run: Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(cancelling, undefined).pipe(Effect.andThen(Deferred.await(release)))),
      ),
    })
    yield* Deferred.await(started)
    const old = yield* state.cancel(id).pipe(Effect.forkChild)
    yield* awaitWithTimeout(Deferred.await(cancelling), "background cancellation did not start")
    const current = yield* state.resume(id)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(old)
    expect(current.aborted).toBe(false)
    expect(yield* state.continuation(id)).toBe(current)
  }),
)

const prompts = testEffect(
  Layer.mergeAll(SessionPrompt.defaultLayer, SessionRunState.defaultLayer, Session.defaultLayer, Goal.defaultLayer),
)

prompts.instance(
  "a human shell command resumes a stopped session",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const state = yield* SessionRunState.Service
      const id = yield* setup()
      yield* prompt.cancel(id)
      const result = yield* prompt.shell({ sessionID: id, agent: "build", command: "true" })
      expect(result.info.role).toBe("assistant")
      expect((yield* state.continuation(id)).aborted).toBe(false)
    }),
  { config: { shell: "/bin/sh" } },
)

prompts.instance("only a genuine user prompt re-enables a stopped session", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const state = yield* SessionRunState.Service
    const id = yield* setup()
    const old = yield* state.continuation(id)
    yield* prompt.cancel(id)

    yield* prompt.loop({ sessionID: id })
    expect((yield* state.continuation(id)).aborted).toBe(true)
    yield* prompt.prompt({
      sessionID: id,
      agent: "build",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("no-provider") },
      variant: "default",
      parts: [{ type: "text", text: "Synthetic child completion", synthetic: true }],
    })
    expect((yield* state.continuation(id)).aborted).toBe(true)

    yield* prompt.prompt({
      sessionID: id,
      noReply: true,
      agent: "build",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("no-provider") },
      variant: "default",
      parts: [{ type: "text", text: "Please continue the objective" }],
    })
    expect(old.aborted).toBe(true)
    expect((yield* state.continuation(id)).aborted).toBe(false)
    expect((yield* (yield* Goal.Service).get(id))?.status).toBe("active")
  }),
)

class Boundary extends Context.Service<
  Boundary,
  {
    point?: "message" | "part"
    entered: Deferred.Deferred<void>
    release: Deferred.Deferred<void>
  }
>()("goal-interruption/Boundary") {}

const boundary = Layer.effect(
  Boundary,
  Effect.gen(function* () {
    return { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
  }),
)
const delayedSessions = Layer.effect(
  Session.Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const gate = yield* Boundary
    return Session.Service.of({
      ...sessions,
      updateMessage: (message) =>
        Effect.gen(function* () {
          const result = yield* sessions.updateMessage(message)
          if (gate.point === "message" && message.role === "user") {
            yield* Deferred.succeed(gate.entered, undefined)
            yield* Deferred.await(gate.release)
          }
          return result
        }),
      updatePart: (part) =>
        Effect.gen(function* () {
          const result = yield* sessions.updatePart(part)
          if (gate.point === "part" && part.type === "text" && part.synthetic) {
            yield* Deferred.succeed(gate.entered, undefined)
            yield* Deferred.await(gate.release)
          }
          return result
        }),
    })
  }),
).pipe(Layer.provide(Layer.mergeAll(Session.defaultLayer, boundary)))
const boundaries = testEffect(
  GoalDriver.layer.pipe(Layer.provideMerge(Layer.mergeAll(deps, delayedSessions, boundary))),
)

for (const budget of [undefined, 1]) {
  boundaries.instance(`stop at injection boundary suppresses ${budget ? "budget" : "continuation"} text`, () =>
    Effect.gen(function* () {
      const driver = yield* GoalDriver.Service
      const state = yield* SessionRunState.Service
      const test = yield* Harness
      const gate = yield* Boundary
      const id = yield* setup(budget)
      gate.point = "message"
      yield* Deferred.succeed(test.release, { type: "continue" as const, message: "keep going" })
      const pending = yield* driver.onIdle(id).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(gate.entered), "injection did not start")
      yield* state.cancel(id)
      yield* Deferred.succeed(gate.release, undefined)
      yield* Fiber.join(pending)

      expect(test.loops).toEqual([])
      expect(
        (yield* MessageV2.filterCompactedEffect(id)).filter((message) => message.info.role === "user"),
      ).toHaveLength(1)
    }),
  )
}

for (const budget of [undefined, 1]) {
  boundaries.instance(`stop during ${budget ? "budget" : "continuation"} part publication retracts the ping`, () =>
    Effect.gen(function* () {
      const driver = yield* GoalDriver.Service
      const state = yield* SessionRunState.Service
      const test = yield* Harness
      const gate = yield* Boundary
      const id = yield* setup(budget)
      gate.point = "part"
      yield* Deferred.succeed(test.release, { type: "continue" as const, message: "keep going" })
      const pending = yield* driver.onIdle(id).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(gate.entered), "ping was not saved")
      yield* state.cancel(id)
      yield* Deferred.succeed(gate.release, undefined)
      yield* Fiber.join(pending)
      yield* driver.onIdle(id)

      expect(test.loops).toEqual([])
      expect(
        (yield* MessageV2.filterCompactedEffect(id)).filter((message) => message.info.role === "user"),
      ).toHaveLength(1)
    }),
  )
}

class ShellGate extends Context.Service<
  ShellGate,
  {
    busy: Deferred.Deferred<void>
    release: Deferred.Deferred<void>
  }
>()("goal-interruption/ShellGate") {}

const shellGate = Layer.effect(
  ShellGate,
  Effect.gen(function* () {
    return { busy: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
  }),
)
const shellStatus = Layer.effect(
  SessionStatus.Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service
    const gate = yield* ShellGate
    return SessionStatus.Service.of({
      ...status,
      set: (id, value) =>
        status
          .set(id, value)
          .pipe(
            Effect.andThen(
              value.type === "busy"
                ? Deferred.succeed(gate.busy, undefined).pipe(Effect.andThen(Deferred.await(gate.release)))
                : Effect.void,
            ),
          ),
    })
  }),
).pipe(Layer.provide(Layer.mergeAll(SessionStatus.defaultLayer, shellGate)))
const shells = testEffect(
  Layer.mergeAll(
    SessionRunState.layer.pipe(Layer.provide(Layer.mergeAll(shellStatus, BackgroundJob.defaultLayer))),
    Session.defaultLayer,
    Goal.defaultLayer,
    shellGate,
  ),
)

shells.instance("a shell skipped by stop still opens cancellation readiness", () =>
  Effect.gen(function* () {
    const state = yield* SessionRunState.Service
    const gate = yield* ShellGate
    const id = yield* setup()
    const messages = yield* MessageV2.filterCompactedEffect(id)
    const interrupted = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const ready = yield* Latch.make()
    const running = yield* state
      .startShell(
        id,
        Deferred.succeed(interrupted, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.as(messages[messages.length - 1]),
        ),
        Effect.die("stopped shell work must never start"),
        ready,
      )
      .pipe(Effect.forkChild)
    yield* awaitWithTimeout(Deferred.await(gate.busy), "shell admission did not start")
    yield* state.cancel(id)
    yield* Deferred.succeed(gate.release, undefined)
    yield* awaitWithTimeout(Deferred.await(interrupted), "stopped shell did not use interruption fallback")
    yield* awaitWithTimeout(state.cancel(id), "cancel hung waiting for skipped shell readiness")
    yield* Deferred.succeed(finish, undefined)
    yield* Fiber.join(running)
    expect((yield* state.continuation(id)).aborted).toBe(true)
  }),
)
