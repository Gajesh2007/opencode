import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import { Deferred, Effect, Exit, Layer, Scope, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Bus } from "@/bus"
import { ShellProcess } from "@/shell/process"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(ShellProcess.defaultLayer, Bus.layer))

const unix = process.platform !== "win32"

const create = (command: string, input: Partial<ShellProcess.CreateInput> = {}) =>
  Effect.gen(function* () {
    const shells = yield* ShellProcess.Service
    return yield* shells.create({
      command,
      cwd: process.cwd(),
      shell: "/bin/sh",
      source: "tool",
      spawn: ChildProcess.make(command, [], { shell: "/bin/sh", stdin: "ignore", detached: true }),
      ...input,
    })
  })

describe.skipIf(!unix)("shell.process", () => {
  it.instance("captures combined output to a file and reports the exit", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      const sessionID = SessionID.make("ses_shellprocess")
      const info = yield* create("echo out; echo err >&2; exit 3", { sessionID, description: "demo" })

      expect(info.id.startsWith("sh_")).toBe(true)
      expect(info.status).toBe("running")
      expect(info.pid).toBeGreaterThan(0)
      expect(info.sessionID).toBe(sessionID)
      expect(info.background).toBe(false)

      const done = yield* shells.wait(info.id)
      expect(done.status).toBe("exited")
      expect(done.exit).toBe(3)
      expect(done.time.completed).toBeGreaterThanOrEqual(done.time.started)

      const text = yield* Effect.promise(() => fs.readFile(done.file, "utf8"))
      expect(text).toContain("out\n")
      expect(text).toContain("err\n")
      const page = yield* shells.output(info.id)
      expect(page.output).toBe(text)
      expect(page.cursor).toBe(page.size)
      expect((yield* shells.list({ sessionID })).map((item) => item.id)).toEqual([info.id])
      expect(yield* shells.list({ sessionID: SessionID.make("ses_other") })).toEqual([])
    }),
  )

  it.instance("streams output to a listener registered at creation", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      const ended = yield* Deferred.make<void>()
      const chunks: string[] = []
      const info = yield* create("printf 'a'; printf 'b'", {
        listener: {
          chunk: (text) => chunks.push(text),
          end: () => Deferred.doneUnsafe(ended, Exit.void),
        },
      })
      yield* Deferred.await(ended)
      expect(chunks.join("")).toBe("ab")
      expect((yield* shells.wait(info.id)).exit).toBe(0)
    }),
  )

  it.instance("keeps running after the creating scope closes", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      const scope = yield* Scope.make()
      const info = yield* create("sleep 0.2; echo survived").pipe(Scope.provide(scope))
      yield* Scope.close(scope, Exit.void)
      const done = yield* shells.wait(info.id)
      expect(done.status).toBe("exited")
      expect((yield* shells.output(info.id)).output).toBe("survived\n")
    }),
  )

  it.instance("kills a command when its timeout elapses", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      const started = yield* Deferred.make<void>()
      const info = yield* create("echo started; sleep 30", {
        listener: { chunk: () => Deferred.doneUnsafe(started, Exit.void) },
      })
      yield* Deferred.await(started)
      yield* shells.timeout(info.id, 50)
      const done = yield* shells.wait(info.id)
      expect(done.status).toBe("timeout")
      expect(done.exit).toBeUndefined()
      expect(done.signal).toBe("SIGTERM")
      expect((yield* shells.output(info.id)).output).toBe("started\n")
    }),
  )

  it.instance("clears and replaces a running timeout", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      const cleared = yield* create("sleep 1; echo finished", { timeout: 500 })
      yield* shells.timeout(cleared.id, 0)
      expect((yield* shells.wait(cleared.id)).status).toBe("exited")

      const replaced = yield* create("sleep 30")
      yield* shells.timeout(replaced.id, 50)
      expect((yield* shells.wait(replaced.id)).status).toBe("timeout")
    }),
  )

  it.instance("kills the whole process group", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      const info = yield* create("sleep 30 & sleep 30; wait")
      const killed = yield* shells.kill(info.id)
      expect(killed.status).toBe("killed")
      expect((yield* shells.get(info.id)).status).toBe("killed")
      // Killing again is a no-op on an exited command.
      expect((yield* shells.kill(info.id)).status).toBe("killed")
    }),
  )

  it.instance("stays running while descendants hold the output open, and a kill reaps them", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      // The shell exits at once, but the backgrounded sleep keeps the output pipe open.
      const info = yield* create("sleep 30 & exit 4")
      // Intentional ordering: let the main process exit before killing.
      yield* Effect.sleep("300 millis")
      expect((yield* shells.get(info.id)).status).toBe("running")
      const done = yield* shells.kill(info.id)
      expect(done.status).toBe("killed")
      // The command's own exit code is still reported.
      expect(done.exit).toBe(4)
    }),
  )

  it.instance(
    "settles a timed-out command even when an escaped daemon keeps its output open",
    () =>
      Effect.gen(function* () {
        const shells = yield* ShellProcess.Service
        // The daemon starts its own session, so the process-group kill can't reach it, and it inherits stdout.
        const info = yield* create(`perl -e 'use POSIX; POSIX::setsid(); sleep 8' & echo started`, { timeout: 200 })
        const done = yield* shells.wait(info.id)
        expect(done.status).toBe("timeout")
        expect((yield* shells.output(info.id)).output).toBe("started\n")
      }),
    20_000,
  )

  it.instance("tails the end of output larger than one page", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      const info = yield* create("head -c 2100000 /dev/zero | tr '\\0' a; echo; echo THE-END")
      yield* shells.wait(info.id)
      const tail = yield* shells.tail(info.id, 1_200_000)
      expect(tail.output.endsWith("THE-END\n")).toBe(true)
      expect(tail.truncated).toBe(true)
      expect(tail.cursor).toBe(tail.size)
    }),
  )

  it.instance("reports output as gone once its capture file is removed", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      const info = yield* create("echo gone")
      yield* shells.wait(info.id)
      yield* Effect.promise(() => fs.rm(info.file))
      const exit = yield* shells.output(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("marks commands as backgrounded and publishes updates", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      const bus = yield* Bus.Service
      const events = yield* bus.subscribe(ShellProcess.Event.Updated)
      const info = yield* create("sleep 30")
      const updated = yield* shells.background(info.id)
      expect(updated.background).toBe(true)
      yield* shells.kill(info.id)

      const seen = yield* events.pipe(
        Stream.takeUntil((event) => event.properties.info.status !== "running"),
        Stream.runCollect,
      )
      expect(Array.from(seen).map((event) => [event.properties.info.status, event.properties.info.background])).toEqual(
        [
          ["running", false],
          ["running", true],
          ["killed", true],
        ],
      )
    }),
  )

  it.instance("pages output without splitting multi-byte characters", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      // "é" is two bytes and "€" three, so most cursors land inside a character.
      const info = yield* create("printf 'aé€b'")
      yield* shells.wait(info.id)
      const full = yield* shells.output(info.id)
      expect(full.output).toBe("aé€b")
      expect(full.size).toBe(7)

      const pages: string[] = []
      let cursor = 0
      while (cursor < full.size) {
        const page = yield* shells.output(info.id, { cursor, limit: 2 })
        expect(page.cursor).toBeGreaterThan(cursor)
        pages.push(page.output)
        cursor = page.cursor
      }
      expect(pages.join("")).toBe("aé€b")
      // A cursor inside a character skips its fragment instead of emitting replacement characters.
      expect((yield* shells.output(info.id, { cursor: 2 })).output).toBe("€b")

      const tail = yield* shells.tail(info.id, 4)
      expect(tail.output).toBe("€b")
      expect(tail.truncated).toBe(true)
      expect((yield* shells.tail(info.id, 64)).truncated).toBe(false)
    }),
  )

  it.instance("fails lookups for unknown ids", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      const exit = yield* shells.get(ShellProcess.ID.make("sh_missing")).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
