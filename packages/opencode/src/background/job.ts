import { InstanceState } from "@/effect/instance-state"
import { Identifier } from "@/id/id"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer, References, Scope, SynchronizedRef } from "effect"
import path from "node:path"

export type Status = "running" | "completed" | "error" | "cancelled"

export type Info = {
  id: string
  type: string
  title?: string
  status: Status
  started_at: number
  completed_at?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
  /** Set once nothing blocks on the job anymore; its owner reports the result separately. */
  background?: boolean
}

type Active = {
  info: Info
  done: Deferred.Deferred<Info>
  // Resolves when the job moves to the background, releasing every `block` caller.
  backgrounded: Deferred.Deferred<Info>
  // Sessions currently blocked on this job, with how many concurrent blocks each holds.
  blockers: Map<string, number>
  fiber?: Fiber.Fiber<void, unknown>
  preparing?: Deferred.Deferred<void>
}

type Job = Active | { info: Info; receipt?: string }

type FinishResult = {
  info?: Info
  done?: Deferred.Deferred<Info>
}

type State = {
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Job>>
  scope: Scope.Scope
  directory?: string
  // Finished job ids per type, oldest first. Guarded by the jobs lock.
  finished: Map<string, string[]>
}

// Finished jobs stay readable for late readers (`wait`, `task_status`). Every shell command is a
// job, so retention is capped per type: a busy shell can't evict subagent results.
const FINISHED_LIMIT = 100

export type StartInput = {
  id?: string
  type: string
  title?: string
  metadata?: Record<string, unknown>
  rejectRunning?: boolean
  /** Start already backgrounded, so `block` returns immediately. */
  background?: boolean
  beforeStart?: Effect.Effect<void, unknown>
  run: Effect.Effect<string, unknown>
}

export type WaitInput = {
  id: string
  timeout?: number
}

export type WaitResult = {
  info?: Info
  timedOut: boolean
}

export type BlockResult = { type: "finished"; info: Info } | { type: "backgrounded"; info: Info }

