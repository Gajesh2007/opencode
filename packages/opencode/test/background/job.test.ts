import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option, References, Scope, Tracer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as PlatformError from "effect/PlatformError"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionRunState } from "@/session/run-state"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { withTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(BackgroundJob.defaultLayer)

describe("background.job", () => {
  it.instance("tracks started jobs through completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        title: "test job",
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job.id.startsWith("job_")).toBe(true)
      expect(job.status).toBe("running")
      expect(job.title).toBe("test job")

      yield* Deferred.succeed(latch, undefined)
      const done = yield* jobs.wait({ id: job.id })

      expect(done.timedOut).toBe(false)
      expect(done.info?.status).toBe("completed")
      expect(done.info?.output).toBe("done")
      expect((yield* jobs.list()).map((item) => item.id)).toEqual([job.id])
    }),
  )

  it.instance("returns a running snapshot when wait times out", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never,
      })

      const result = yield* jobs.wait({ id: job.id, timeout: 1 })

      expect(result.timedOut).toBe(true)
      expect(result.info?.status).toBe("running")
    }),
  )

  it.instance("deduplicates concurrent starts for a running id", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const started = yield* Deferred.make<void>()
      const id = "job_test"
      const [first, second] = yield* Effect.all(
        [
          jobs.start({
            id,
            type: "test",
            run: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          }),
          jobs.start({
            id,
            type: "test",
            run: Effect.fail(new Error("duplicate started")),
          }),
        ],
        { concurrency: "unbounded" },
      )

      yield* Deferred.await(started)

      expect(first.id).toBe(id)
      expect(second.id).toBe(id)
      expect(first.status).toBe("running")
      expect(second.status).toBe("running")
      expect((yield* jobs.list()).map((item) => item.id)).toEqual([id])

      yield* jobs.cancel(id)
    }),
  )

  it.instance("records failed jobs", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        run: Effect.fail(new Error("boom")),
      })

      const result = yield* jobs.wait({ id: job.id })

      expect(result.info?.status).toBe("error")
      expect(result.info?.error).toBe("boom")
    }),
  )

  it.instance("strict startup reserves the id before setup without blocking unrelated jobs", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const first = yield* jobs
        .start({
          id: "strict",
          type: "test",
          rejectRunning: true,
          beforeStart: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          run: Effect.succeed("winner"),
        })
        .pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      let duplicateSetup = false
      const duplicate = yield* jobs
        .start({
          id: "strict",
          type: "test",
          rejectRunning: true,
          beforeStart: Effect.sync(() => {
            duplicateSetup = true
          }),
          run: Effect.succeed("loser"),
        })
        .pipe(Effect.exit)
      expect(duplicate._tag).toBe("Failure")
      expect(duplicateSetup).toBe(false)
      yield* jobs.start({ id: "unrelated", type: "test", run: Effect.succeed("independent") })
      expect((yield* jobs.wait({ id: "unrelated" })).info?.output).toBe("independent")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      expect((yield* jobs.wait({ id: "strict" })).info?.output).toBe("winner")
    }),
  )

  for (const failure of ["failure", "defect", "throw", "interruption"] as const) {
    it.instance(`rolls back failed startup after ${failure} and preserves the previous receipt`, () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        yield* jobs.start({ id: "rollback", type: "test", run: Effect.succeed("previous") })
        const previous = (yield* jobs.wait({ id: "rollback" })).info
        const beforeStart =
          failure === "failure"
            ? Effect.fail(new Error("setup failed"))
            : failure === "defect"
              ? Effect.die("setup defect")
              : failure === "interruption"
                ? Effect.interrupt
                : Effect.sync(() => {
                    throw new Error("setup threw")
                  })
        const failed = yield* jobs
          .start({
            id: "rollback",
            type: "test",
            rejectRunning: true,
            beforeStart,
            run: Effect.succeed("must not run"),
          })
          .pipe(Effect.exit)
        expect(failed._tag).toBe("Failure")
        expect(yield* jobs.get("rollback")).toEqual(previous)
        expect((yield* jobs.wait({ id: "rollback" })).info).toEqual(previous)
        yield* jobs.start({ id: "rollback", type: "test", rejectRunning: true, run: Effect.succeed("retry") })
        expect((yield* jobs.wait({ id: "rollback" })).info?.output).toBe("retry")
      }),
    )
  }

  it.instance("cancels startup, releases waiters, and never starts the cancelled work", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const entered = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      let ran = false
      const starting = yield* jobs
        .start({
          id: "cancel-startup",
          type: "test",
          rejectRunning: true,
          beforeStart: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
          run: Effect.sync(() => {
            ran = true
            return "cancelled work"
          }),
        })
        .pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      const waiting = yield* jobs.wait({ id: "cancel-startup" }).pipe(Effect.forkScoped({ startImmediately: true }))
      expect((yield* jobs.cancel("cancel-startup"))?.status).toBe("cancelled")
      yield* Deferred.await(stopped)
      expect((yield* Fiber.await(starting))._tag).toBe("Failure")
      expect((yield* Fiber.join(waiting)).info?.status).toBe("cancelled")
      expect(yield* jobs.get("cancel-startup")).toBeUndefined()
      expect(ran).toBe(false)
      yield* jobs.start({ id: "cancel-startup", type: "test", rejectRunning: true, run: Effect.succeed("new winner") })
      expect((yield* jobs.wait({ id: "cancel-startup" })).info?.output).toBe("new winner")
    }),
  )

  it.instance("tracks immediately interrupted jobs", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({ type: "test", run: Effect.interrupt })
      const result = yield* jobs.wait({ id: job.id })

      expect(result.info?.status).toBe("cancelled")
    }),
  )

  it.instance("can cancel running jobs", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const interrupted = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      const cancelled = yield* jobs.cancel(job.id)

      expect(cancelled?.status).toBe("cancelled")
      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      expect((yield* jobs.get(job.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("returns immutable snapshots", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        metadata: { value: "initial" },
        run: Effect.succeed("done"),
      })

      if (job.metadata) job.metadata.value = "changed"

      expect((yield* jobs.get(job.id))?.metadata?.value).toBe("initial")
    }),
  )

  it.instance("preserves repeated waits, partial errors, and non-JSON metadata", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const metadata = { date: new Date(0), value: 1n }
      const job = yield* jobs.start({ id: "partial", type: "test", metadata, run: Effect.never })
      const waiting = yield* jobs.wait({ id: job.id }).pipe(Effect.forkScoped({ startImmediately: true }))
      const failed = yield* jobs.fail({ id: job.id, error: "delivery failed", output: "valid partial output" })
      if (!failed) return yield* Effect.die("failed job was not found")
      expect((yield* Fiber.join(waiting)).info).toEqual(failed)
      expect((yield* jobs.wait({ id: job.id })).info).toEqual(failed)
      expect(yield* jobs.get(job.id)).toEqual(failed)
      expect(yield* jobs.list()).toEqual([failed])
      expect((yield* jobs.get(job.id))?.metadata).toEqual(metadata)
      expect((yield* jobs.cancel(job.id))?.output).toBe("valid partial output")
    }),
  )

  it.instance("does not let a retired run complete a reused job id", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const release = yield* Deferred.make<void>()
      const oldStarted = yield* Deferred.make<void>()
      const oldExecuted = yield* Deferred.make<void>()
      const nextRelease = yield* Deferred.make<void>()
      yield* jobs.start({
        id: "reused",
        type: "test",
        run: Deferred.succeed(oldStarted, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as("obsolete output"),
          Effect.ensuring(Deferred.succeed(oldExecuted, undefined)),
        ),
      })
      yield* Deferred.await(oldStarted)
      const waiting = yield* jobs.wait({ id: "reused" }).pipe(Effect.forkScoped({ startImmediately: true }))
      const failed = yield* jobs.fail({ id: "reused", error: "retired", output: "old partial" })
      yield* jobs.start({ id: "reused", type: "test", run: Deferred.await(nextRelease).pipe(Effect.as("new output")) })
      expect((yield* Fiber.join(waiting)).info).toEqual(failed)
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(oldExecuted)
      expect((yield* jobs.wait({ id: "reused", timeout: 20 })).timedOut).toBe(true)
      yield* Deferred.succeed(nextRelease, undefined)
      expect((yield* jobs.wait({ id: "reused" })).info?.output).toBe("new output")
      expect((yield* jobs.wait({ id: "reused" })).info?.output).toBe("new output")
    }),
  )

  it.instance("preserves diagnostic text and parent spans across the background boundary", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const observed = yield* Deferred.make<{ frame?: References.StackFrame; span?: string }>()
      yield* jobs
        .start({
          type: "test",
          run: Effect.gen(function* () {
            const span = yield* Effect.serviceOption(Tracer.ParentSpan)
            yield* Deferred.succeed(observed, {
              frame: yield* References.CurrentStackFrame,
              span: Option.isSome(span) && span.value._tag === "Span" ? span.value.name : undefined,
            })
            return "done"
          }),
        })
        .pipe(
          Effect.provideService(References.CurrentStackFrame, {
            name: "fixture caller",
            stack: () => "fixture diagnostic text",
            parent: undefined,
          }),
        )
      const result = yield* Deferred.await(observed)
      const frames: References.StackFrame[] = []
      for (let frame = result.frame; frame; frame = frame.parent) frames.push(frame)
      expect(frames.find((frame) => frame.name === "fixture caller")?.stack()).toBe("fixture diagnostic text")
      expect(result.span).toBe("BackgroundJob.start")
    }),
  )
})

