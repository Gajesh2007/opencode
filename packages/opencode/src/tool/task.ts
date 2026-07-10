import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { childToolOverrides, runChildTurn, type TaskPromptOps } from "../agent/child-session"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { SubagentLimit } from "../agent/subagent-limit"
import { Team } from "../agent/team"
import { Plugin } from "@/plugin"
import { SessionStatus } from "@/session/status"
import { Config } from "@/config/config"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { Cause, Deferred, Effect, Option, Schema, Scope, Stream } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Global } from "@opencode-ai/core/global"
import { spawnSync } from "node:child_process"
import * as nodePath from "node:path"
import * as nodeFs from "node:fs"

export type { TaskPromptOps } from "../agent/child-session"

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
    "",
    "Fork mode: pass fork=true (and omit subagent_type) to spawn a fork that inherits",
    "your FULL conversation context so far, instead of the fresh/empty context a normal",
    "subagent gets. Use a fork when the work needs everything you already know and a",
    "self-contained prompt would be hard to write. The fork runs like any subagent —",
    "only its final message returns — and a fork cannot fork again.",
  ].join(" "),
].join("\n")

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.optional(Schema.String).annotate({
    description:
      "The type of specialized agent to use for this task. Omit it together with fork=true to fork yourself (inherit your own agent + full context).",
  }),
  fork: Schema.optional(Schema.Boolean).annotate({
    description:
      "When true, spawn a fork that inherits this session's full conversation context instead of starting fresh. Omit subagent_type to fork your own agent. A fork cannot fork again.",
  }),
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
  team: Schema.optional(Schema.String).annotate({
    description:
      "Spawn this subagent as a member of the named team, sharing a task list and mailbox with other teammates so they can coordinate via send_message/inbox/team_tasks.",
  }),
  name: Schema.optional(Schema.String).annotate({
    description:
      "Name for this teammate within the team, so others can address it with send_message. Defaults to the subagent type. Only meaningful with `team`.",
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
    const limit = yield* SubagentLimit.Service
    const team = yield* Team.Service
    const plugin = yield* Plugin.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      const useWorktree = params.worktree === true

      const taskID = params.task_id
      const session = taskID
        ? yield* sessions.get(SessionID.make(taskID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const parent = yield* sessions.get(ctx.sessionID)
      const parentAgent = parent.agent
        ? yield* agent.get(parent.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined

      // A fork inherits the parent session's full conversation context instead of
      // starting fresh. Only fork a brand-new run, never when resuming a task_id.
      // Depth bound: parent.parentID is set only for child sessions, so a fork (or
      // any subagent) can never fork again, even if task were re-enabled for it.
      const isFork = params.fork === true && !session && !parent.parentID
      // Forks default to the parent's own agent identity (fork "yourself"); an
      // explicit subagent_type still wins when provided.
      const subagentType = params.subagent_type ?? (isFork ? (parent.agent ?? ctx.agent) : undefined)
      if (!subagentType) {
        return yield* Effect.fail(new Error("subagent_type is required unless fork=true"))
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [subagentType],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: subagentType,
            ...(isFork ? { fork: true } : {}),
          },
        })
      }

      const next = yield* agent.get(subagentType)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${subagentType} is not a valid agent type`))
      }

      // If the LLM asked for a worktree, create it before the subagent session
      // so the new session can be scoped to the isolated directory. Resuming
      // a task_id skips worktree creation — the existing session keeps its
      // own directory. Inline git invocation (instead of taking a hard
      // dependency on the Worktree service) so the tool registry's layer
      // surface stays narrow and tests don't need a worktree-capable instance.
      // Worktree isolation gives the subagent a fresh branch for its edits. It's
      // about file isolation, not context, so it does not combine with fork.
      const worktreeInfo =
        useWorktree && !session && !isFork
          ? yield* Effect.try({
              try: () => createSubagentWorktree(parent.directory, params.description),
              catch: (e) => new Error(`Failed to create worktree: ${e instanceof Error ? e.message : String(e)}`),
            })
          : undefined

      const subagentPermission = [
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
      ]

      const nextSession =
        session ??
        (isFork
          ? // Fork clones the parent's messages up to (not including) the current
            // in-progress turn, so the fork sees the full prior conversation
            // without the dangling tool call that is spawning it.
            yield* sessions.fork({
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              parentID: ctx.sessionID,
              agent: next.name,
              permission: subagentPermission,
              title: params.description + ` (@${next.name} fork)`,
            })
          : yield* sessions.create({
              parentID: ctx.sessionID,
              title: params.description + ` (@${next.name} subagent)`,
              ...(worktreeInfo ? { directory: worktreeInfo.directory } : {}),
              permission: subagentPermission,
            }))

      // Register team membership so the teammate and the lead can coordinate via the
      // send_message / inbox / team_tasks tools, which resolve identity by session id.
      const memberName = params.name ?? next.name
      if (params.team) {
        const leadName = (yield* team.whoami(ctx.sessionID))?.name ?? "lead"
        yield* team.register({ team: params.team, name: leadName, sessionID: ctx.sessionID })
        yield* team.register({ team: params.team, name: memberName, sessionID: nextSession.id })
      }

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(Effect.orDie)
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      // Inherit the user-selected mode (service tier, variant, upstream pin) from the
      // user message that triggered this turn so subagents run with the same tier as
      // the parent. The agent's own `variant` still wins when set — it's an explicit
      // configuration of the agent's identity, not a runtime user choice.
      const parentUser = yield* MessageV2.get({
        sessionID: ctx.sessionID,
        messageID: msg.info.parentID,
      }).pipe(Effect.orDie)
      const parentUserModel = parentUser.info.role === "user" ? parentUser.info.model : undefined
      const inheritedServiceTier = next.serviceTier ?? parentUserModel?.serviceTier
      const inheritedUpstream = parentUserModel?.upstream
      const inheritedVariant = next.variant ?? parentUserModel?.variant

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
          ? {
              worktree: worktreeInfo.directory,
              ...(worktreeInfo.branch ? { worktreeBranch: worktreeInfo.branch } : {}),
            }
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
        const teamPreamble = params.team
          ? `[Team "${params.team}"] You are teammate "${memberName}". Coordinate with teammates using the send_message, inbox, and team_tasks tools; check your inbox when you begin and before you finish.\n\n`
          : ""
        const subagentModel = { modelID: model.modelID, providerID: model.providerID }
        return yield* runChildTurn({
          ops,
          plugin,
          parentSessionID: ctx.sessionID,
          childSessionID: nextSession.id,
          agent: next,
          description: params.description,
          prompt: teamPreamble + params.prompt,
          model: subagentModel,
          variant: inheritedVariant,
          serviceTier: inheritedServiceTier,
          upstream: inheritedUpstream,
          tools: childToolOverrides({
            agent: next,
            primaryTools: cfg.experimental?.primary_tools,
          }),
        })
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
        // Carry the parent's original mode forward on the synthetic completion
        // message so the resumed parent loop runs at the same service tier the
        // user picked (e.g. fast mode), not a regressed default.
        const message = yield* ops.prompt({
          sessionID: ctx.sessionID,
          noReply: true,
          agent: currentParent.agent ?? ctx.agent,
          variant: parentUserModel?.variant,
          serviceTier: inheritedServiceTier,
          upstream: inheritedUpstream,
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
        // Gate the actual subagent work behind the shared concurrency semaphore
        // so massive fan-outs (the workflow engine, or many parallel task calls)
        // drain through a bounded window instead of stampeding the provider.
        run: limit.withPermit(runTask()),
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
