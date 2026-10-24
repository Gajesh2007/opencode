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
  /** Stops the session's turn and every subagent it spawned, recursively. */
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  /** Stops the session's turn like `cancel`, but leaves its subagents running. Returns whether a turn was running. */
  readonly interrupt: (sessionID: SessionID) => Effect.Effect<boolean>
  /** Stops the session's running subagents and their descendants, but not its own turn. Returns their session ids. */
  readonly stopSubagents: (sessionID: SessionID) => Effect.Effect<SessionID[]>
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

    // Stops each session's turn and automatic work, unless an explicit prompt renewed its continuation since
    // `generations` was taken: slow child cleanup must not cancel a newer, explicitly resumed turn.
    const stopTurns = Effect.fnUntraced(function* (
      ids: Iterable<SessionID>,
      generations: ReadonlyMap<SessionID, AbortController>,
    ) {
      const data = yield* InstanceState.get(state)
      yield* Effect.forEach(
        ids,
        (id) =>
          Effect.gen(function* () {
            if (data.continuations.get(id) !== generations.get(id)) return
            halt(data.continuations, id)
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

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      // Stop automatic work before cancellation itself can publish an idle event.
      // This is instance-local intent, not a completed/blocked goal status.
      const data = yield* InstanceState.get(state)
      halt(data.continuations, sessionID)
      const generations = new Map(data.continuations)
      // Cancelling a session must also cancel any subtask child sessions it spawned.
      // A child's run fiber is forked into the instance scope, so cancelling its background
      // job alone leaves its runner "Running" (busy) — we must cancel each affected session's runner too.
      const affected = yield* cancelSubagentJobs(background, sessionID, true)
      yield* stopTurns(new Set([sessionID, ...affected]), generations)
    })

    const interrupt = Effect.fn("SessionRunState.interrupt")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      halt(data.continuations, sessionID)
      const existing = data.runners.get(sessionID)
      if (!existing?.busy) {
        yield* status.set(sessionID, { type: "idle" })
        return false
      }
      yield* existing.cancel
      return true
    })

    const stopSubagents = Effect.fn("SessionRunState.stopSubagents")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const generations = new Map(data.continuations)
      const affected = yield* cancelSubagentJobs(background, sessionID, false)
      yield* stopTurns(affected, generations)
      return Array.from(affected)
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

    return Service.of({
      assertNotBusy,
      cancel,
      interrupt,
      stopSubagents,
      continuation,
      resume,
      ensureRunning,
      startShell,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
)

// Aborting the continuation keeps automatic work (goal mode, background completion wakeups) from restarting the
// session; only explicit new work renews it.
function halt(continuations: Map<SessionID, AbortController>, sessionID: SessionID) {
  if (!continuations.has(sessionID)) continuations.set(sessionID, new AbortController())
  continuations.get(sessionID)?.abort()
}

// Cancels the running subagent jobs the session spawned (with `self`, also the session's own job when it is a
// subagent itself), then walks the job graph to cancel their descendants. Returns the descendant session ids,
// whose runners the caller must still cancel: a child's run fiber lives in the instance scope, not in its job.
// Shell jobs carry `ownerSessionID` instead of `sessionId`/`parentSessionId`, so they are never matched.
const cancelSubagentJobs = Effect.fn("SessionRunState.cancelSubagentJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
  self: boolean,
) {
  const jobs = yield* background.list({ includeOutput: false })
  const pending = new Set<string>(self ? [sessionID] : [])
  const sessions = new Set<SessionID>()
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    if (typeof job.metadata?.parentSessionId !== "string") return false
    return job.metadata.parentSessionId === sessionID || pending.has(job.metadata.parentSessionId)
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
                sessions.add(SessionID.make(job.metadata.sessionId))
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
