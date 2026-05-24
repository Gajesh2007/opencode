import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { SessionStatus } from "@/session/status"
import { Config } from "@/config/config"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { Cause, Deferred, Effect, Option, Schema, Scope, Stream } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Global } from "@opencode-ai/core/global"
import { spawnSync } from "node:child_process"
import * as nodePath from "node:path"
import * as nodeFs from "node:fs"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
  loop(input: SessionPrompt.LoopInput): Effect.Effect<MessageV2.WithParts>
}

const id = "task"
const EXTRA_DESCRIPTION = [
  "",
  "",
  [
    "Background mode: pass background=true to launch the subagent asynchronously and",
    "return immediately. Use task_status(task_id=..., wait=false) to poll, or wait=true",
    "to block until done. The result is also auto-injected into this session as a new",
    "synthetic user message when the background task finishes, so you do NOT need to",
    "poll if you're happy to receive it whenever it lands.",
    "",
    "Worktree mode: pass worktree=true to run the subagent inside a fresh git worktree",
    "branched off the current HEAD. Use this when the subagent's edits could conflict",
    "with your in-progress work — research/refactor/build agents are good candidates.",
    "The worktree directory is reported in the task output; you can leave it alone or",
    "clean it up later. Combine with background=true for fully parallel side-tasks.",
  ].join(" "),
].join("\n")

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  background: Schema.optional(Schema.Boolean).annotate({
    description: "When true, launch the subagent in the background and return immediately",
  }),
  worktree: Schema.optional(Schema.Boolean).annotate({
    description:
      "When true, run the subagent inside a fresh git worktree branched off the current HEAD so its file edits don't conflict with the main session's work. Only valid for git-tracked projects.",
  }),
})

function output(sessionID: SessionID, text: string) {
  return [
    `task_id: ${sessionID} (for resuming to continue this task if needed)`,
    "",
    "<task_result>",
    text,
    "</task_result>",
  ].join("\n")
}

function backgroundOutput(sessionID: SessionID, worktreeDir?: string) {
  const worktreeLine = worktreeDir ? `worktree: ${worktreeDir}\n` : ""
  return [
    `task_id: ${sessionID} (for polling this task with task_status)`,
    "state: running",
    worktreeLine + "",
    "<task_result>",
    "Background task started. Continue your current work and call task_status when you need the result, or wait for the auto-injected completion message.",
    "</task_result>",
  ].join("\n")
}

function syncOutput(sessionID: SessionID, text: string, worktreeDir?: string) {
  const worktreeLine = worktreeDir ? `\nworktree: ${worktreeDir}` : ""
  return [
    `task_id: ${sessionID} (for resuming to continue this task if needed)${worktreeLine}`,
    "",
    "<task_result>",
    text,
    "</task_result>",
  ].join("\n")
}