const directories: string[] = []
const reads: string[] = []
const recording = Layer.effect(
  AppFileSystem.Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    return AppFileSystem.Service.of({
      ...fs,
      readJson: (file) => Effect.sync(() => reads.push(file)).pipe(Effect.andThen(fs.readJson(file))),
      makeTempDirectoryScoped: (options) =>
        fs
          .makeTempDirectoryScoped(options)
          .pipe(Effect.tap((directory) => Effect.sync(() => directories.push(directory)))),
    })
  }),
).pipe(Layer.provide(AppFileSystem.defaultLayer))
const receipts = testEffect(BackgroundJob.layer.pipe(Layer.provideMerge(recording)))

receipts.instance("startup rollback preserves only the previous receipt file", () =>
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    const fs = yield* AppFileSystem.Service
    const before = directories.length
    yield* jobs.start({ id: "receipt-rollback", type: "test", run: Effect.succeed("previous receipt") })
    yield* jobs.wait({ id: "receipt-rollback" })
    const directory = directories.at(before)
    if (!directory) return yield* Effect.die("receipt directory was not allocated")
    const files = yield* fs.readDirectory(directory)
    expect(files).toHaveLength(1)
    yield* jobs
      .start({
        id: "receipt-rollback",
        type: "test",
        rejectRunning: true,
        beforeStart: Effect.die("setup failed"),
        run: Effect.succeed("must not run"),
      })
      .pipe(Effect.exit)
    expect(yield* fs.readDirectory(directory)).toEqual(files)
    expect((yield* jobs.get("receipt-rollback"))?.output).toBe("previous receipt")
  }),
)

