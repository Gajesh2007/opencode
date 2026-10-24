import { describe, expect } from "bun:test"
import path from "path"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "@/agent/agent"
import type { TaskPromptOps } from "@/agent/child-session"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { ModelID, ProviderID } from "@/provider/schema"
import type { MessageV2 } from "@/session/message-v2"
import type { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { ShellProcess } from "@/shell/process"
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
    SessionRunState.defaultLayer,
    Bus.layer,
  ),
)

const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }
const instruction = "You will be notified automatically when the command finishes."
// Holds until the test creates `release` in the instance directory, so output and exit happen on cue.
const gated = (rest: string) => `while [ ! -f release ]; do sleep 0.05; done; ${rest}`

const seed = Effect.fn("ShellBackgroundTest.seed")(function* () {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Background shells" })
  yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  return chat
})

// Records notices the way the real `noReply` prompt does, so a woken session sees the notice as its
// latest user message, and counts resumed loops.
const recorder = Effect.fn("ShellBackgroundTest.recorder")(function* () {
  const sessions = yield* Session.Service
  const prompts: SessionPrompt.PromptInput[] = []
  const loops: SessionID[] = []
  const ops: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.gen(function* () {
        prompts.push(input)
        const info = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          agent: input.agent ?? "build",
          model: input.model ?? ref,
          time: { created: Date.now() },
        })
        return { info, parts: [] }
      }),
    loop: (input) =>
      Effect.sync(() => {
        loops.push(input.sessionID)
        return reply(input.sessionID)
      }),
  }
  return { ops, prompts, loops }
})

function reply(sessionID: SessionID): MessageV2.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [],
  }
}

function context(sessionID: SessionID, ops?: TaskPromptOps, abort = new AbortController().signal): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    callID: "call_shell",
    agent: "build",
    abort,
    messages: [],
    extra: ops ? { promptOps: ops } : undefined,
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

const run = Effect.fn("ShellBackgroundTest.run")(function* (
  params: Tool.InferParameters<typeof ShellTool>,
  ctx: Tool.Context,
) {
  const tool = yield* (yield* ShellTool).init()
  return yield* tool.execute(params, ctx)
})

// Ctrl+B: keep moving until the tool has blocked the session on its command.
const backgroundWhenBlocked = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    return yield* pollWithTimeout(
      jobs.backgroundAll({ sessionID }).pipe(Effect.map((moved) => (moved.length > 0 ? moved : undefined))),
      "the command never blocked the session",
    )
  })

const release = Effect.fn("ShellBackgroundTest.release")(function* () {
  const test = yield* TestInstance
  yield* Effect.promise(() => Bun.write(path.join(test.directory, "release"), ""))
})

