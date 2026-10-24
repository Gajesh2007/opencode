import fs from "node:fs"
import path from "node:path"
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  References,
  Schema,
  Scope,
  Stream,
  Types,
} from "effect"
import type { PlatformError } from "effect/PlatformError"
import type { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { NonNegativeInt, withStatics } from "@opencode-ai/core/schema"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { Identifier } from "@/id/id"
import { SessionID } from "@/session/schema"
import { ToolID } from "@/tool/schema"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"

// Recently exited commands stay readable (status + output) for clients such as the TUI.
const EXITED_LIMIT = 50
const DEFAULT_PAGE = 64 * 1024
const MAX_PAGE = 1024 * 1024

const idSchema = Schema.String.check(Schema.isStartsWith("sh_")).pipe(Schema.brand("ShellProcessID"))

export type ID = typeof idSchema.Type

export const ID = idSchema.pipe(
  withStatics((schema: typeof idSchema) => ({
    ascending: (id?: string) => schema.make(Identifier.ascending("shell", id)),
  })),
)

export const Status = Schema.Literals(["running", "exited", "timeout", "killed"])
export type Status = typeof Status.Type

export const Info = Schema.Struct({
  id: ID,
  sessionID: Schema.optional(SessionID),
  callID: Schema.optional(Schema.String),
  source: Schema.Literals(["tool", "user"]),
  command: Schema.String,
  description: Schema.optional(Schema.String),
  cwd: Schema.String,
  shell: Schema.String,
  // Combined stdout/stderr capture. Lives in the truncation directory, so it is pruned by the
  // truncation sweep and agents can read it without an external-directory prompt.
  file: Schema.String,
  pid: Schema.optional(NonNegativeInt),
  status: Status,
  exit: Schema.optional(Schema.Int),
  signal: Schema.optional(Schema.String),
  background: Schema.Boolean,
  time: Schema.Struct({
    started: NonNegativeInt,
    completed: Schema.optional(NonNegativeInt),
  }),
}).annotate({ identifier: "ShellProcess" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const Output = Schema.Struct({
  output: Schema.String,
  // Byte offset after this page. Equals `size` once the reader has caught up.
  cursor: NonNegativeInt,
  // Bytes captured so far.
  size: NonNegativeInt,
}).annotate({ identifier: "ShellProcessOutput" })
export type Output = Schema.Schema.Type<typeof Output>

export const Event = {
  Updated: BusEvent.define("shell.updated", Schema.Struct({ info: Info })),
  Deleted: BusEvent.define("shell.deleted", Schema.Struct({ id: ID, sessionID: Schema.optional(SessionID) })),
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("ShellProcess.NotFoundError", {
  id: ID,
}) {}

/** Receives decoded output synchronously as it is captured. */
export type Listener = {
  readonly chunk: (text: string) => void
  readonly end?: () => void
}

export type CreateInput = {
  /** The command as the user or model wrote it; `spawn` is what actually runs. */
  command: string
  description?: string
  cwd: string
  shell: string
  sessionID?: SessionID
  callID?: string
  source: "tool" | "user"
  /** Milliseconds before the command is killed. Omitted or 0 means no timeout. */
  timeout?: number
  background?: boolean
  spawn: ChildProcess.Command
  /** Registered before any output is read, so no early chunk is missed. */
  listener?: Listener
}

export interface Interface {
  /** Spawns a command owned by the instance, not the caller: it keeps running after the caller returns. */
  readonly create: (input: CreateInput) => Effect.Effect<Info, PlatformError>
  /** Running and recently exited commands, oldest first. */
  readonly list: (input?: { sessionID?: SessionID }) => Effect.Effect<Info[]>
  readonly get: (id: ID) => Effect.Effect<Info, NotFoundError>
  /** Resolves with the terminal info once the command has exited and its output is fully captured. */
  readonly wait: (id: ID) => Effect.Effect<Info, NotFoundError>
  readonly output: (id: ID, input?: { cursor?: number; limit?: number }) => Effect.Effect<Output, NotFoundError>
  /** The last `bytes` of captured output, starting on a character boundary. */
  readonly tail: (id: ID, bytes: number) => Effect.Effect<Output & { truncated: boolean }, NotFoundError>
  readonly unlisten: (id: ID, listener: Listener) => Effect.Effect<void>
  /** Replaces the running command's timeout, counted from now. Zero clears it. */
  readonly timeout: (id: ID, ms: number) => Effect.Effect<Info, NotFoundError>
  readonly background: (id: ID) => Effect.Effect<Info, NotFoundError>
  /** Kills the command's process group and resolves once it has exited. */
  readonly kill: (id: ID) => Effect.Effect<Info, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShellProcess") {}

type Active = {
  info: Info
  size: number
  done: Deferred.Deferred<Info>
  listeners: Set<Listener>
  reason?: "killed" | "timeout"
  // Present only while the command is unsettled.
  terminate?: (reason: "killed" | "timeout") => Effect.Effect<void>
  timer?: Fiber.Fiber<void>
  // Bumped by every re-arm, so a superseded timer that still fires does nothing.
  generation: number
}

type State = {
  scope: Scope.Scope
  shells: Map<ID, Active>
  exited: ID[]
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const spawner = yield* ChildProcessSpawner

    const state = yield* InstanceState.make<State>(
      Effect.fn("ShellProcess.state")(function* () {
        const s: State = { scope: yield* Scope.Scope, shells: new Map(), exited: [] }
        // Closing the scope interrupts each owner fiber, whose spawn scope kills the process group.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const active of s.shells.values()) {
              active.listeners.clear()
              yield* Deferred.interrupt(active.done)
            }
            s.shells.clear()
            s.exited.length = 0
          }),
        )
        return s
      }),
    )

    const require = Effect.fnUntraced(function* (id: ID) {
      const active = (yield* InstanceState.get(state)).shells.get(id)
      if (!active) return yield* new NotFoundError({ id })
      return active
    })

    const publish = (active: Active) => bus.publish(Event.Updated, { info: snapshot(active.info) })

    const arm = Effect.fnUntraced(function* (s: State, active: Active, ms: number) {
      const generation = ++active.generation
      const previous = active.timer
      active.timer = undefined
      if (previous) yield* Fiber.interrupt(previous)
      if (ms <= 0 || !active.terminate) return
      const timer = yield* Effect.sleep(Duration.millis(ms)).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            generation === active.generation ? (active.terminate?.("timeout") ?? Effect.void) : Effect.void,
          ),
        ),
        Effect.forkIn(s.scope),
        detach,
      )
      if (generation === active.generation) active.timer = timer
      else yield* Fiber.interrupt(timer)
    })

    const create = Effect.fn("ShellProcess.create")(function* (input: CreateInput) {
      const s = yield* InstanceState.get(state)
      const id = ID.ascending()
      const file = path.join(TRUNCATION_DIR, ToolID.ascending())
      const ready = yield* Deferred.make<Active, PlatformError>()
      const done = yield* Deferred.make<Info>()
      // The owner fiber below must not capture `input`: it can outlive the caller by hours, and the
      // listener is dropped from this set (and becomes collectable) once the caller stops listening.
      const spawn = input.spawn
      const timeoutMs = input.timeout ?? 0
      const listeners = new Set(input.listener ? [input.listener] : [])
      const info: Info = {
        id,
        ...(input.sessionID ? { sessionID: input.sessionID } : {}),
        ...(input.callID ? { callID: input.callID } : {}),
        source: input.source,
        command: input.command,
        ...(input.description ? { description: input.description } : {}),
        cwd: input.cwd,
        shell: input.shell,
        file,
        status: "running",
        background: input.background === true,
        time: { started: Date.now() },
      }

      const owner = yield* Effect.scoped(
        Effect.gen(function* () {
          const fd = yield* Effect.acquireRelease(
            Effect.sync(() => {
              fs.mkdirSync(TRUNCATION_DIR, { recursive: true })
              return fs.openSync(file, "w", 0o600)
            }),
            (fd) => Effect.sync(() => fs.closeSync(fd)),
          )
          const handle = yield* spawner.spawn(spawn)
          const decoder = new TextDecoder()
          const active: Active = {
            info: { ...info, pid: handle.pid },
            size: 0,
            done,
            listeners,
            generation: 0,
          }

          const pump = yield* handle.all.pipe(
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                fs.writeSync(fd, chunk)
                active.size += chunk.byteLength
                if (active.listeners.size === 0) return
                const text = decoder.decode(chunk, { stream: true })
                if (text) active.listeners.forEach((listener) => listener.chunk(text))
              }),
            ),
            // A failed capture must not keep the command from settling.
            Effect.exit,
            // Attach the readers before this fiber yields: on exit, Node/Bun resume any stdio stream
            // that has no reader yet and discard its data, which loses a fast command's output.
            Effect.forkScoped({ startImmediately: true }),
          )
          // A started kill always runs to completion: retiming or teardown must not cancel it midway.
          // Descendants that moved to their own session or process group escape the kill and can hold the
          // output pipe open forever, which keeps the command from settling. Once the force-kill grace period
          // has passed, stop reading: closing our end of the pipe lets the command settle.
          active.terminate = (reason) =>
            Effect.suspend(() => {
              active.reason ??= reason
              return Effect.all(
                [
                  handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.ignore),
                  Effect.sleep("4 seconds").pipe(Effect.andThen(Fiber.interrupt(pump))),
                ],
                { concurrency: "unbounded", discard: true },
              ).pipe(Effect.forkIn(s.scope), detach, Effect.asVoid)
            })
          s.shells.set(id, active)
          yield* arm(s, active, timeoutMs)
          yield* publish(active)
          yield* Deferred.succeed(ready, active)

          // Resolves once the process has exited and every holder of its output pipe has closed it.
          const exit = yield* Effect.exit(handle.exitCode)
          // Report the exit only once the capture is complete, so readers never see a partial file. The pump may
          // have been stopped on purpose (see `terminate`), so observe its end without inheriting it.
          yield* Fiber.await(pump)
          const tail = decoder.decode()
          active.listeners.forEach((listener) => {
            if (tail) listener.chunk(tail)
            listener.end?.()
          })
          active.listeners.clear()
          active.terminate = undefined
          if (active.timer) yield* Fiber.interrupt(active.timer)
          active.timer = undefined
          active.info = {
            ...active.info,
            status: active.reason ?? "exited",
            ...(Exit.isSuccess(exit) ? { exit: exit.value } : signal(exit.cause)),
            time: { ...active.info.time, completed: Date.now() },
          }
          yield* Deferred.succeed(active.done, snapshot(active.info))
          yield* publish(active)

          s.exited.push(id)
          while (s.exited.length > EXITED_LIMIT) {
            const oldest = s.exited.shift()
            const evicted = oldest ? s.shells.get(oldest) : undefined
            if (!oldest || !evicted) continue
            s.shells.delete(oldest)
            yield* bus.publish(Event.Deleted, { id: oldest, sessionID: evicted.info.sessionID })
          }
        }),
      ).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Deferred.failCause(ready, exit.cause).pipe(Effect.andThen(Deferred.interrupt(done)))
            : Effect.void,
        ),
        Effect.forkIn(s.scope),
        detach,
      )

      // Forking into a scope that is closing (instance disposal) can interrupt the owner before it runs its
      // exit handler; never wait on `ready` past the owner's end.
      const started = yield* Effect.raceFirst(
        Deferred.await(ready),
        Fiber.await(owner).pipe(
          Effect.flatMap((exit) => (Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Deferred.await(ready))),
        ),
      )
      return snapshot(started.info)
    })

    const list = Effect.fn("ShellProcess.list")(function* (input?: { sessionID?: SessionID }) {
      const s = yield* InstanceState.get(state)
      return Array.from(s.shells.values())
        .filter((active) => !input?.sessionID || active.info.sessionID === input.sessionID)
        .map((active) => snapshot(active.info))
        .toSorted((a, b) => a.time.started - b.time.started)
    })

    const get = Effect.fn("ShellProcess.get")(function* (id: ID) {
      return snapshot((yield* require(id)).info)
    })

    const wait = Effect.fn("ShellProcess.wait")(function* (id: ID) {
      return yield* Deferred.await((yield* require(id)).done)
    })

    const output = Effect.fn("ShellProcess.output")(function* (id: ID, input?: { cursor?: number; limit?: number }) {
      const active = yield* require(id)
      const size = active.size
      const start = clamp(input?.cursor ?? 0, 0, size)
      const limit = clamp(input?.limit ?? DEFAULT_PAGE, 1, MAX_PAGE)
      if (start >= size) return { output: "", cursor: size, size }
      // Read up to 3 bytes past the limit so a character straddling it can still be completed.
      const bytes = yield* Effect.promise(() =>
        readRange(active.info.file, start, Math.min(limit + 3, size - start)),
      )
      // The capture was removed (the truncation sweep prunes week-old files): its output is gone for good.
      if (bytes === undefined) return yield* new NotFoundError({ id })
      const range = characters(bytes, limit, active.info.status !== "running")
      return {
        output: new TextDecoder().decode(bytes.subarray(range.start, range.end)),
        cursor: start + range.end,
        size,
      }
    })

    const tail = Effect.fn("ShellProcess.tail")(function* (id: ID, bytes: number) {
      const size = (yield* require(id)).size
      // One page at most, so the tail always ends at the end of the output.
      const take = Math.min(bytes, MAX_PAGE)
      const page = yield* output(id, { cursor: Math.max(0, size - take), limit: take })
      return { ...page, truncated: size > take }
    })

    const unlisten = Effect.fn("ShellProcess.unlisten")(function* (id: ID, listener: Listener) {
      const active = (yield* InstanceState.get(state)).shells.get(id)
      active?.listeners.delete(listener)
    })

    const timeout = Effect.fn("ShellProcess.timeout")(function* (id: ID, ms: number) {
      const active = yield* require(id)
      yield* arm(yield* InstanceState.get(state), active, ms)
      return snapshot(active.info)
    })

    const background = Effect.fn("ShellProcess.background")(function* (id: ID) {
      const active = yield* require(id)
      if (active.info.background) return snapshot(active.info)
      active.info = { ...active.info, background: true }
      yield* publish(active)
      return snapshot(active.info)
    })

    const kill = Effect.fn("ShellProcess.kill")(function* (id: ID) {
      const active = yield* require(id)
      if (active.terminate) yield* active.terminate("killed")
      // SIGKILL follows after 3 seconds and the output pipe is released after 4; don't hang a caller on a
      // process that still won't settle.
      const settled = yield* Deferred.await(active.done).pipe(Effect.timeoutOption("6 seconds"))
      return settled._tag === "Some" ? settled.value : snapshot(active.info)
    })

    return Service.of({ create, list, get, wait, output, tail, unlisten, timeout, background, kill })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer), Layer.provide(CrossSpawnSpawner.defaultLayer))

