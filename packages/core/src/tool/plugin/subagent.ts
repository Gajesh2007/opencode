export * as SubagentTool from "./subagent.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Predicate, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { Job } from "../../job.js"
import { Model } from "../../model.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { SubagentCompletion } from "../../session/subagent-completion.js"
import { SubagentJob } from "../../session/subagent-job.js"
import { Collaboration } from "../../collaboration.js"
import { Team } from "../../team.js"
import { Worktree } from "../../worktree.js"
import { SubagentModel } from "../../subagent-model.js"
import { SubagentLimit } from "../../subagent-limit.js"

export const name = "subagent"

const backgroundResult = (sessionID: SessionSchema.ID) => ({
  sessionID,
  status: "running" as const,
  output: [
    `The subagent is working in the background (sessionID: ${sessionID}). You will be notified automatically when it finishes.`,
    "DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.",
    "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
  ].join("\n"),
})

export const Input = Schema.Struct({
  variant: Schema.optionalKey(Schema.String),
  reset_model: Schema.optionalKey(Schema.Boolean),
  fork_turns: Schema.optionalKey(
    Schema.Union([Schema.Literals(["none", "all"]), Schema.Int.check(Schema.isGreaterThan(0))]),
  ),
  worktree: Schema.optionalKey(Schema.Boolean),
  team: Schema.optionalKey(Schema.String).annotate({
    description: "Optional team name; the caller joins as lead and the child joins under name.",
  }),
  name: Schema.optionalKey(Schema.String).annotate({
    description: "Short unique task name used for addressing this child in family messages.",
  }),
  agent: Schema.String.annotate({
    description:
      "The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead.",
  }),
  description: Schema.String.annotate({ description: "A short 3-5 word label for the task, displayed to the user" }),
  prompt: Schema.String.annotate({ description: "The task for the subagent to perform" }),
  model: Schema.optionalKey(Schema.String).annotate({
    description:
      'NEVER set this unless the user explicitly asks for a particular model or variant. The value is written as "providerID/modelID", or "providerID/modelID#variant" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first.',
  }),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description:
      "Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation.",
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress.",
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literals(["completed", "running"]),
  output: Schema.String,
})
export const description = [
  "Spawns an agent in a child session to work on the specified task.",
  "The output includes a sessionID you can pass back later to continue that specific conversation with the subagent.",
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  "Foreground (default) runs the subagent to completion and returns its final response.",
  "Background mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.",
  "Use background only for independent work that can run while you continue elsewhere.",
].join("\n")

