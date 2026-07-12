import { Collaboration, formatMailbox, MAX_MAILBOX_PAYLOAD_CHARS } from "@/agent/collaboration"
import { SubagentRun } from "@/agent/subagent-run"
import { BackgroundJob } from "@/background/job"
import type { TaskPromptOps } from "@/agent/child-session"
import * as Tool from "@/tool/tool"
import { Effect, Exit, Schema } from "effect"

const MAX_WAIT_SECONDS = 600

const FollowupParameters = Schema.Struct({
  target: Schema.String.annotate({ description: "Canonical or relative path of the idle child agent to resume." }),
  message: Schema.String.check(Schema.isMaxLength(MAX_MAILBOX_PAYLOAD_CHARS)).annotate({
    description: `The next task or steering instruction for the child agent (maximum ${MAX_MAILBOX_PAYLOAD_CHARS.toLocaleString()} characters).`,
  }),
})

const WaitParameters = Schema.Struct({
  timeout: Schema.optional(Schema.Finite).annotate({
    description: "Maximum seconds to wait for mailbox activity. Defaults to 30.",
  }),
})

const InterruptParameters = Schema.Struct({
  target: Schema.String.annotate({ description: "Canonical or relative path of the child agent to interrupt." }),
})

const ListParameters = Schema.Struct({
  path_prefix: Schema.optional(Schema.String).annotate({
    description: "Optional canonical or relative path prefix to list.",
  }),
  path: Schema.optional(Schema.String).annotate({ description: "Compatibility alias for path_prefix." }),
})

type Metadata = {
  task_path?: string
  session_id?: string
  taskPath?: string
  sessionId?: string
  parentSessionId?: string
  background?: boolean
  status?: string
  root_session_id?: string
  count?: number
}

export const FollowupTaskTool = Tool.define(
  "followup_task",
  Effect.gen(function* () {
    const run = yield* SubagentRun.Service
    return {
      description:
        "Start a new turn for an idle child agent. The child receives the message as new work and reports its final answer to its direct parent.",
      parameters: FollowupParameters,
      execute: (params, ctx) =>
        run.followup({ context: ctx, target: params.target, message: params.message }).pipe(
          Effect.map((result) => ({
            title: `follow up ${result.path}`,
            metadata: {
              task_path: result.path,
              session_id: result.sessionID,
              taskPath: result.path,
              sessionId: result.sessionID,
              parentSessionId: ctx.sessionID,
              background: true,
              status: "pending",
            },
            output: `task_path: ${result.path}\nsession_id: ${result.sessionID}\nstatus: pending`,
          })),
          Effect.orDie,
        ),
    } satisfies Tool.DefWithoutID<typeof FollowupParameters, Metadata>
  }),
)

export const WaitAgentTool = Tool.define<typeof WaitParameters, Metadata, Collaboration.Service>(
  "wait_agent",
  Effect.gen(function* () {
    const collaboration = yield* Collaboration.Service
    return {
      description:
        "Wait for mailbox activity addressed to this agent. On activity, this claims and acknowledges one queued collaboration batch so it is visible exactly once to AI SDK tool-follow-up turns.",
      parameters: WaitParameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const timeout = params.timeout ?? 30
          if (!Number.isFinite(timeout) || timeout < 0 || timeout > MAX_WAIT_SECONDS) {
            return yield* Effect.fail(new Error(`timeout must be between 0 and ${MAX_WAIT_SECONDS} seconds`))
          }
          const status = yield* collaboration.wait({ sessionID: ctx.sessionID, timeout: Math.floor(timeout * 1_000) })
          if (status === "timeout") return { title: "mailbox", metadata: { status }, output: `status: ${status}` }
          // AI SDK can continue tool calls within one stream, before SessionPrompt
          // reaches its next boundary. Claim before persistence work so another
          // tool call cannot format the same records.
          const messages = yield* Effect.acquireUseRelease(
            collaboration.claimInbox({ sessionID: ctx.sessionID }),
            (claimed) =>
              claimed.length
                ? collaboration.acknowledge({ sessionID: ctx.sessionID, messages: claimed })
                : Effect.succeed([]),
            (claimed, exit) =>
              Exit.isFailure(exit)
                ? collaboration.releaseClaimedInbox({ sessionID: ctx.sessionID, messages: claimed })
                : Effect.void,
          )
          const output = `status: ${status}\n\n${formatMailbox(messages)}`
          return {
            title: "mailbox",
            metadata: { status, count: messages.length },
            output,
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof WaitParameters, Metadata>
  }),
)

export const InterruptAgentTool = Tool.define(
  "interrupt_agent",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const collaboration = yield* Collaboration.Service
    return {
      description:
        "Cancel an active child agent turn. The root session and this agent's own session cannot be interrupted.",
      parameters: InterruptParameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (!ops) return yield* Effect.fail(new Error("interrupt_agent requires SessionPrompt operations"))
          const target = yield* collaboration.resolve({ sessionID: ctx.sessionID, target: params.target })
          if (!target) return yield* Effect.fail(new Error(`Unknown collaboration target: ${params.target}`))
          if (target.sessionID === target.rootSessionID || target.sessionID === ctx.sessionID) {
            return yield* Effect.fail(new Error("interrupt_agent cannot interrupt the root or its own session."))
          }
          if ((yield* background.get(target.sessionID))?.status !== "running") {
            return yield* Effect.fail(new Error(`Agent ${target.path} has no active turn.`))
          }
          // Mark the member first so a child racing its final callback cannot enqueue a result.
          yield* collaboration.setStatus({ sessionID: target.sessionID, status: "interrupted" })
          yield* Effect.all([background.cancel(target.sessionID), ops.cancel(target.sessionID)])
          return {
            title: `interrupted ${target.path}`,
            metadata: { task_path: target.path, session_id: target.sessionID, status: "interrupted" },
            output: `task_path: ${target.path}\nstatus: interrupted`,
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof InterruptParameters, Metadata>
  }),
)

export const ListAgentsTool = Tool.define(
  "list_agents",
  Effect.gen(function* () {
    const collaboration = yield* Collaboration.Service
    return {
      description:
        "List collaboration agents with canonical paths, session ids, status, and their most recent task. Use task_status with a session id to read that agent's output.",
      parameters: ListParameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const members = yield* collaboration.list(ctx.sessionID, params.path_prefix ?? params.path)
          const root = yield* collaboration.member(ctx.sessionID)
          return {
            title: "agents",
            metadata: { root_session_id: root?.rootSessionID, status: "ok" },
            output: members
              .map((member) =>
                [
                  `task_path: ${member.path}`,
                  `session_id: ${member.sessionID}`,
                  `status: ${member.status}`,
                  ...(member.lastTask === undefined ? [] : [`last_task: ${member.lastTask}`]),
                ].join("\n"),
              )
              .join("\n\n"),
          }
        }),
    } satisfies Tool.DefWithoutID<typeof ListParameters, Metadata>
  }),
)

export * as CollaborationTool from "./collaboration"
