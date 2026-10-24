import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Latch, Layer } from "effect"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { ShellProcess } from "@/shell/process"
import { Shell } from "@/shell/shell"
import { ShellTool } from "@/tool/shell"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Plugin.defaultLayer,
    Truncate.defaultLayer,
    Config.defaultLayer,
    Agent.defaultLayer,
    RuntimeFlags.defaultLayer,
    ShellProcess.defaultLayer,
    BackgroundJob.defaultLayer,
    Session.defaultLayer,
    SessionStatus.defaultLayer,
    Bus.layer,
  ),
)

function capture() {
  const events: Array<"start" | "firstOutput" | Parameters<NonNullable<Tool.Context["timing"]>["end"]>[0]> = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_shell_timing"),
    messageID: MessageID.make("msg_shell_timing"),
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
    timing: {
      start() {
        events.push("start")
      },
      firstOutput() {
        events.push("firstOutput")
      },
      end(result) {
        events.push(result)
      },
    },
  }
  return { ctx, events }
}

function command(code: string) {
  const shell = Shell.acceptable()
  const quote = Shell.name(shell) === "cmd" ? '"' : "'"
  return `${Shell.ps(shell) ? "& " : ""}"${process.execPath.replaceAll("\\", "/")}" -e ${quote}${code}${quote}`
}

const run = Effect.fnUntraced(function* (params: Tool.InferParameters<typeof ShellTool>, ctx: Tool.Context) {
  const tool = yield* (yield* ShellTool).init()
  return yield* tool.execute(params, ctx)
})

describe("tool.shell timing", () => {
  it.instance("starts after permission and initial metadata, then completes once", () =>
    Effect.gen(function* () {
      const trace = capture()
      const waiting = yield* Latch.make()
      const allow = yield* Latch.make()
      const task = yield* run(
        { command: command("console.log(123)"), description: "Timed success" },
        {
          ...trace.ctx,
          ask: () => waiting.open.pipe(Effect.andThen(allow.await)),
          metadata: (input) =>
            Effect.sync(() => {
              // Only the update published before spawning has no shell ID yet.
              if (input.metadata?.shellID === undefined) expect(trace.events).toEqual([])
            }),
        },
      ).pipe(Effect.forkScoped)
      yield* awaitWithTimeout(waiting.await, "shell never requested permission", "5 seconds")
      expect(trace.events).toEqual([])
      yield* allow.open
      const result = yield* awaitWithTimeout(Fiber.join(task), "shell did not finish")
      expect(result.metadata.exit).toBe(0)
      expect(result.output).toBe("123\n")
      expect(trace.events).toEqual(["start", "firstOutput", { exitCode: 0, status: "completed" }])
    }),
  )

  for (const entry of [
    { name: "empty output", code: "process.exit(0)", output: "(no output)", exitCode: 0, status: "completed" },
    { name: "nonzero exit", code: "process.exit(7)", output: "(no output)", exitCode: 7, status: "error" },
    { name: "stderr output", code: "console.error(456)", output: "456\n", exitCode: 0, status: "completed" },
  ] as const) {
    it.instance(`records ${entry.name}`, () =>
      Effect.gen(function* () {
        const trace = capture()
        const result = yield* run({ command: command(entry.code), description: entry.name }, trace.ctx)
        expect(result.metadata.exit).toBe(entry.exitCode)
        expect(result.output).toBe(entry.output)
        expect(trace.events).toEqual([
          "start",
          ...(entry.output === "(no output)" ? [] : ["firstOutput" as const]),
          { exitCode: entry.exitCode, status: entry.status },
        ])
      }),
    )
  }

  it.instance("records first output only once across stdout and stderr chunks", () =>
    Effect.gen(function* () {
      const trace = capture()
      const result = yield* run(
        {
          command: command("console.log(1);await Bun.sleep(60);console.error(2);await Bun.sleep(60);console.log(3)"),
          description: "Multiple output chunks",
        },
        trace.ctx,
      )
      expect(result.output.trim().split("\n").toSorted()).toEqual(["1", "2", "3"])
      expect(trace.events).toEqual(["start", "firstOutput", { exitCode: 0, status: "completed" }])
    }),
  )

  it.instance("ends only after the command is captured and its final output is published", () =>
    Effect.gen(function* () {
      const trace = capture()
      const shells = yield* ShellProcess.Service
      const draining = yield* Latch.make()
      const drain = yield* Latch.make()
      const task = yield* run(
        { command: command("console.log(123)"), description: "Drain" },
        {
          ...trace.ctx,
          metadata: (input) => (input.metadata?.output ? draining.open.pipe(Effect.andThen(drain.await)) : Effect.void),
        },
      ).pipe(Effect.forkScoped)
      yield* Effect.addFinalizer(() => drain.open.pipe(Effect.asVoid))
      yield* awaitWithTimeout(draining.await, "shell output was not published")
      const shell = yield* pollWithTimeout(
        shells.list().pipe(Effect.map((list) => list[0])),
        "shell process was not registered",
      )
      // The command has exited and been fully captured, but its output is still being published.
      expect((yield* awaitWithTimeout(shells.wait(shell.id), "shell did not exit")).status).toBe("exited")
      expect(trace.events).toEqual(["start", "firstOutput"])
      yield* drain.open
      const result = yield* awaitWithTimeout(Fiber.join(task), "shell did not finish")
      expect(result.output).toBe("123\n")
      expect(trace.events).toEqual(["start", "firstOutput", { exitCode: 0, status: "completed" }])
    }),
  )

  for (const mode of ["timeout", "abort", "interrupt"] as const) {
    it.instance(`ends once on ${mode}`, () =>
      Effect.gen(function* () {
        const trace = capture()
        const ready = yield* Latch.make()
        const controller = new AbortController()
        const task = yield* run(
          {
            command: command("console.log(123);setInterval(()=>{},1000)"),
            description: "Cancel running process",
            timeout: mode === "timeout" ? 500 : 10_000,
          },
          {
            ...trace.ctx,
            abort: controller.signal,
            metadata: (input) => (input.metadata?.output ? ready.open.pipe(Effect.asVoid) : Effect.void),
          },
        ).pipe(Effect.forkScoped)
        yield* awaitWithTimeout(ready.await, "child process did not become ready")
        expect(trace.events).toEqual(["start", "firstOutput"])
        if (mode === "abort") controller.abort()
        if (mode === "interrupt") {
          yield* awaitWithTimeout(Fiber.interrupt(task), "shell fiber did not stop", "5 seconds")
          expect(Exit.isFailure(yield* Fiber.await(task))).toBe(true)
        }
        if (mode !== "interrupt") {
          const result = yield* awaitWithTimeout(Fiber.join(task), "shell process did not stop", "5 seconds")
          expect(result.metadata.exit).toBeNull()
          expect(result.output).toContain(mode === "timeout" ? "exceeding timeout" : "User aborted the command")
        }
        expect(trace.events).toEqual([
          "start",
          "firstOutput",
          {
            exitCode: mode === "interrupt" ? undefined : null,
            status: mode === "timeout" ? "timeout" : "interrupted",
          },
        ])
      }),
    )
  }

  it.instance("ends with an error when spawning fails", () =>
    Effect.gen(function* () {
      const trace = capture()
      const instance = yield* TestInstance
      const exit = yield* run(
        {
          command: command("process.exit(0)"),
          description: "Invalid working directory",
          workdir: path.join(instance.directory, "missing"),
        },
        trace.ctx,
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(trace.events).toEqual(["start", { exitCode: undefined, status: "error" }])
    }),
  )
})