describe.skipIf(process.platform === "win32")("tool.shell background", () => {
  it.instance("starts a background command, returns at once, and reports its result when it exits", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      const jobs = yield* BackgroundJob.Service
      const chat = yield* seed()
      const notices = yield* recorder()
      const command = gated("echo hi; exit 7")

      const result = yield* run(
        { command, description: "Wait then fail", background: true },
        context(chat.id, notices.ops),
      )
      const shellID = ShellProcess.ID.make(result.metadata.shellID)
      const info = yield* shells.get(shellID)
      expect(info).toMatchObject({ status: "running", background: true, source: "tool", sessionID: chat.id })
      expect(result.metadata).toEqual({
        output: "",
        description: "Wait then fail",
        shellID,
        truncated: false,
        background: true,
        outputPath: info.file,
      })
      expect(result.output).toStartWith(
        `Command started in the background (shell ID: ${shellID}, PID: ${info.pid}). Output is streaming to: ${info.file}\n\n${instruction}`,
      )
      const job = yield* jobs.get(shellID)
      expect(job).toMatchObject({ type: "shell", status: "running", background: true, title: "Wait then fail" })
      // No sessionId/parentSessionId: the session cancel cascade must not reach background commands.
      expect(job?.metadata).toEqual({ shellID, ownerSessionID: chat.id, command })

      yield* release()
      // The job's own output stays a one-line summary; the notice carries the command's output.
      expect((yield* jobs.wait({ id: shellID, timeout: 5_000 })).info).toMatchObject({
        status: "completed",
        output: `Exited with code 7. Full output: ${info.file}`,
      })
      const notice = yield* pollWithTimeout(
        Effect.sync(() => notices.prompts[0]),
        "no completion notice",
      )
      expect(notice).toMatchObject({ sessionID: chat.id, noReply: true, agent: "build" })
      expect(notice.parts).toEqual([
        {
          type: "text",
          synthetic: true,
          text: `Background command finished: Wait then fail\n<shell id="${shellID}" state="exited" command="${command}">\nhi\n\nExited with code 7\n</shell>`,
          metadata: {
            source: "shell",
            shellID,
            command,
            description: "Wait then fail",
            state: "exited",
            exit: 7,
          },
        },
      ])
      // The idle session is resumed to handle the result.
      yield* pollWithTimeout(
        Effect.sync(() => (notices.loops.length > 0 ? true : undefined)),
        "the session was not resumed",
      )
      expect(notices.loops).toEqual([chat.id])
    }),
  )

  it.instance("Ctrl+B moves a running foreground command to the background without its timeout", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      const jobs = yield* BackgroundJob.Service
      const chat = yield* seed()
      const notices = yield* recorder()
      const command = "echo started; sleep 1.2; echo finished"

      const call = yield* run({ command, description: "Slow build", timeout: 500 }, context(chat.id, notices.ops)).pipe(
        Effect.forkScoped,
      )
      const moved = yield* backgroundWhenBlocked(chat.id)
      const result = yield* awaitWithTimeout(Fiber.join(call), "the call did not return after Ctrl+B")
      const shellID = ShellProcess.ID.make(result.metadata.shellID)
      expect(moved).toMatchObject([{ id: shellID, type: "shell", background: true }])
      expect((yield* jobs.get(shellID))?.background).toBe(true)

      const info = yield* shells.get(shellID)
      expect(info).toMatchObject({ status: "running", background: true })
      expect(result.metadata).toMatchObject({
        description: "Slow build",
        shellID,
        background: true,
        outputPath: info.file,
      })
      expect(result.output).toStartWith(
        `The user moved this command to the background (shell ID: ${shellID}, PID: ${info.pid}). It is still running; output is streaming to: ${info.file}\n\n`,
      )
      expect(result.output).toEndWith(
        "If you have nothing else to do, end your response; you will be resumed automatically when the command finishes.",
      )

      // The command outlives the 500ms foreground timeout it was started with.
      const done = yield* awaitWithTimeout(shells.wait(shellID), "the moved command did not finish", "5 seconds")
      expect(done).toMatchObject({ status: "exited", exit: 0 })
      const notice = yield* pollWithTimeout(
        Effect.sync(() => notices.prompts[0]),
        "no completion notice",
      )
      expect(notice.parts).toEqual([
        {
          type: "text",
          synthetic: true,
          text: `Background command finished: Slow build\n<shell id="${shellID}" state="exited" command="${command}">\nstarted\nfinished\n\n</shell>`,
          metadata: { source: "shell", shellID, command, description: "Slow build", state: "exited", exit: 0 },
        },
      ])
    }),
  )

  it.instance("shows the output so far when a command is moved", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      const chat = yield* seed()
      const printed = yield* Deferred.make<void>()

      const call = yield* run(
        { command: `echo ready; ${gated("echo done")}`, description: "Print then wait" },
        {
          ...context(chat.id),
          metadata: (input) =>
            String(input.metadata?.output ?? "").includes("ready")
              ? Deferred.succeed(printed, undefined).pipe(Effect.asVoid)
              : Effect.void,
        },
      ).pipe(Effect.forkScoped)
      yield* awaitWithTimeout(Deferred.await(printed), "the command never printed")
      yield* backgroundWhenBlocked(chat.id)
      const result = yield* awaitWithTimeout(Fiber.join(call), "the call did not return after Ctrl+B")
      expect(result.metadata.output).toBe("ready\n")
      expect(result.output).toContain(`\n\nOutput so far:\nready\n\n\n${instruction}`)

      yield* release()
      const done = yield* awaitWithTimeout(
        shells.wait(ShellProcess.ID.make(result.metadata.shellID)),
        "the moved command did not finish",
        "5 seconds",
      )
      expect(done).toMatchObject({ status: "exited", exit: 0 })
    }),
  )

  it.instance("a moved command survives the abort of the call that started it", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      const chat = yield* seed()
      const notices = yield* recorder()
      const controller = new AbortController()

      const call = yield* run(
        { command: gated("echo released"), description: "Wait for release" },
        context(chat.id, notices.ops, controller.signal),
      ).pipe(Effect.forkScoped)
      yield* backgroundWhenBlocked(chat.id)
      const result = yield* awaitWithTimeout(Fiber.join(call), "the call did not return after Ctrl+B")
      const shellID = ShellProcess.ID.make(result.metadata.shellID)

      // Every step ends by aborting its signal; that must not reach a command that was moved away.
      controller.abort()
      yield* release()
      const done = yield* awaitWithTimeout(shells.wait(shellID), "the moved command did not finish", "5 seconds")
      expect(done).toMatchObject({ status: "exited", exit: 0 })
      const notice = yield* pollWithTimeout(
        Effect.sync(() => notices.prompts[0]),
        "no completion notice",
      )
      expect(notice.parts).toMatchObject([{ metadata: { shellID, state: "exited", exit: 0 } }])
    }),
  )

  it.instance("aborting a foreground command kills it and returns its partial output", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      const jobs = yield* BackgroundJob.Service
      const chat = yield* seed()
      const notices = yield* recorder()
      const controller = new AbortController()

      const result = yield* run(
        { command: "echo before; sleep 30", description: "Long command" },
        {
          ...context(chat.id, notices.ops, controller.signal),
          metadata: (input) =>
            Effect.sync(() => {
              if (String(input.metadata?.output ?? "").includes("before")) controller.abort()
            }),
        },
      )
      const shellID = ShellProcess.ID.make(result.metadata.shellID)
      expect(result.output).toBe("before\n\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>")
      expect(result.metadata).toMatchObject({ exit: null, truncated: false, description: "Long command" })
      expect((yield* shells.get(shellID)).status).toBe("killed")
      expect((yield* jobs.wait({ id: shellID, timeout: 5_000 })).info?.status).toBe("completed")
      // The call itself reported the outcome, so there is nothing to notify.
      expect(notices.prompts).toEqual([])
    }),
  )

  it.instance("a foreground timeout kills the command and reports it", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      const chat = yield* seed()

      const result = yield* run(
        { command: "echo started; sleep 30", description: "Hangs", timeout: 300 },
        context(chat.id),
      )
      expect((yield* shells.get(ShellProcess.ID.make(result.metadata.shellID))).status).toBe("timeout")
      expect(result.metadata.exit).toBeNull()
      expect(result.output).toStartWith("started\n")
      expect(result.output).toContain("<shell_metadata>\nshell tool terminated command after exceeding timeout 300 ms.")
    }),
  )

  it.instance("a command the user killed is reported without waking the session", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      const bus = yield* Bus.Service
      const chat = yield* seed()
      const notices = yield* recorder()
      const toasts: string[] = []
      yield* (yield* bus.subscribe(TuiEvent.ToastShow)).pipe(
        Stream.runForEach((event) => Effect.sync(() => toasts.push(event.properties.message))),
        Effect.forkScoped,
      )

      const killed = yield* run(
        { command: "sleep 30", description: "Idle server", background: true },
        context(chat.id, notices.ops),
      )
      const killedID = ShellProcess.ID.make(killed.metadata.shellID)
      yield* shells.kill(killedID)
      const notice = yield* pollWithTimeout(
        Effect.sync(() => notices.prompts[0]),
        "no notice for the killed command",
      )
      expect(notice.parts).toEqual([
        {
          type: "text",
          synthetic: true,
          text: `Background command finished: Idle server\n<shell id="${killedID}" state="killed" command="sleep 30">\n(no output)\nKilled by the user\n</shell>`,
          metadata: {
            source: "shell",
            shellID: killedID,
            command: "sleep 30",
            description: "Idle server",
            state: "killed",
            signal: "SIGTERM",
          },
        },
      ])

      // A command that exits on its own does wake the session, and it is the only one that did.
      yield* run({ command: "echo ok", description: "Quick check", background: true }, context(chat.id, notices.ops))
      yield* pollWithTimeout(
        Effect.sync(() => (notices.loops.length > 0 && toasts.length > 0 ? true : undefined)),
        "the session was not resumed",
      )
      expect(notices.prompts).toHaveLength(2)
      expect(notices.loops).toEqual([chat.id])
      expect(toasts).toEqual(['Background command "Quick check" finished. Resuming the main thread.'])
    }),
  )

  it.instance("stopping the session leaves background commands running", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const chat = yield* seed()

      const result = yield* run({ command: "sleep 30", description: "Dev server", background: true }, context(chat.id))
      const shellID = ShellProcess.ID.make(result.metadata.shellID)
      yield* runState.cancel(chat.id)
      expect((yield* shells.get(shellID)).status).toBe("running")
      expect((yield* jobs.get(shellID))?.status).toBe("running")
      yield* shells.kill(shellID)
    }),
  )

  it.instance("cancelling a background command's job kills it", () =>
    Effect.gen(function* () {
      const shells = yield* ShellProcess.Service
      const jobs = yield* BackgroundJob.Service
      const chat = yield* seed()

      const result = yield* run({ command: "sleep 30", description: "Dev server", background: true }, context(chat.id))
      const shellID = ShellProcess.ID.make(result.metadata.shellID)
      expect((yield* jobs.cancel(shellID))?.status).toBe("cancelled")
      expect((yield* shells.get(shellID)).status).toBe("killed")
    }),
  )
})
