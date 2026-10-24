import { Deferred, Effect, Fiber, Latch, References, Scope } from "effect"
import os from "os"
import * as Tool from "./tool"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { fileURLToPath } from "url"
import type { TaskPromptOps } from "@/agent/child-session"
import { BackgroundJob } from "@/background/job"
import { BackgroundNotify } from "@/background/notify"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { ServerAuth } from "@/server/auth"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { ShellProcess } from "@/shell/process"
import { Shell } from "@/shell/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Limits, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const BACKGROUND_INSTRUCTION =
  "You will be notified automatically when the command finishes. The notification will include the command's output. Unless the user explicitly asks otherwise, DO NOT poll for completion, even if you need the final result to continue. Repeatedly sleeping and reading or searching the output file is polling, not useful work. You may read the current output if it lets you do useful work now, but do not repeatedly check it while waiting for the command to finish. Keep working on anything that does not depend on the result. If you have nothing else to do, end your response; you will be resumed automatically when the command finishes."
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Capture = {
  text: string
  truncated: boolean
}

type Settled = {
  info: ShellProcess.Info
  text: string
}

// One shape for every result, so clients can read any field without narrowing.
type Metadata = {
  output: string
  description: string
  shellID: string
  truncated: boolean
  exit?: number | null
  outputPath?: string
  background?: boolean
}