receipts.live("instance disposal interrupts pending startup without leaving a reservation", () =>
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    const scope = yield* Scope.Scope
    const entered = yield* Deferred.make<void>()
    const starting = yield* Effect.scoped(
      Effect.gen(function* () {
        const starting = yield* jobs
          .start({
            id: "disposed-startup",
            type: "test",
            rejectRunning: true,
            beforeStart: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            run: Effect.die("disposed startup must not run"),
          })
          .pipe(Effect.forkIn(scope, { startImmediately: true }))
        yield* Deferred.await(entered)
        return starting
      }).pipe(withTmpdirInstance()),
    )
    expect((yield* Fiber.await(starting))._tag).toBe("Failure")
  }),
)

const routing = testEffect(
  Layer.mergeAll(Session.layer, SessionRunState.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        BackgroundJob.layer.pipe(Layer.provideMerge(recording)),
        Bus.layer,
        Storage.defaultLayer,
        SyncEvent.defaultLayer,
        RuntimeFlags.defaultLayer,
        SessionStatus.defaultLayer,
      ),
    ),
  ),
)

for (const action of ["cancel", "remove"] as const) {
  routing.instance(`${action} routes job summaries without reading completed receipts`, () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const state = yield* SessionRunState.Service
      const parent = yield* sessions.create({ title: "routing fixture" })
      yield* jobs.start({ id: "terminal", type: "test", run: Effect.succeed("completed output") })
      yield* jobs.wait({ id: "terminal" })
      yield* jobs.start({ id: "failed", type: "test", run: Effect.never })
      yield* jobs.fail({ id: "failed", error: "delivery failed", output: "valid partial output" })
      const before = reads.length
      const summaries = yield* jobs.list({ includeOutput: false })
      expect(reads.length).toBe(before)
      expect(summaries.map((job) => job.id)).toEqual(["terminal", "failed"])
      for (const summary of summaries) {
        expect("output" in summary).toBe(false)
        expect("error" in summary).toBe(false)
      }
      const full = yield* jobs.list()
      expect(full.find((job) => job.id === "terminal")?.output).toBe("completed output")
      expect(full.find((job) => job.id === "failed")).toMatchObject({
        output: "valid partial output",
        error: "delivery failed",
      })
      expect(reads.length - before).toBe(2)
      const completed = reads.slice(before)
      const started = yield* Deferred.make<void>()
      yield* jobs.start({
        id: "active",
        type: "test",
        metadata: { parentSessionId: parent.id },
        run: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      })
      yield* Deferred.await(started)
      const routed = reads.length
      yield* action === "cancel" ? state.cancel(parent.id) : sessions.remove(parent.id)
      expect(reads.slice(routed).filter((file) => completed.includes(file))).toEqual([])
      expect(reads.length - routed).toBeLessThanOrEqual(1)
      expect((yield* jobs.list({ includeOutput: false })).find((job) => job.id === "active")?.status).toBe("cancelled")
      expect(reads.length - routed).toBeLessThanOrEqual(1)
    }),
  )
}