function backgroundMessage(input: {
  sessionID: SessionID
  description: string
  state: "completed" | "error"
  text: string
}) {
  const tag = input.state === "completed" ? "task_result" : "task_error"
  const title =
    input.state === "completed"
      ? `Background task completed: ${input.description}`
      : `Background task failed: ${input.description}`
  return [title, `task_id: ${input.sessionID}`, `state: ${input.state}`, "", `<${tag}>`, input.text, `</${tag}>`].join(
    "\n",
  )
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function slugify(input: string) {
  return (
    input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "subagent"
  )
}

function gitToplevel(cwd: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" })
  if (result.status !== 0) return undefined
  return result.stdout.trim() || undefined
}

/**
 * Create a fresh git worktree branched off the parent session's HEAD,
 * intended to host a subagent's isolated edits. Returns the new directory
 * and branch name. Picks a unique directory under opencode's data dir so
 * subagent worktrees stay segregated from any user-managed ones.
 *
 * Direct git invocation (sync) instead of going through Worktree.Service so
 * the TaskTool's layer doesn't pull in the InstanceLayer + Project + Bus
 * fan-out that the full Worktree service requires — that fan-out turned out
 * to cascade into every test that uses ToolRegistry.
 */
function createSubagentWorktree(parentDirectory: string, description: string): { directory: string; branch: string } {
  const top = gitToplevel(parentDirectory)
  if (!top) {
    throw new Error("worktree=true requires a git-tracked project; the parent session's directory is not a git repo")
  }

  const root = nodePath.join(Global.Path.data, "worktree-subagent")
  nodeFs.mkdirSync(root, { recursive: true })

  const slug = slugify(description)
  let name = slug
  let candidate = nodePath.join(root, name)
  let n = 1
  while (nodeFs.existsSync(candidate)) {
    n += 1
    name = `${slug}-${n}`
    candidate = nodePath.join(root, name)
    if (n > 100) throw new Error("could not allocate a unique worktree directory")
  }
  const branch = `opencode-subagent/${name}`

  const created = spawnSync("git", ["worktree", "add", "-b", branch, candidate], { cwd: top, encoding: "utf8" })
  if (created.status !== 0) {
    throw new Error((created.stderr || created.stdout || "git worktree add failed").trim())
  }

  return { directory: candidate, branch }
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      const useWorktree = params.worktree === true

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const taskID = params.task_id
      const session = taskID
        ? yield* sessions.get(SessionID.make(taskID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const parent = yield* sessions.get(ctx.sessionID)
      const parentAgent = parent.agent
        ? yield* agent.get(parent.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined

      // If the LLM asked for a worktree, create it before the subagent session
      // so the new session can be scoped to the isolated directory. Resuming
      // a task_id skips worktree creation — the existing session keeps its
      // own directory. Inline git invocation (instead of taking a hard
      // dependency on the Worktree service) so the tool registry's layer
      // surface stays narrow and tests don't need a worktree-capable instance.
      const worktreeInfo =
        useWorktree && !session
          ? yield* Effect.try({
              try: () => createSubagentWorktree(parent.directory, params.description),
              catch: (e) => new Error(`Failed to create worktree: ${e instanceof Error ? e.message : String(e)}`),
            })
          : undefined

      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          ...(worktreeInfo ? { directory: worktreeInfo.directory } : {}),
          permission: [
            ...deriveSubagentSessionPermission({
              parentSessionPermission: parent.permission ?? [],
              parentAgent,
              subagent: next,
            }),
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })) ?? []),
          ],
        }))

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(Effect.orDie)
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
        ...(worktreeInfo
          ? { worktree: worktreeInfo.directory, ...(worktreeInfo.branch ? { worktreeBranch: worktreeInfo.branch } : {}) }
          : {}),
      }
      const worktreeDir = worktreeInfo?.directory

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))
      const runCancel = yield* EffectBridge.make()

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const parts = yield* ops.resolvePromptParts(params.prompt)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          agent: next.name,
          tools: {
            ...(next.permission.some((rule) => rule.permission === "todowrite") ? {} : { todowrite: false }),
            ...(next.permission.some((rule) => rule.permission === id) ? {} : { task: false }),
            ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
          },
          parts,
        })
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      const resumeWhenIdle: (input: { userID: MessageID; state: "completed" | "error" }) => Effect.Effect<void> =
        Effect.fn("TaskTool.resumeWhenIdle")(function* (input: { userID: MessageID; state: "completed" | "error" }) {
          const latest = yield* sessions
            .findMessage(ctx.sessionID, (item) => item.info.role === "user")
            .pipe(Effect.orDie)
          if (Option.isNone(latest)) return
          if (latest.value.info.id !== input.userID) return
          if ((yield* status.get(ctx.sessionID)).type !== "idle") {
            yield* Effect.sleep("300 millis")
            return yield* resumeWhenIdle(input)
          }
          yield* bus.publish(TuiEvent.ToastShow, {
            title: input.state === "completed" ? "Background task complete" : "Background task failed",
            message:
              input.state === "completed"
                ? `Background task "${params.description}" finished. Resuming the main thread.`
                : `Background task "${params.description}" failed. Resuming the main thread.`,
            variant: input.state === "completed" ? "success" : "error",
            duration: 5000,
          })
          yield* ops
            .loop({ sessionID: ctx.sessionID })
            .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
        })

      const continueIfIdle = Effect.fn("TaskTool.continueIfIdle")(function* (input: {
        userID: MessageID
        state: "completed" | "error"
      }) {
        yield* resumeWhenIdle(input).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        const message = yield* ops.prompt({
          sessionID: ctx.sessionID,
          noReply: true,
          agent: currentParent.agent ?? ctx.agent,
          parts: [
            {
              type: "text",
              synthetic: true,
              text: backgroundMessage({
                sessionID: nextSession.id,
                description: params.description,
                state,
                text,
              }),
            },
          ],
        })
        yield* continueIfIdle({ userID: message.info.id, state })
      })

      const existing = yield* background.get(nextSession.id)
      if (existing?.status === "running") {
        return yield* Effect.fail(
          new Error(`Task ${nextSession.id} is already running. Use task_status to check progress.`),
        )
      }

      // Unified flow: ALWAYS register the subagent run as a BackgroundJob.
      // The job's `run` is just `runTask()` — no extra pipeline. We decide
      // whether to inject the result back into the parent session by FORKING
      // a separate watcher that awaits `background.wait` and calls inject()
      // when the job finishes. Forking happens for:
      //   - LLM-initiated background (params.background === true)
      //   - User-initiated demote (Ctrl+B → TuiEvent.SubagentDemote)
      // Sync mode that completes normally returns the result inline and
      // does NOT fork a watcher (the parent tool's response carries the
      // result, no synthetic user message needed).
      const job = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        run: runTask(),
      })

      const injectOnComplete = Effect.fn("TaskTool.injectOnComplete")(function* () {
        const waited = yield* background.wait({ id: nextSession.id })
        const info = waited.info
        if (!info) return
        if (info.status === "completed") {
          yield* inject("completed", info.output ?? "").pipe(Effect.ignore)
        } else if (info.status === "error") {
          yield* inject("error", info.error ?? "Subagent failed").pipe(Effect.ignore)
        }
        // "cancelled" → silently skip; parent (or whoever cancelled) already knows.
      })

      if (runInBackground) {
        yield* injectOnComplete().pipe(Effect.forkIn(scope, { startImmediately: true }))
        return {
          title: params.description,
          metadata: { ...metadata, jobId: job.id },
          output: backgroundOutput(nextSession.id, worktreeDir),
        }
      }

      // Sync mode: bridge ctx.abort (DOM AbortSignal) → Effect so parent
      // interrupt cancels the subagent fiber, matching the prior behavior.
      const cancel = ops.cancel(nextSession.id)
      function onAbort() {
        runCancel.fork(cancel)
      }

      // Demote signal: the first SubagentDemote event keyed on this parent
      // session. Effect.scoped + Stream.runHead auto-cleans the subscription
      // whether we win or lose the race.
      const demoteSignal = Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* bus.subscribe(TuiEvent.SubagentDemote)
          return yield* stream.pipe(
            Stream.filter((event) => event.properties.sessionID === ctx.sessionID),
            Stream.runHead,
          )
        }),
      )

      type WaitOutcome = { kind: "done"; info: { info?: BackgroundJob.Info; timedOut: boolean } } | { kind: "demoted" }
      const result: WaitOutcome = yield* Effect.acquireUseRelease(
        Effect.sync(() => ctx.abort.addEventListener("abort", onAbort)),
        (): Effect.Effect<WaitOutcome, never, never> =>
          Effect.race(
            background.wait({ id: nextSession.id }).pipe(Effect.map((info): WaitOutcome => ({ kind: "done", info }))),
            demoteSignal.pipe(Effect.map((): WaitOutcome => ({ kind: "demoted" }))),
          ),
        (_acquired, exit) =>
          Effect.gen(function* () {
            ctx.abort.removeEventListener("abort", onAbort)
            if (exit._tag === "Failure" && Cause.hasInterrupts(exit.cause)) {
              yield* cancel.pipe(Effect.ignore)
            }
          }),
      )

      if (result.kind === "demoted") {
        // Tight race: the user may have pressed Ctrl+B at the exact moment
        // the job finished. If background.get says the job is already done,
        // return the actual result inline instead of forking a watcher that
        // would inject a duplicate.
        const status = yield* background.get(nextSession.id)
        if (status && status.status !== "running") {
          if (status.status === "completed") {
            return {
              title: params.description,
              metadata: { ...metadata, jobId: job.id },
              output: syncOutput(nextSession.id, status.output ?? "", worktreeDir),
            }
          }
          if (status.status === "error") {
            return yield* Effect.fail(new Error(status.error ?? "Subagent failed"))
          }
          // "cancelled" — fall through to background path; nothing to inject.
        }
        yield* injectOnComplete().pipe(Effect.forkIn(scope, { startImmediately: true }))
        return {
          title: params.description,
          metadata: { ...metadata, jobId: job.id },
          output: backgroundOutput(nextSession.id, worktreeDir),
        }
      }

      const info = result.info.info
      if (!info) {
        return yield* Effect.fail(new Error("Subagent finished but produced no result"))
      }
      if (info.status === "cancelled") {
        return yield* Effect.fail(new Error("Subagent was cancelled"))
      }
      if (info.status === "error") {
        return yield* Effect.fail(new Error(info.error ?? "Subagent failed"))
      }
      return {
        title: params.description,
        metadata: { ...metadata, jobId: job.id },
        output: syncOutput(nextSession.id, info.output ?? "", worktreeDir),
      }
    })

    return {
      description: DESCRIPTION + EXTRA_DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
