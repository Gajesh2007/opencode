import { Agent } from "@/agent/agent"
import { ChildModel } from "@/agent/child-model"
import { childToolOverrides, runChildTurn, type TaskPromptOps } from "@/agent/child-session"
import { Collaboration, MAX_MAILBOX_PAYLOAD_CHARS } from "@/agent/collaboration"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { SubagentLimit } from "@/agent/subagent-limit"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import type { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import type { Tool } from "@/tool/tool"
import { Cause, Context, Effect, Exit, Layer, Option, References, Schedule, Scope } from "effect"

const TASK_NAME = /^[a-z0-9_]+$/

export type Input = {
  readonly context: Tool.Context
  readonly taskName: string
  readonly message: string
  readonly forkTurns?: "all" | "none" | number
  readonly agentType?: string
  readonly model?: string
  readonly variant?: string
  readonly resetModel?: boolean
}

export type Result = {
  readonly path: string
  readonly sessionID: SessionID
  readonly model: NonNullable<SessionPrompt.PromptInput["model"]>
  readonly variant: string
}

export type FollowupInput = {
  readonly context: Tool.Context
  readonly target: string
  readonly message: string
  readonly model?: string
  readonly variant?: string
  readonly resetModel?: boolean
}

export interface Interface {
  readonly run: (input: Input) => Effect.Effect<Result, Error>
  readonly followup: (input: FollowupInput) => Effect.Effect<Result, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentRun") {}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "_tag" in error) return String(error._tag)
  return String(error)
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const collaboration = yield* Collaboration.Service
    const config = yield* Config.Service
    const limit = yield* SubagentLimit.Service
    const plugin = yield* Plugin.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const scope = yield* Scope.Scope

    // Instance-local service initialization also inherits the caller's diagnostic frames.
    const detached = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        return yield* effect.pipe(
          Effect.provideService(
            References.CurrentStackFrame,
            BackgroundJob.snapshotStack(yield* References.CurrentStackFrame),
          ),
        )
      })

    const resumeParent: (input: { ops: TaskPromptOps; parentSessionID: SessionID }) => Effect.Effect<void> = Effect.fn(
      "SubagentRun.resumeParent",
    )(function* (input) {
      if (!(yield* collaboration.hasMail(input.parentSessionID))) return
      if ((yield* status.get(input.parentSessionID)).type !== "idle") {
        yield* Effect.sleep("300 millis")
        return yield* resumeParent(input)
      }
      if (!(yield* collaboration.hasMail(input.parentSessionID))) return
      const latest = yield* sessions
        .findMessage(input.parentSessionID, (message) => message.info.role === "user")
        .pipe(Effect.orDie)
      if (Option.isNone(latest)) return
      if (
        !(yield* collaboration.hasPendingCompletion({
          sessionID: input.parentSessionID,
          messageID: latest.value.info.id,
        }))
      )
        return
      // Other completion notifiers must not restart a parent turn that was cancelled or failed.
      const previous = yield* sessions
        .findMessage(input.parentSessionID, (message) => message.info.role === "assistant")
        .pipe(Effect.orDie)
      if (Option.isSome(previous) && previous.value.info.role === "assistant" && previous.value.info.error) return
      const mail = yield* collaboration.inbox({ sessionID: input.parentSessionID }).pipe(Effect.orDie)
      if (!mail.length) return
      const resumed = yield* input.ops.loop({ sessionID: input.parentSessionID }).pipe(Effect.exit)
      if (Exit.isFailure(resumed) || resumed.value.info.role !== "assistant" || resumed.value.info.error) return
      const remaining = yield* collaboration.inbox({ sessionID: input.parentSessionID }).pipe(Effect.orDie)
      // A no-op loop must not spin on the same batch. Recheck policy after actual delivery.
      if (!remaining.length || remaining[0].id === mail[0].id) return
      return yield* resumeParent(input)
    })

    const notifyParent = (input: { ops: TaskPromptOps; parentSessionID: SessionID }) =>
      resumeParent(input).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))

    const start = Effect.fn("SubagentRun.start")(function* (
      input: {
        ops: TaskPromptOps
        childSessionID: SessionID
        parentSessionID: SessionID
        path: string
        agent: Agent.Info
        task: string
        message: string
        model: NonNullable<SessionPrompt.PromptInput["model"]>
        variant?: string
        serviceTier?: string
        upstream?: string
        type: "spawn_agent" | "followup_task"
      },
      beforeStart: Effect.Effect<void, unknown>,
    ) {
      const cfg = yield* config.get()
      const metadata = {
        parentSessionId: input.parentSessionID,
        sessionId: input.childSessionID,
        taskPath: input.path,
        background: true,
        model: input.model,
        variant: input.variant,
      }
      yield* background.start({
        id: input.childSessionID,
        type: input.type,
        title: input.task,
        metadata,
        rejectRunning: true,
        beforeStart,
        run: limit
          .withPermit(
            Effect.gen(function* () {
              yield* collaboration.setStatus({
                sessionID: input.childSessionID,
                status: "running",
                lastTask: input.message,
              })
              const executed = yield* runChildTurn({
                ops: input.ops,
                plugin,
                parentSessionID: input.parentSessionID,
                childSessionID: input.childSessionID,
                agent: input.agent,
                description: input.task,
                prompt: input.message,
                model: input.model,
                variant: input.variant,
                serviceTier: input.serviceTier,
                upstream: input.upstream,
                tools: childToolOverrides({ agent: input.agent, primaryTools: cfg.experimental?.primary_tools }),
              }).pipe(Effect.exit)
              if (Exit.isFailure(executed)) {
                if (Cause.hasInterruptsOnly(executed.cause)) return yield* Effect.failCause(executed.cause)
                const error = errorText(Cause.squash(executed.cause))
                const completed = yield* collaboration
                  .complete({ sessionID: input.childSessionID, error })
                  .pipe(Effect.exit)
                if (Exit.isSuccess(completed)) {
                  yield* notifyParent({ ops: input.ops, parentSessionID: input.parentSessionID })
                }
                if (Exit.isFailure(completed)) {
                  yield* collaboration.setStatus({
                    sessionID: input.childSessionID,
                    status: "errored",
                    error: `Child execution failed and its error could not be delivered: ${errorText(Cause.squash(completed.cause))}`,
                  })
                }
                return yield* Effect.failCause(executed.cause)
              }
              const output = executed.value
              const delivered = yield* collaboration
                .complete({ sessionID: input.childSessionID, result: output })
                .pipe(Effect.retry(Schedule.recurs(2)), Effect.exit)
              if (Exit.isSuccess(delivered)) {
                yield* notifyParent({ ops: input.ops, parentSessionID: input.parentSessionID })
                return output
              }
              const error = `Child completed, but final answer delivery failed: ${errorText(Cause.squash(delivered.cause))}`
              yield* collaboration.setStatus({
                sessionID: input.childSessionID,
                status: "errored",
                result: output,
                error,
              })
              yield* background.fail({ id: input.childSessionID, error, output })
              return output
            }),
          )
          .pipe(
            Effect.onInterrupt(() =>
              collaboration.setStatus({ sessionID: input.childSessionID, status: "interrupted" }).pipe(Effect.ignore),
            ),
          ),
      })
    })

    const run = Effect.fn("SubagentRun.run")(function* (input: Input) {
      const taskName = input.taskName.trim()
      const message = input.message.trim()
      if (!TASK_NAME.test(taskName))
        return yield* Effect.fail(new Error("task_name must use lowercase letters, digits, and underscores"))
      if (!message) return yield* Effect.fail(new Error("message must not be empty"))
      if (message.length > MAX_MAILBOX_PAYLOAD_CHARS) {
        return yield* Effect.fail(new Error(`message must not exceed ${MAX_MAILBOX_PAYLOAD_CHARS} characters`))
      }
      if (typeof input.forkTurns === "number" && (!Number.isInteger(input.forkTurns) || input.forkTurns <= 0)) {
        return yield* Effect.fail(new Error("fork_turns must be 'none', 'all', or a positive integer."))
      }

      const ops = input.context.extra?.promptOps as TaskPromptOps | undefined
      if (!ops) return yield* Effect.fail(new Error("spawn_agent requires SessionPrompt operations"))

      const parent = yield* sessions.get(input.context.sessionID)
      const member = yield* collaboration.member(input.context.sessionID)
      if (!member && parent.parentID) {
        return yield* Effect.fail(
          new Error(
            `Parent session ${parent.parentID} is not registered for collaboration; nested spawn requires a registered parent.`,
          ),
        )
      }
      const parentAgentName = parent.agent ?? input.context.agent
      const parentAgent = yield* agents.get(parentAgentName).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      const selected = yield* agents
        .get(input.agentType ?? parentAgentName)
        .pipe(
          Effect.catchCause(() => Effect.fail(new Error(`Unknown agent type: ${input.agentType ?? parentAgentName}`))),
        )
      if (!selected) return yield* Effect.fail(new Error(`Unknown agent type: ${input.agentType ?? parentAgentName}`))
      yield* input.context.ask({
        permission: "spawn_agent",
        patterns: ["*"],
        always: ["*"],
        metadata: { description: taskName, subagent_type: selected.name, collaboration: true },
      })

      const current = yield* MessageV2.get({
        sessionID: input.context.sessionID,
        messageID: input.context.messageID,
      }).pipe(Effect.orDie)
      if (current.info.role !== "assistant")
        return yield* Effect.fail(new Error("spawn_agent must run from an assistant turn"))
      const source = current.info.parentID
        ? yield* MessageV2.get({ sessionID: input.context.sessionID, messageID: current.info.parentID }).pipe(
            Effect.catchCause(() => Effect.succeed(undefined)),
          )
        : undefined
      const inherited = source?.info.role === "user" ? source.info.model : undefined
      const selection = yield* ChildModel.resolve({
        model: input.model,
        variant: input.variant,
        resetModel: input.resetModel,
        agent: selected,
        parent: {
          ...inherited,
          modelID: current.info.modelID,
          providerID: current.info.providerID,
        },
      }).pipe(Effect.provide(Provider.defaultLayer))
      if (!member) yield* collaboration.registerRoot(input.context.sessionID)
      const permission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        parentAgent,
        subagent: selected,
      })
      const child = yield* input.forkTurns === undefined || input.forkTurns === "none"
        ? sessions.create({
            parentID: input.context.sessionID,
            title: `[agent] ${taskName}`,
            agent: selected.name,
            model: {
              id: selection.model.modelID,
              providerID: selection.model.providerID,
              variant: selection.variant,
            },
            permission,
            workspaceID: parent.workspaceID,
          })
        : sessions.fork({
            sessionID: input.context.sessionID,
            messageID: input.context.messageID,
            parentID: input.context.sessionID,
            title: `[agent] ${taskName}`,
            agent: selected.name,
            permission,
            ...(typeof input.forkTurns === "number" ? { lastTurns: input.forkTurns } : {}),
          })
      const registered = yield* collaboration.registerChild({
        parentSessionID: input.context.sessionID,
        sessionID: child.id,
        taskName,
        lastTask: message,
      })
      yield* start(
        {
          ops,
          childSessionID: child.id,
          parentSessionID: input.context.sessionID,
          path: registered.path,
          agent: selected,
          task: taskName,
          message,
          ...selection,
          type: "spawn_agent",
        },
        input.context.metadata({
          title: taskName,
          metadata: {
            parentSessionId: input.context.sessionID,
            sessionId: child.id,
            taskPath: registered.path,
            background: true,
            model: selection.model,
            variant: selection.variant,
          },
        }),
      ).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (Exit.isSuccess(exit) || (yield* background.get(child.id))) return
            yield* collaboration.setStatus({
              sessionID: child.id,
              status: Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "errored",
              error: errorText(Cause.squash(exit.cause)),
            })
          }),
        ),
      )
      return { path: registered.path, sessionID: child.id, model: selection.model, variant: selection.variant }
    }, detached)

    const followup = Effect.fn("SubagentRun.followup")(function* (input: FollowupInput) {
      const message = input.message.trim()
      if (!message) return yield* Effect.fail(new Error("message must not be empty"))
      if (message.length > MAX_MAILBOX_PAYLOAD_CHARS) {
        return yield* Effect.fail(new Error(`message must not exceed ${MAX_MAILBOX_PAYLOAD_CHARS} characters`))
      }
      const ops = input.context.extra?.promptOps as TaskPromptOps | undefined
      if (!ops) return yield* Effect.fail(new Error("followup_task requires SessionPrompt operations"))

      const target = yield* collaboration.resolve({ sessionID: input.context.sessionID, target: input.target })
      if (!target) return yield* Effect.fail(new Error(`Unknown collaboration target: ${input.target}`))
      if (target.sessionID === target.rootSessionID || target.sessionID === input.context.sessionID) {
        return yield* Effect.fail(new Error("followup_task can only target another child agent."))
      }
      if (
        target.status === "pending" ||
        target.status === "running" ||
        (yield* background.get(target.sessionID))?.status === "running" ||
        (yield* status.get(target.sessionID)).type !== "idle"
      ) {
        return yield* Effect.fail(new Error(`Agent ${target.path} is already running.`))
      }

      const child = yield* sessions.get(target.sessionID)
      if (
        (input.model !== undefined || input.variant !== undefined || input.resetModel) &&
        child.parentID !== input.context.sessionID
      ) {
        return yield* Effect.fail(new Error("Only the direct parent can change a child agent's model selection."))
      }
      const selected = yield* agents
        .get(child.agent ?? input.context.agent)
        .pipe(
          Effect.catchCause(() => Effect.fail(new Error(`Unknown child agent: ${child.agent ?? input.context.agent}`))),
        )
      if (!selected) return yield* Effect.fail(new Error(`Unknown child agent: ${child.agent ?? input.context.agent}`))
      yield* input.context.ask({
        permission: "spawn_agent",
        patterns: ["*"],
        always: ["*"],
        metadata: { description: "follow up child agent", subagent_type: selected.name, collaboration: true },
      })
      const lastUser = yield* sessions.findMessage(target.sessionID, (item) => item.info.role === "user")
      const userModel =
        Option.isSome(lastUser) && lastUser.value.info.role === "user" ? lastUser.value.info.model : undefined
      const current =
        userModel ??
        (child.model
          ? { modelID: child.model.id, providerID: child.model.providerID, variant: child.model.variant }
          : undefined)
      if (!current) return yield* Effect.fail(new Error(`Agent ${target.path} has no model to resume with.`))
      const parentSessionID = child.parentID ?? target.parentSessionID
      if (!parentSessionID) return yield* Effect.fail(new Error(`Agent ${target.path} has no parent session.`))
      const parentUser = input.resetModel
        ? yield* sessions.findMessage(parentSessionID, (item) => item.info.role === "user")
        : Option.none()
      const selection = yield* ChildModel.resolve({
        model: input.model,
        variant: input.variant,
        resetModel: input.resetModel,
        agent: selected,
        parent:
          Option.isSome(parentUser) && parentUser.value.info.role === "user" ? parentUser.value.info.model : current,
        current,
      }).pipe(Effect.provide(Provider.defaultLayer))
      if ((yield* status.get(target.sessionID)).type !== "idle") {
        return yield* Effect.fail(new Error(`Agent ${target.path} is already running.`))
      }
      const admission: { claim?: Collaboration.FollowupClaim } = {}
      yield* start(
        {
          ops,
          childSessionID: target.sessionID,
          parentSessionID,
          path: target.path,
          agent: selected,
          task: target.taskName,
          message,
          ...selection,
          type: "followup_task",
        },
        Effect.gen(function* () {
          const claim = yield* collaboration.claimFollowup({ sessionID: target.sessionID, lastTask: message })
          if (!claim) return yield* Effect.fail(new Error(`Agent ${target.path} is already running.`))
          admission.claim = claim
          yield* input.context.metadata({
            title: target.taskName,
            metadata: {
              parentSessionId: parentSessionID,
              sessionId: target.sessionID,
              taskPath: target.path,
              background: true,
              model: selection.model,
              variant: selection.variant,
            },
          })
        }).pipe(
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit) || !admission.claim) return Effect.void
            return collaboration
              .setStatus({
                sessionID: target.sessionID,
                status: admission.claim.previousStatus,
                lastTask: admission.claim.previousLastTask,
              })
              .pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    admission.claim = undefined
                  }),
                ),
              )
          }),
        ),
      ).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (Exit.isSuccess(exit) || !admission.claim) return
            const member = yield* collaboration.member(target.sessionID)
            if (member?.status !== "pending" || member.lastTask !== message) return
            yield* collaboration.setStatus({
              sessionID: target.sessionID,
              status: admission.claim.previousStatus,
              lastTask: admission.claim.previousLastTask,
            })
          }),
        ),
      )
      return { path: target.path, sessionID: target.sessionID, model: selection.model, variant: selection.variant }
    }, detached)

    return Service.of({
      run: (input) =>
        run(input).pipe(Effect.mapError((error) => (error instanceof Error ? error : new Error(errorText(error))))),
      followup: (input) =>
        followup(input).pipe(
          Effect.mapError((error) => (error instanceof Error ? error : new Error(errorText(error)))),
        ),
    })
  }),
)

export const defaultLayer = layer

export * as SubagentRun from "./subagent-run"
