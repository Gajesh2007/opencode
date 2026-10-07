import { InstanceState } from "@/effect/instance-state"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly continuation: (sessionID: SessionID) => Effect.Effect<AbortSignal>
  // New explicit work invalidates older callbacks; synthetic wakeups must not call this.
  readonly resume: (sessionID: SessionID) => Effect.Effect<AbortSignal>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    signal?: AbortSignal,
  ) => Effect.Effect<MessageV2.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    ready?: Latch.Latch,
    signal?: AbortSignal,
  ) => Effect.Effect<MessageV2.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<MessageV2.WithParts>>()
        const continuations = new Map<SessionID, AbortController>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            continuations.forEach((controller) => controller.abort())
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
            continuations.clear()
          }),
        )
        return { runners, continuations, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<MessageV2.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          data.runners.delete(sessionID)
          yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
      })
      data.runners.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) yield* busyError(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      // Stop automatic work before cancellation itself can publish an idle event.
      // This is instance-local intent, not a completed/blocked goal status.
      const data = yield* InstanceState.get(state)
      if (!data.continuations.has(sessionID)) data.continuations.set(sessionID, new AbortController())
      data.continuations.get(sessionID)?.abort()
      const generations = new Map(data.continuations)
      // Cancelling a session must also cancel any subtask child sessions it spawned.
      // cancelBackgroundJobs walks the job graph and returns every affected session id
      // (the target + descendants via job metadata.sessionId). A child's run fiber is
      // forked into the instance scope, so cancelling its background job alone leaves
      // its runner "Running" (busy) — we must cancel each affected session's runner too.
      const affected = yield* cancelBackgroundJobs(background, sessionID)
      yield* Effect.forEach(
        affected,
        (id) =>
          Effect.gen(function* () {
            // Slow child cleanup must not cancel a newer, explicitly resumed turn.
            if (data.continuations.get(id) !== generations.get(id)) return
            if (!data.continuations.has(id)) data.continuations.set(id, new AbortController())
            data.continuations.get(id)?.abort()
            const existing = data.runners.get(id)
            if (!existing || !existing.busy) {
              yield* status.set(id, { type: "idle" })
              return
            }
            yield* existing.cancel
          }),
        { discard: true },
      )
    })

    const continuation = Effect.fn("SessionRunState.continuation")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.continuations.get(sessionID)
      if (existing) return existing.signal
      const controller = new AbortController()
      data.continuations.set(sessionID, controller)
      return controller.signal
    })

    const resume = Effect.fn("SessionRunState.resume")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      data.continuations.get(sessionID)?.abort()
      const controller = new AbortController()
      data.continuations.set(sessionID, controller)
      return controller.signal
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      signal?: AbortSignal,
    ) {
      const current = signal ?? (yield* continuation(sessionID))
      if (current.aborted) return yield* onInterrupt
      return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(
        Effect.suspend(() => (current.aborted ? onInterrupt : work)),
      )
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      ready?: Latch.Latch,
      signal?: AbortSignal,
    ) {
      const current = signal ?? (yield* continuation(sessionID))
      if (current.aborted) return yield* onInterrupt
      return yield* (yield* runner(sessionID, onInterrupt))
        .startShell(
          Effect.suspend(() =>
            current.aborted ? (ready?.open ?? Effect.void).pipe(Effect.andThen(onInterrupt)) : work,
          ),
          ready,
        )
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    return Service.of({ assertNotBusy, cancel, continuation, resume, ensureRunning, startShell })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list({ includeOutput: false })
  const pending = new Set<string>([sessionID])
  // Every session id touched (the target + descendant subtask sessions), so the caller
  // can cancel their runners too.
  const sessions = new Set<SessionID>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") {
                pending.add(job.metadata.sessionId)
                sessions.add(job.metadata.sessionId as SessionID)
              }
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
  return sessions
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export * as SessionRunState from "./run-state"