export const Plugin = {
  id: "opencode.tool.subagent",
  effect: Effect.fn("SubagentTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const models = yield* Model.Service
    const subagents = yield* SubagentJob.Service
    const collaboration = yield* Collaboration.Service
    const teams = yield* Team.Service
    const worktrees = yield* Worktree.Service
    const limiter = yield* SubagentLimit.Service
    const defaults = yield* SubagentModel.Service

    const resolveModel = Effect.fn("SubagentTool.resolveModel")(function* (input: string) {
      const ref = yield* Effect.try({
        try: () => Model.Ref.parse(input),
        catch: () =>
          new ToolFailure({
            message: `Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`,
          }),
      })
      const model = (yield* models.available()).find(
        (model) => model.providerID === ref.providerID && model.id === ref.id,
      )
      if (model === undefined)
        return yield* new ToolFailure({
          message: `Model "${ref.providerID}/${ref.id}" is not available. Use the models tool to see what is available.`,
        })
      if (ref.variant !== undefined && !model.variants.some((variant) => variant.id === ref.variant))
        return yield* new ToolFailure({
          message:
            model.variants.length === 0
              ? `Model "${ref.providerID}/${ref.id}" has no variants. Omit the variant.`
              : `Variant "${ref.variant}" is not available for "${ref.providerID}/${ref.id}". Available: ${model.variants.map((variant) => variant.id).join(", ")}.`,
        })
      return ref
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const parent = yield* sessions
                .get(context.sessionID)
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                  ),
                )
              let current = parent
              let depth = 0
              while (current.parentID) {
                depth++
                current = yield* sessions
                  .get(current.parentID)
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Parent session not found: ${current.parentID}`, error }),
                    ),
                  )
              }
              const limit =
                Config.latest(yield* config.entries(), "experimental")?.subagent_depth ?? (input.name ? Infinity : 1)
              if (depth >= limit)
                return yield* new ToolFailure({
                  message: `Subagent depth limit reached (${limit}). Increase "experimental.subagent_depth" to allow nested subagents.`,
                })
              const agent = yield* agents.resolve(input.agent)
              if (agent === undefined) return yield* new ToolFailure({ message: `Unknown agent: ${input.agent}` })
              if (agent.mode === "primary" && !input.name && !input.sessionID)
                return yield* new ToolFailure({ message: `Agent ${input.agent} cannot run as a subagent` })
              yield* permission
                .assert({
                  action: name,
                  resources: [agent.id],
                  save: [agent.id],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: {
                    type: "tool",
                    messageID: context.messageID,
                    id: context.id,
                  },
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: `Subagent denied: ${agent.id}`, error })))

              const existing =
                input.sessionID === undefined
                  ? undefined
                  : yield* sessions
                      .get(input.sessionID)
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new ToolFailure({ message: `Subagent session not found: ${input.sessionID}`, error }),
                        ),
                      )
              if (existing !== undefined && existing.parentID !== context.sessionID)
                return yield* new ToolFailure({
                  message: `Session ${existing.id} is not a child of the current session`,
                })
              if (input.reset_model && (input.model !== undefined || input.variant !== undefined))
                return yield* new ToolFailure({ message: "reset_model cannot be combined with model or variant." })
              const configured = (yield* defaults.list)[agent.id] ?? agent.model
              const requested = input.model === undefined ? undefined : yield* resolveModel(input.model)
              const base =
                requested ??
                (input.reset_model ? (configured ?? parent.model) : (existing?.model ?? configured ?? parent.model))
              if (input.variant !== undefined && !base)
                return yield* new ToolFailure({ message: "Select a model before setting a variant." })
              const override =
                input.variant !== undefined && base
                  ? input.variant === "default"
                    ? { ...base, variant: undefined }
                    : { ...base, ...(yield* resolveModel(base.providerID + "/" + base.id + "#" + input.variant)) }
                  : input.reset_model
                    ? base
                    : requested
              // Continuing with a different agent switches the child, mirroring create semantics
              // where an explicit model wins over the agent's configured model, which wins over the inherited one.
              if (existing !== undefined) {
                const switched = existing.agent !== agent.id
                const model = override ?? (switched ? configured : undefined)
                yield* Effect.all([
                  switched ? sessions.switchAgent({ sessionID: existing.id, agent: agent.id }) : Effect.void,
                  model === undefined ? Effect.void : sessions.switchModel({ sessionID: existing.id, model }),
                ]).pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to switch subagent session: ${existing.id}`, error }),
                  ),
                )
              }

              const selected = override ?? configured ?? parent.model
              const model = selected && {
                ...selected,
                serviceTier: selected.serviceTier ?? parent.model?.serviceTier,
                upstream: selected.upstream ?? parent.model?.upstream,
                reasoningMode: selected.reasoningMode ?? parent.model?.reasoningMode,
              }
              if (input.worktree && input.fork_turns && input.fork_turns !== "none")
                return yield* new ToolFailure({ message: "Use a fresh child for worktree isolation." })
              const tree =
                !existing && input.worktree
                  ? yield* worktrees
                      .create({ projectID: parent.projectID, from: parent.location.directory, name: input.name })
                      .pipe(
                        Effect.mapError(
                          (error) => new ToolFailure({ message: "Unable to create subagent worktree", error }),
                        ),
                      )
                  : undefined
              const fork =
                !existing && input.fork_turns && input.fork_turns !== "none"
                  ? yield* sessions
                      .fork({
                        sessionID: parent.id,
                        asChild: true,
                        lastTurns: typeof input.fork_turns === "number" ? input.fork_turns : undefined,
                      })
                      .pipe(
                        Effect.mapError(
                          (error) => new ToolFailure({ message: "Unable to fork parent context", error }),
                        ),
                      )
                  : undefined
              const child =
                existing ??
                fork ??
                (yield* sessions
                  .create({
                    parentID: context.sessionID,
                    title: input.description,
                    agent: agent.id,
                    model,
                    ...(tree ? { location: { directory: tree.directory } } : {}),
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                    ),
                  ))
              if (fork) {
                yield* sessions.switchAgent({ sessionID: fork.id, agent: agent.id }).pipe(Effect.orDie)
                if (model) yield* sessions.switchModel({ sessionID: fork.id, model }).pipe(Effect.orDie)
                yield* sessions.rename({ sessionID: fork.id, title: input.description }).pipe(Effect.orDie)
              }

              const background = input.background === true
              if (!existing && input.name !== undefined)
                yield* collaboration
                  .register(context.sessionID, child.id, input.name)
                  .pipe(
                    Effect.catch((error) =>
                      sessions
                        .remove(child.id)
                        .pipe(Effect.ignore, Effect.andThen(new ToolFailure({ message: error.message }))),
                    ),
                  )
              if (input.team) {
                const lead = yield* teams.whoami(context.sessionID)
                yield* teams.register({ team: input.team, name: lead?.name ?? "lead", sessionID: context.sessionID })
                yield* teams.register({ team: input.team, name: input.name ?? agent.name, sessionID: child.id })
              }
              yield* context.progress({ sessionID: child.id, status: "running" })

              // Admit durably before the job takes its concurrency permit. An active child
              // observes this steer at the next boundary; an idle child starts inside the permit.
              yield* sessions
                .prompt({
                  sessionID: child.id,
                  text:
                    existing === undefined
                      ? [
                          "You are a subagent spawned by another session.",
                          input.team
                            ? `You are teammate ${input.name ?? agent.name} in team ${input.team}. Coordinate with send_message, inbox and team_tasks.`
                            : "",
                          input.prompt,
                        ]
                          .filter(Boolean)
                          .join("\n")
                      : input.prompt,
                  resume: false,
                })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to prompt subagent: ${child.id}`, error }),
                  ),
                )

              const recovery = {
                kind: "subagent" as const,
                parentSessionID: context.sessionID,
                childSessionID: child.id,
                agent: agent.name,
                description: input.description,
              }
              yield* subagents.start(recovery, yield* limiter.semaphore)

              if (background) {
                yield* subagents.background(recovery)
                return backgroundResult(child.id)
              }

              const result = yield* jobs.block({ id: child.id, sessionID: context.sessionID }).pipe(
                Effect.onInterrupt(() =>
                  Effect.gen(function* () {
                    if (yield* jobs.isBackgrounded(child.id)) {
                      const running = yield* jobs.get(child.id)
                      if (running) yield* subagents.notify(recovery, running.started_at)
                      return
                    }
                    yield* Effect.all([sessions.interrupt(child.id), jobs.cancel(child.id)], { discard: true })
                  }),
                ),
              )
              if (result?.type === "backgrounded") {
                yield* subagents.notify(recovery, result.info.started_at)
                return backgroundResult(child.id)
              }
              // Failure surfaces keep the sessionID visible so the model can continue the child.
              if (result?.info.status === "error")
                return yield* new ToolFailure({
                  message: `Subagent failed (sessionID: ${child.id}): ${result.info.error ?? "unknown error"}`,
                })
              if (result?.info.status === "cancelled")
                return yield* new ToolFailure({ message: `Subagent cancelled (sessionID: ${child.id})` })
              return {
                sessionID: child.id,
                status: "completed" as const,
                output: result?.info.output ?? SubagentCompletion.NO_TEXT,
              }
            }).pipe(
              Effect.map((output) => ({
                output,
                content:
                  output.status === "completed"
                    ? `<subagent sessionID="${output.sessionID}" state="completed">\n${output.output}\n</subagent>`
                    : output.output,
                metadata: { sessionID: output.sessionID, status: output.status },
              })),
            ),
        }),
      )
      .pipe(Effect.orDie)

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.sync(() => {
        if (event.tool !== name || !Predicate.isObject(event.input)) return
        if (event.input.model !== "" && event.input.sessionID !== "") return
        const input = { ...event.input }
        if (input.model === "") delete input.model
        if (input.sessionID === "") delete input.sessionID
        event.input = input
      }),
    )

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const tool = event.tools[name]
        if (!tool) return
        const selected = yield* agents.resolve(event.agent)
        if (!selected) return
        const available = (yield* agents.list())
          .filter(
            (agent) =>
              agent.mode !== "primary" &&
              !agent.hidden &&
              Permission.evaluate(name, agent.id, selected.permissions).effect !== "deny",
          )
          .toSorted((a, b) => a.id.localeCompare(b.id))
        if (available.length === 0) return
        tool.description = [
          tool.description,
          "",
          "Available subagents:",
          ...available.map(
            (agent) =>
              `- ${agent.id}: ${agent.description ?? "This subagent should only be called when explicitly requested."}`,
          ),
        ].join("\n")
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