export const log = Log.create({ service: "shell-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

function body(output: Capture, file: string) {
  const text = output.text || "(no output)"
  if (!output.truncated) return text
  return `...output truncated...\n\nFull output saved to: ${file}\n\n${text}`
}

function label(info: ShellProcess.Info) {
  return info.pid === undefined ? `shell ID: ${info.id}` : `shell ID: ${info.id}, PID: ${info.pid}`
}

function notice(info: ShellProcess.Info) {
  if (info.status === "killed") return "Killed by the user"
  if (info.status === "timeout") return "Timed out before completion"
  if (info.signal !== undefined) return `Killed by ${info.signal}`
  if (info.exit !== 0) return `Exited with code ${info.exit ?? "unknown"}`
}

function notification(info: ShellProcess.Info, output: Capture) {
  const reason = notice(info)
  return [
    `Background command finished: ${info.description || info.command}`,
    `<shell id="${info.id}" state="${info.status}" command="${info.command}">`,
    body(output, info.file),
    ...(reason ? [reason] : []),
    "</shell>",
  ].join("\n")
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (ctx: Tool.Context, scan: Scan) {
  if (scan.dirs.size > 0) {
    const globs = Array.from(scan.dirs).map((dir) => {
      if (process.platform === "win32") return AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {},
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {},
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
      forceKillAfter: "3 seconds",
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
    forceKillAfter: "3 seconds",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const shells = yield* ShellProcess.Service
    const jobs = yield* BackgroundJob.Service
    const scope = yield* Scope.Scope
    const notify: BackgroundNotify.Deps = {
      sessions: yield* Session.Service,
      status: yield* SessionStatus.Service,
      bus: yield* Bus.Service,
      scope,
    }
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return AppFileSystem.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && AppFileSystem.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return AppFileSystem.normalizePath(path.resolve(root, AppFileSystem.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            log.info("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...ServerAuth.withoutSecrets(process.env),
        ...extra.env,
      }
    })

    // The last `maxLines` lines within `maxBytes` of the capture. Reading twice the byte limit leaves
    // room for the tail to start on a whole line.
    const capture = Effect.fn("ShellTool.capture")(function* (id: ShellProcess.ID, limits: Limits) {
      const page = yield* shells.tail(id, limits.maxBytes * 2).pipe(Effect.orDie)
      const end = tail(page.output, limits.maxLines, limits.maxBytes)
      return { text: end.text, truncated: page.truncated || end.cut }
    })

    // The job and its notifier can outlive the tool call by hours, so both are built out here, where
    // their closures cannot retain the call's context (and with it the whole conversation).
    const settle = Effect.fn("ShellTool.settle")(
      function* (id: ShellProcess.ID, limits: Limits, settled: Deferred.Deferred<Settled>) {
        const done = yield* shells.wait(id)
        yield* Deferred.succeed(settled, { info: done, text: notification(done, yield* capture(id, limits)) })
        // Every command is a job, and finished jobs keep their output for the instance's lifetime.
        return `${notice(done) ?? "Exited with code 0"}. Full output: ${done.file}`
      },
      // Cancelling the job (e.g. deleting its session) must not leave the command running.
      (effect, id) => effect.pipe(Effect.onInterrupt(() => shells.kill(id).pipe(Effect.ignore))),
    )

    const reportOnComplete = Effect.fn("ShellTool.reportOnComplete")(function* (input: {
      id: ShellProcess.ID
      settled: Deferred.Deferred<Settled>
      ops: TaskPromptOps
      sessionID: SessionID
      agent: string
      description: string
    }) {
      // A cancelled command needs no report: whoever cancelled it already knows.
      if ((yield* jobs.wait({ id: input.id })).info?.status !== "completed") return
      const settled = yield* Deferred.await(input.settled)
      const done = settled.info
      const failed = done.status !== "exited" || done.exit !== 0
      // A command stopped on purpose (killed by the user, or signalled as the tool description suggests) is
      // recorded without restarting the agent.
      const stopped = done.status === "killed" || ["SIGTERM", "SIGINT", "SIGKILL", "SIGHUP"].includes(done.signal ?? "")
      yield* BackgroundNotify.deliver(notify, {
        ops: input.ops,
        sessionID: input.sessionID,
        agent: input.agent,
        text: settled.text,
        metadata: {
          source: "shell",
          shellID: done.id,
          command: done.command,
          description: input.description,
          state: done.status,
          ...(done.exit !== undefined ? { exit: done.exit } : {}),
          ...(done.signal !== undefined ? { signal: done.signal } : {}),
        },
        // Its notice waits for the next turn.
        wake: stopped
          ? undefined
            : {
                title: failed ? "Background command failed" : "Background command finished",
                message: `Background command "${input.description}" ${failed ? "failed" : "finished"}. Resuming the main thread.`,
                variant: failed ? "error" : "success",
              },
      })
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        background: boolean
        description: string
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const title = input.description || input.command
      yield* ctx.metadata({ metadata: { output: "", description: input.description } })

      // A bounded tail for the live preview. Results are read from the capture file instead.
      const live = { output: "", received: false }
      const changed = Latch.makeUnsafe(true)
      const listener: ShellProcess.Listener = {
        chunk: (text) => {
          if (!live.received) {
            live.received = true
            ctx.timing?.firstOutput()
          }
          live.output = text.length >= MAX_METADATA_LENGTH ? preview(text) : preview(live.output + text)
          changed.openUnsafe()
        },
      }

      const settled = yield* Deferred.make<Settled>()
      ctx.timing?.start()
      // Spawned and registered together, so an interrupt cannot leave a command without its job.
      const info = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const info = yield* shells.create({
            command: input.command,
            description: input.description,
            cwd: input.cwd,
            shell: input.shell,
            sessionID: ctx.sessionID,
            callID: ctx.callID,
            source: "tool",
            timeout: input.timeout,
            background: input.background,
            spawn: cmd(input.shell, input.command, input.cwd, input.env),
            listener: input.background ? undefined : listener,
          })
          yield* jobs.start({
            id: info.id,
            type: "shell",
            title,
            // Never `sessionId`/`parentSessionId`: the session cancel cascade matches those, and a
            // backgrounded command must survive the user stopping the session.
            metadata: { shellID: info.id, ownerSessionID: ctx.sessionID, command: input.command },
            background: input.background,
            run: settle(info.id, limits, settled),
          })
          return info
        }),
      ).pipe(
        Effect.onError(() => Effect.sync(() => ctx.timing?.end({ status: "error" }))),
        Effect.orDie,
      )

      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      const watch = ops
        ? reportOnComplete({
            id: info.id,
            settled,
            ops,
            sessionID: ctx.sessionID,
            agent: ctx.agent,
            description: title,
          }).pipe(
            Effect.ignore,
            Effect.forkIn(scope, { startImmediately: true }),
            // The caller's stack frames retain this call's arguments; the notifier must not inherit them.
            Effect.provideService(References.CurrentStackFrame, undefined),
            Effect.asVoid,
          )
        : Effect.void

      if (input.background) {
        yield* watch
        ctx.timing?.end({ status: "completed" })
        return {
          title: input.description,
          metadata: {
            output: "",
            description: input.description,
            shellID: info.id,
            truncated: false,
            background: true,
            outputPath: info.file,
          },
          output: [
            `Command started in the background (${label(info)}). Output is streaming to: ${info.file}`,
            BACKGROUND_INSTRUCTION,
          ].join("\n\n"),
        }
      }

      const publish = Effect.suspend(() =>
        ctx.metadata({ metadata: { output: live.output, description: input.description, shellID: info.id } }),
      )
      return yield* Effect.gen(function* () {
        // Publishes the shell ID right away, then coalesces output into at most one update per 50ms.
        const publisher = yield* changed.await.pipe(
          Effect.andThen(changed.close),
          Effect.andThen(publish),
          Effect.andThen(Effect.sleep("50 millis")),
          Effect.forever,
          Effect.forkScoped,
        )
        const outcome = yield* Effect.raceFirst(
          jobs.block({ id: info.id, sessionID: ctx.sessionID }),
          Effect.callback<"aborted">((resume) => {
            if (ctx.abort.aborted) return resume(Effect.succeed("aborted"))
            const handler = () => resume(Effect.succeed("aborted"))
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          }),
        )

        // Ctrl+B can land just as the command finishes; then it reports its real result like any other.
        if (
          outcome !== "aborted" &&
          outcome?.type === "backgrounded" &&
          (yield* shells.get(info.id).pipe(Effect.orDie)).status === "running"
        ) {
          // The race has removed the abort listener. ctx.abort also fires at the end of every step,
          // so a moved command must stop listening to this call before it returns.
          yield* shells.unlisten(info.id, listener)
          yield* Fiber.interrupt(publisher)
          yield* shells.timeout(info.id, 0).pipe(Effect.orDie)
          yield* shells.background(info.id).pipe(Effect.orDie)
          const output = yield* capture(info.id, limits)
          yield* watch
          ctx.timing?.end({ status: "interrupted" })
          return {
            title: input.description,
            metadata: {
              output: live.output,
              description: input.description,
              shellID: info.id,
              truncated: output.truncated,
              background: true,
              outputPath: info.file,
            },
            output: [
              `The user moved this command to the background (${label(info)}). It is still running; output is streaming to: ${info.file}`,
              ...(output.text
                ? [`Output so far:\n${output.truncated ? "...output truncated...\n\n" : ""}${output.text}`]
                : []),
              BACKGROUND_INSTRUCTION,
            ].join("\n\n"),
          }
        }

        const aborted = outcome === "aborted"
        yield* Fiber.interrupt(publisher)
        // A blocked metadata consumer must not delay an abort, so only a finished command gets a final update.
        if (!aborted) yield* publish
        const done = yield* (aborted ? shells.kill(info.id) : shells.wait(info.id)).pipe(Effect.orDie)
        const killed = aborted || done.status === "killed"
        const exit = killed || done.status !== "exited" ? null : (done.exit ?? null)
        const output = yield* capture(info.id, limits)
        const meta = [
          ...(done.status === "timeout"
            ? [
                `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
              ]
            : []),
          ...(killed ? ["User aborted the command"] : []),
        ]
        const text =
          body(output, done.file) +
          (meta.length > 0 ? `\n\n<shell_metadata>\n${meta.join("\n")}\n</shell_metadata>` : "")
        ctx.timing?.end({
          exitCode: exit,
          status: done.status === "timeout" ? "timeout" : killed ? "interrupted" : exit === 0 ? "completed" : "error",
        })
        return {
          title: input.description,
          metadata: {
            output: live.output || preview(text),
            exit,
            description: input.description,
            truncated: output.truncated,
            ...(output.truncated ? { outputPath: done.file } : {}),
            shellID: info.id,
          },
          output: text,
        }
      }).pipe(
        // Interrupting the call stops its command; a step abort is handled above and returns the output.
        Effect.onInterrupt(() =>
          jobs.cancel(info.id).pipe(Effect.andThen(Effect.sync(() => ctx.timing?.end({ status: "interrupted" })))),
        ),
        Effect.scoped,
        Effect.ensuring(shells.unlisten(info.id, listener)),
      )
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs)
        log.info("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const background = params.background === true
              // Background commands run until they finish unless the caller asks for a timeout.
              const timeout = params.timeout ?? (background ? 0 : defaultTimeoutMs)
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan)
                }),
              )

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                  background,
                  description: params.description,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