export interface Interface {
  readonly list: (input?: { includeOutput?: boolean }) => Effect.Effect<Info[]>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info>
  /** Finishes a running job as an error while preserving any valid output. */
  readonly fail: (input: { id: string; error: string; output?: string }) => Effect.Effect<Info | undefined>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  /**
   * Waits for the job on behalf of `sessionID` until it finishes or is moved to the background.
   * Returns undefined for an unknown job. Interrupting the caller only stops waiting.
   */
  readonly block: (input: { id: string; sessionID: string }) => Effect.Effect<BlockResult | undefined>
  /** Moves a running job to the background, releasing its blockers. */
  readonly background: (id: string) => Effect.Effect<Info | undefined>
  /** Backgrounds every running job that `sessionID` is blocked on (Ctrl+B). */
  readonly backgroundAll: (input: { sessionID: string; type?: string }) => Effect.Effect<Info[]>
  readonly cancel: (id: string) => Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BackgroundJob") {}

function snapshot(job: { info: Info }): Info {
  return {
    ...job.info,
    ...(job.info.metadata ? { metadata: { ...job.info.metadata } } : {}),
  }
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

export function snapshotStack(frame: References.StackFrame | undefined): References.StackFrame | undefined {
  if (!frame) return
  return { name: frame.name, stack: stackText(frame.stack()), parent: snapshotStack(frame.parent) }
}

// This closure must own only the string, not the original traced invocation.
function stackText(text: string | undefined) {
  return () => text
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("BackgroundJob.state")(function* () {
        const s: State = {
          jobs: yield* SynchronizedRef.make(new Map()),
          scope: yield* Scope.Scope,
          // Receipts share the old in-memory registry's instance lifetime.
          directory: yield* fs
            .makeTempDirectoryScoped({ prefix: "opencode-background-" })
            .pipe(Effect.catchCause(() => Effect.succeed(undefined))),
          finished: new Map(),
        }
        // A fiber interrupted before entering its handler must still release existing waiters.
        yield* Effect.addFinalizer(() =>
          SynchronizedRef.get(s.jobs).pipe(
            Effect.flatMap((jobs) =>
              Effect.forEach(
                Array.from(jobs.values()),
                (job) => ("done" in job ? finish(s, job.info.id, "cancelled", undefined, job.done) : Effect.void),
                { discard: true },
              ),
            ),
          ),
        )
        return s
      }),
    )

    const read = (job: Job) =>
      "receipt" in job && job.receipt
        ? fs.readJson(job.receipt).pipe(
            Effect.map((data) => snapshot({ info: { ...job.info, ...(data as Pick<Info, "output" | "error">) } })),
            Effect.orDie,
          )
        : Effect.succeed(snapshot(job))

    // Readers finish loading a receipt before a reused id can retire its file.
    const lookup = Effect.fnUntraced(function* (id: string) {
      return yield* SynchronizedRef.modifyEffect<Map<string, Job>, Active | { info: Info } | undefined, never, never>(
        (yield* InstanceState.get(state)).jobs,
        Effect.fnUntraced(function* (jobs) {
          const job = jobs.get(id)
          return [job && ("done" in job ? job : { info: yield* read(job) }), jobs] as const
        }),
      )
    })

    const finish = Effect.fn("BackgroundJob.finish")(function* (
      s: State,
      id: string,
      status: Exclude<Status, "running">,
      data?: { output?: string; error?: string },
      generation?: Deferred.Deferred<Info>,
    ) {
      const completed_at = yield* Clock.currentTimeMillis
      const result = yield* SynchronizedRef.modifyEffect<Map<string, Job>, FinishResult, never, never>(
        s.jobs,
        Effect.fnUntraced(function* (jobs) {
          const job = jobs.get(id)
          if (!job) return [{}, jobs] as const
          if (!("done" in job)) return [{ info: yield* read(job) }, jobs] as const
          if (generation && job.done !== generation) return [{}, jobs] as const
          const info = {
            ...job.info,
            status,
            completed_at,
            ...(data?.output !== undefined ? { output: data.output } : {}),
            ...(data?.error !== undefined ? { error: data.error } : {}),
          }
          // Signal under the same lock that commits preparation, before startup can advance.
          if (job.preparing) {
            yield* Deferred.succeed(job.done, snapshot({ info }))
            return [{ info: snapshot({ info }) }, jobs] as const
          }
          if (!s.directory) {
            return [
              { info: snapshot({ info }), done: job.done },
              yield* retain(s, new Map(jobs).set(id, { info }), info),
            ] as const
          }
          const receipt = path.join(s.directory, Identifier.ascending("job") + ".json")
          const summary = { ...info }
          delete summary.output
          delete summary.error
          // Keep the result in memory if storage fails; never notify before it is readable.
          const stored = yield* fs.writeJson(receipt + ".tmp", { output: info.output, error: info.error }, 0o600).pipe(
            Effect.andThen(fs.rename(receipt + ".tmp", receipt)),
            Effect.as({ info: summary, receipt }),
            Effect.catchCause(() =>
              fs.remove(receipt + ".tmp", { force: true }).pipe(Effect.ignore, Effect.as({ info })),
            ),
          )
          return [
            { info: snapshot({ info }), done: job.done },
            yield* retain(s, new Map(jobs).set(id, stored), info),
          ] as const
        }),
      )
      if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
      return result.info
    }, Effect.uninterruptible)

    // Records a newly finished job and evicts the oldest finished ones of its type past the limit.
    // Runs under the jobs lock; `jobs` is the fresh map about to be committed.
    const retain = Effect.fnUntraced(function* (s: State, jobs: Map<string, Job>, info: Info) {
      const ids = (s.finished.get(info.type) ?? []).filter((item) => item !== info.id)
      ids.push(info.id)
      s.finished.set(info.type, ids)
      for (const old of ids.splice(0, Math.max(0, ids.length - FINISHED_LIMIT))) {
        const job = jobs.get(old)
        // An id can be reused by a newer run (task resume); never evict a running job.
        if (!job || "done" in job) continue
        jobs.delete(old)
        if ("receipt" in job && job.receipt) yield* fs.remove(job.receipt, { force: true }).pipe(Effect.ignore)
      }
      return jobs
    })

    const list: Interface["list"] = Effect.fn("BackgroundJob.list")(function* (input) {
      return yield* SynchronizedRef.modifyEffect(
        (yield* InstanceState.get(state)).jobs,
        Effect.fnUntraced(function* (jobs) {
          const infos = yield* Effect.forEach(Array.from(jobs.values()), (job) => {
            if (input?.includeOutput !== false) return read(job)
            const info = snapshot(job)
            delete info.output
            delete info.error
            return Effect.succeed(info)
          })
          return [infos.toSorted((a, b) => a.started_at - b.started_at), jobs] as const
        }),
      )
    })

    const get: Interface["get"] = Effect.fn("BackgroundJob.get")(function* (id) {
      const job = yield* lookup(id)
      if (!job) return
      return snapshot(job)
    })

    const start: Interface["start"] = Effect.fn("BackgroundJob.start")(function* (input) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const s = yield* InstanceState.get(state)
          const id = input.id ?? Identifier.ascending("job")
          const started_at = yield* Clock.currentTimeMillis
          const done = yield* Deferred.make<Info>()
          const preparing = input.beforeStart ? yield* Deferred.make<void>() : undefined
          const active: Active = {
            info: {
              id,
              type: input.type,
              title: input.title,
              status: "running",
              started_at,
              metadata: input.metadata,
              ...(input.background ? { background: true } : {}),
            },
            done,
            backgrounded: yield* Deferred.make<Info>(),
            blockers: new Map(),
            ...(preparing ? { preparing } : {}),
          }
          const previous = yield* SynchronizedRef.modifyEffect<Map<string, Job>, Job | undefined, never, never>(
            s.jobs,
            Effect.fnUntraced(function* (jobs) {
              const current = jobs.get(id)
              if (current && "done" in current) {
                if (input.rejectRunning) return yield* Effect.die(new Error(`Job ${id} is already running.`))
                return [current, jobs] as const
              }
              return [current, new Map(jobs).set(id, active)] as const
            }),
          )
          if (previous && "done" in previous) return snapshot(previous)

          if (input.beforeStart && preparing) {
            const prepared = yield* restore(
              Effect.raceFirst(input.beforeStart, Deferred.await(done).pipe(Effect.andThen(Effect.interrupt))),
            ).pipe(Effect.exit)
            const admitted =
              Exit.isSuccess(prepared) &&
              (yield* SynchronizedRef.modifyEffect<Map<string, Job>, boolean, never, never>(s.jobs, (jobs) =>
                Effect.gen(function* () {
                  if (jobs.get(id) !== active || (yield* Deferred.isDone(done))) return [false, jobs] as const
                  delete active.preparing
                  return [true, jobs] as const
                }),
              ))
            if (!admitted) {
              const restored = yield* SynchronizedRef.modify(s.jobs, (jobs) => {
                if (jobs.get(id) !== active) return [false, jobs] as const
                const next = new Map(jobs)
                if (previous) next.set(id, previous)
                else next.delete(id)
                return [true, next] as const
              })
              if (!restored && previous && "receipt" in previous && previous.receipt) {
                yield* fs.remove(previous.receipt, { force: true }).pipe(Effect.ignore)
              }
              yield* Deferred.succeed(done, {
                ...active.info,
                status: Exit.isFailure(prepared) && !Cause.hasInterruptsOnly(prepared.cause) ? "error" : "cancelled",
                completed_at: yield* Clock.currentTimeMillis,
                ...(Exit.isFailure(prepared) ? { error: errorText(Cause.squash(prepared.cause)) } : {}),
              })
              yield* Deferred.succeed(preparing, undefined)
              if (Exit.isFailure(prepared)) return yield* Effect.failCause(prepared.cause).pipe(Effect.orDie)
              return yield* Effect.interrupt
            }
            yield* Deferred.succeed(preparing, undefined)
          }
          if (previous && "receipt" in previous && previous.receipt) {
            yield* fs.remove(previous.receipt, { force: true }).pipe(Effect.ignore)
          }

          const ready = yield* Deferred.make<void>()
          const stack = snapshotStack(yield* References.CurrentStackFrame)
          const fiber = yield* Deferred.await(ready).pipe(
            Effect.andThen(restore(input.run)),
            Effect.matchCauseEffect({
              onSuccess: (output) => finish(s, id, "completed", { output }, done),
              onFailure: (cause) =>
                finish(
                  s,
                  id,
                  Cause.hasInterruptsOnly(cause) ? "cancelled" : "error",
                  { error: errorText(Cause.squash(cause)) },
                  done,
                ),
            }),
            Effect.asVoid,
            Effect.forkIn(s.scope, { startImmediately: true }),
            // Inherited lazy Effect.fn frames can own the caller's full tool context.
            // Keep diagnostic text and span ancestry without those argument closures.
            Effect.provideService(References.CurrentStackFrame, stack),
          )
          const attached = yield* SynchronizedRef.modifyEffect<
            Map<string, Job>,
            { info: Info; owned: boolean },
            never,
            never
          >(
            s.jobs,
            Effect.fnUntraced(function* (jobs) {
              const current = jobs.get(id)
              if (current !== active) return [{ info: yield* read(current ?? active), owned: false }, jobs] as const
              const job = { ...current, fiber }
              return [{ info: snapshot(job), owned: true }, new Map(jobs).set(id, job)] as const
            }),
          )
          if (!attached.owned || attached.info.status !== "running") {
            yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
            if (input.rejectRunning) return yield* Effect.interrupt
            return attached.info
          }
          yield* Deferred.succeed(ready, undefined).pipe(Effect.ignore)
          return attached.info
        }),
      )
    })

    const fail: Interface["fail"] = Effect.fn("BackgroundJob.fail")(function* (input) {
      return yield* finish(yield* InstanceState.get(state), input.id, "error", {
        error: input.error,
        output: input.output,
      })
    })

    const wait: Interface["wait"] = Effect.fn("BackgroundJob.wait")(function* (input) {
      const job = yield* lookup(input.id)
      if (!job) return { timedOut: false }
      if (!("done" in job)) return { info: snapshot(job), timedOut: false }
      if (input.timeout === undefined) return { info: yield* Deferred.await(job.done), timedOut: false }
      if (input.timeout <= 0) return { info: snapshot(job), timedOut: true }
      const info = yield* Deferred.await(job.done).pipe(Effect.timeoutOption(input.timeout))
      if (info._tag === "Some") return { info: info.value, timedOut: false }
      return { info: snapshot(job), timedOut: true }
    })

    // `start` identifies its entry by object identity, so these update the current Active in place.
    // Every update runs under the jobs lock.
    const block: Interface["block"] = Effect.fn("BackgroundJob.block")(function* (input) {
      const s = yield* InstanceState.get(state)
      const entry = yield* SynchronizedRef.modifyEffect<
        Map<string, Job>,
        BlockResult | Active | undefined,
        never,
        never
      >(
        s.jobs,
        Effect.fnUntraced(function* (jobs) {
          const job = jobs.get(input.id)
          if (!job) return [undefined, jobs] as const
          if (!("done" in job)) return [{ type: "finished" as const, info: yield* read(job) }, jobs] as const
          if (job.info.background) return [{ type: "backgrounded" as const, info: snapshot(job) }, jobs] as const
          job.blockers.set(input.sessionID, (job.blockers.get(input.sessionID) ?? 0) + 1)
          return [job, jobs] as const
        }),
      )
      if (!entry || "type" in entry) return entry
      return yield* Effect.raceFirst(
        Deferred.await(entry.done).pipe(Effect.map((info): BlockResult => ({ type: "finished", info }))),
        Deferred.await(entry.backgrounded).pipe(Effect.map((info): BlockResult => ({ type: "backgrounded", info }))),
      ).pipe(
        Effect.ensuring(
          SynchronizedRef.update(s.jobs, (jobs) => {
            const count = entry.blockers.get(input.sessionID) ?? 0
            if (count <= 1) entry.blockers.delete(input.sessionID)
            else entry.blockers.set(input.sessionID, count - 1)
            return jobs
          }),
        ),
      )
    })

    const moveToBackground = (job: Active) => {
      job.info = { ...job.info, background: true }
      job.blockers.clear()
      return snapshot(job)
    }

    const background: Interface["background"] = Effect.fn("BackgroundJob.background")(function* (id) {
      const s = yield* InstanceState.get(state)
      const moved = yield* SynchronizedRef.modify(
        s.jobs,
        (jobs): readonly [{ info: Info; backgrounded?: Deferred.Deferred<Info> } | undefined, Map<string, Job>] => {
          const job = jobs.get(id)
          if (!job || !("done" in job)) return [undefined, jobs]
          if (job.info.background) return [{ info: snapshot(job) }, jobs]
          return [{ info: moveToBackground(job), backgrounded: job.backgrounded }, jobs]
        },
      )
      if (moved?.backgrounded) yield* Deferred.succeed(moved.backgrounded, moved.info)
      return moved?.info
    })

    const backgroundAll: Interface["backgroundAll"] = Effect.fn("BackgroundJob.backgroundAll")(function* (input) {
      const s = yield* InstanceState.get(state)
      const moved = yield* SynchronizedRef.modify(s.jobs, (jobs) => {
        const selected = Array.from(jobs.values()).filter(
          (job): job is Active =>
            "done" in job &&
            job.info.status === "running" &&
            !job.info.background &&
            (input.type === undefined || job.info.type === input.type) &&
            job.blockers.has(input.sessionID),
        )
        return [selected.map((job) => ({ info: moveToBackground(job), backgrounded: job.backgrounded })), jobs] as const
      })
      yield* Effect.forEach(moved, (item) => Deferred.succeed(item.backgrounded, item.info), { discard: true })
      return moved.map((item) => item.info)
    })

    const cancel: Interface["cancel"] = Effect.fn("BackgroundJob.cancel")(function* (id) {
      const job = yield* lookup(id)
      if (!job) return
      if (!("done" in job)) return snapshot(job)
      if (job.fiber) {
        yield* Fiber.interrupt(job.fiber).pipe(Effect.ignore)
        yield* Fiber.await(job.fiber).pipe(Effect.ignore)
      }
      yield* finish(yield* InstanceState.get(state), id, "cancelled", undefined, job.done)
      if (job.preparing) yield* Deferred.await(job.preparing)
      return yield* Deferred.await(job.done)
    })

    return Service.of({ list, get, start, fail, wait, block, background, backgroundAll, cancel })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

export * as BackgroundJob from "./job"