function snapshot(info: Info): Info {
  return { ...info, time: { ...info.time } }
}

// Work forked into the instance scope can outlive the caller by hours. Drop the caller's lazy
// stack frames, which can retain its arguments (for tools, the whole conversation).
function detach<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.provideService(References.CurrentStackFrame, undefined))
}

function signal(cause: Cause.Cause<unknown>) {
  const match = /signal: '([A-Z0-9]+)'/.exec(Cause.pretty(cause))
  return match ? { signal: match[1] } : {}
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

// Undefined when the capture file can't be read.
function readRange(file: string, start: number, length: number) {
  return fs.promises
    .open(file, "r")
    .then((handle) =>
      handle
        .read(Buffer.alloc(length), 0, length, start)
        .then((result) => result.buffer.subarray(0, result.bytesRead))
        .finally(() => handle.close()),
    )
    .catch(() => undefined)
}

// Picks the whole UTF-8 characters of a page. A leading fragment belongs to the previous page and
// is skipped. Characters are taken up to `limit` bytes, but always at least one, so a reader with a
// tiny limit still advances. An incomplete trailing character waits for more output, unless the
// command has exited and no more is coming (then it is emitted as-is so readers reach the end).
function characters(bytes: Uint8Array, limit: number, final: boolean) {
  const continuation = (byte: number) => (byte & 0xc0) === 0x80
  const width = (byte: number) => (byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1)
  let start = 0
  while (start < bytes.length && continuation(bytes[start])) start++
  let end = start
  while (end < bytes.length) {
    const next = end + width(bytes[end])
    if (next > bytes.length || (next > limit && end > start)) break
    end = next
  }
  if (final && end === start) return { start, end: bytes.length }
  return { start, end }
}

export * as ShellProcess from "./process"