receipts.live("retires superseded receipt files safely and cleans them on instance disposal", () =>
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const before = directories.length
    yield* Effect.scoped(
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        for (let index = 0; index < 8; index++) {
          yield* jobs.start({ id: "reused", type: "test", run: Effect.succeed(`output ${index}`) })
          yield* jobs.wait({ id: "reused" })
          const directory = directories.at(before)
          if (!directory) return yield* Effect.die("receipt directory was not allocated")
          expect(yield* fs.readDirectory(directory)).toHaveLength(1)
          // All these calls race a replacement; each must return a valid snapshot.
          yield* Effect.all(
            [
              jobs.get("reused"),
              jobs.list(),
              jobs.wait({ id: "reused" }),
              jobs.start({ id: "reused", type: "test", run: Effect.succeed(`replacement ${index}`) }),
            ],
            { concurrency: "unbounded" },
          )
          expect((yield* jobs.wait({ id: "reused" })).info?.output).toBe(`replacement ${index}`)
          expect(yield* fs.readDirectory(directory)).toHaveLength(1)
        }
      }).pipe(withTmpdirInstance()),
    )
    const directory = directories.at(before)
    if (!directory) return yield* Effect.die("receipt directory was not allocated")
    expect(yield* fs.exists(directory)).toBe(false)
  }),
)

const failing = testEffect(
  BackgroundJob.layer.pipe(
    Layer.provide(
      Layer.effect(
        AppFileSystem.Service,
        Effect.gen(function* () {
          const fs = yield* AppFileSystem.Service
          return AppFileSystem.Service.of({
            ...fs,
            writeJson: () =>
              Effect.fail(new AppFileSystem.FileSystemError({ method: "writeJson", cause: "fixture disk full" })),
          })
        }),
      ).pipe(Layer.provide(AppFileSystem.defaultLayer)),
    ),
  ),
)

failing.instance("keeps completed and partial error results when receipt storage fails", () =>
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    yield* jobs.start({ id: "complete", type: "test", run: Effect.succeed("complete output") })
    expect((yield* jobs.wait({ id: "complete" })).info?.output).toBe("complete output")
    expect((yield* jobs.wait({ id: "complete" })).info?.output).toBe("complete output")
    yield* jobs.start({ id: "error", type: "test", run: Effect.never })
    yield* jobs.fail({ id: "error", error: "failed", output: "partial output" })
    expect((yield* jobs.get("error"))?.output).toBe("partial output")
    expect((yield* jobs.wait({ id: "error" })).info?.error).toBe("failed")
    for (const summary of yield* jobs.list({ includeOutput: false })) {
      expect("output" in summary).toBe(false)
      expect("error" in summary).toBe(false)
    }
  }),
)

const unavailable = testEffect(
  BackgroundJob.layer.pipe(
    Layer.provide(
      Layer.effect(
        AppFileSystem.Service,
        Effect.gen(function* () {
          const fs = yield* AppFileSystem.Service
          return AppFileSystem.Service.of({
            ...fs,
            makeTempDirectoryScoped: () =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "makeTempDirectoryScoped",
                }),
              ),
          })
        }),
      ).pipe(Layer.provide(AppFileSystem.defaultLayer)),
    ),
  ),
)

unavailable.instance("keeps APIs usable when temporary storage cannot be allocated", () =>
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    expect(yield* jobs.list()).toEqual([])
    expect(yield* jobs.get("missing")).toBeUndefined()
    yield* jobs.start({ id: "fallback", type: "test", run: Effect.succeed("retained result") })
    expect((yield* jobs.wait({ id: "fallback" })).info?.output).toBe("retained result")
    expect((yield* jobs.get("fallback"))?.output).toBe("retained result")
    expect((yield* jobs.cancel("fallback"))?.output).toBe("retained result")
    expect((yield* jobs.list())[0]?.output).toBe("retained result")
  }),
)

receipts.live("isolates instances and completes an active waiter before receipt cleanup", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const jobs = yield* BackgroundJob.Service
    const fs = yield* AppFileSystem.Service
    const before = directories.length
    const waiting = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* jobs.start({ id: "shared", type: "test", run: Effect.never })
        return yield* jobs.wait({ id: "shared" }).pipe(Effect.forkIn(scope, { startImmediately: true }))
      }).pipe(withTmpdirInstance()),
    )
    expect((yield* Fiber.join(waiting)).info?.status).toBe("cancelled")
    yield* Effect.scoped(
      Effect.gen(function* () {
        expect(yield* jobs.get("shared")).toBeUndefined()
        yield* jobs.start({ id: "shared", type: "test", run: Effect.succeed("second instance") })
        expect((yield* jobs.wait({ id: "shared" })).info?.output).toBe("second instance")
      }).pipe(withTmpdirInstance()),
    )
    expect(directories.slice(before)).toHaveLength(2)
    for (const directory of directories.slice(before)) expect(yield* fs.exists(directory)).toBe(false)
  }),
)
