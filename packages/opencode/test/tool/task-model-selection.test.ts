import { afterEach, describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Fiber, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import type { TaskPromptOps } from "@/agent/child-session"
import { Collaboration } from "@/agent/collaboration"
import { SubagentLimit } from "@/agent/subagent-limit"
import { SubagentRun } from "@/agent/subagent-run"
import { Team } from "@/agent/team"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import type { MessageV2 } from "@/session/message-v2"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { FollowupTaskTool } from "@/tool/collaboration"
import { SpawnAgentTool } from "@/tool/spawn_agent"
import { TaskTool } from "@/tool/task"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

afterEach(disposeAllInstances)

const one = { providerID: ProviderID.make("selection"), modelID: ModelID.make("one") }
const two = { providerID: ProviderID.make("selection"), modelID: ModelID.make("two") }
const catalog = {
  npm: "@ai-sdk/openai-compatible",
  api: "https://selection.invalid/v1",
  options: { apiKey: "fixture-only" },
  models: Object.fromEntries(
    ["one", "two", "blocked"].map((name) => [
      name,
      {
        name,
        reasoning: true,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
        variants: {
          low: { reasoningEffort: "low" },
          high: { reasoningEffort: "high" },
          disabled: { disabled: true },
        },
      },
    ]),
  ),
}
const config = {
  model: "selection/one",
  enabled_providers: ["selection", "disabled-selection"],
  disabled_providers: ["disabled-selection"],
  provider: {
    selection: { ...catalog, blacklist: ["blocked"] },
    "disabled-selection": catalog,
    "not-enabled-selection": catalog,
  },
  agent: { specialist: { mode: "subagent", model: "selection/two", variant: "high" } },
} satisfies Partial<Config.Info>

const dependencies = Layer.mergeAll(
  Agent.defaultLayer,
  BackgroundJob.defaultLayer,
  Bus.defaultLayer,
  Collaboration.defaultLayer,
  Config.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Plugin.defaultLayer,
  Provider.defaultLayer,
  Session.defaultLayer,
  SessionStatus.defaultLayer,
  SubagentLimit.defaultLayer,
  Team.defaultLayer,
  Truncate.defaultLayer,
  RuntimeFlags.layer({}),
)
const it = testEffect(SubagentRun.layer.pipe(Layer.provideMerge(dependencies)))

type Selection = { model?: string; variant?: string; reset_model?: boolean }
type Result = Tool.ExecuteResult<Record<string, unknown>>

function reply(input: SessionPrompt.PromptInput): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      agent: input.agent ?? "build",
      mode: input.agent ?? "build",
      modelID: input.model?.modelID ?? one.modelID,
      providerID: input.model?.providerID ?? one.providerID,
      cost: 0,
      path: { cwd: "/fixture", root: "/fixture" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now(), completed: Date.now() },
      finish: "stop",
    },
    parts: [
      { id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text: "fixture result" },
    ],
  }
}

const turn = Effect.fn("SelectionTest.turn")(function* (sessionID: SessionID, model: MessageV2.User["model"]) {
  const sessions = yield* Session.Service
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model,
    time: { created: Date.now() },
  })
  return yield* sessions.updateMessage(reply({ sessionID, messageID: user.id, model, parts: [] }).info)
})

const latest = Effect.fn("SelectionTest.latest")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  const user = (yield* sessions.messages({ sessionID })).findLast((message) => message.info.role === "user")
  if (user?.info.role !== "user") return yield* Effect.die("child must have a persisted user turn")
  return user.info.model
})

function selected(result: Result, model: typeof one, variant: string) {
  expect(result.metadata).toMatchObject({ model, variant })
  expect(result.output).toContain(`model: ${model.providerID}/${model.modelID}`)
  expect(result.output).toContain(`variant: ${variant}`)
}

const rejected = Effect.fn("SelectionTest.rejected")(function* (
  effect: Effect.Effect<unknown, unknown>,
  pattern: RegExp,
) {
  const exit = yield* effect.pipe(Effect.exit)
  expect(exit._tag).toBe("Failure")
  if (exit._tag === "Failure") {
    const message = Cause.pretty(exit.cause)
    expect(message).toMatch(pattern)
    return message
  }
})

const fixture = Effect.fn("SelectionTest.fixture")(function* (
  kind: "task" | "spawn",
  options: { model?: MessageV2.User["model"]; hold?: Effect.Effect<void> } = {},
) {
  const sessions = yield* Session.Service
  const agents = yield* Agent.Service
  const jobs = yield* BackgroundJob.Service
  const collaboration = yield* Collaboration.Service
  const status = yield* SessionStatus.Service
  const parent = yield* sessions.create({ title: "selection parent", agent: "build" })
  const assistant = yield* turn(parent.id, options.model ?? { ...one, variant: "low" })
  const prompts: SessionPrompt.PromptInput[] = []
  const metadata: Record<string, unknown>[] = []
  const ops: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (text) => Effect.succeed([{ type: "text" as const, text }]),
    // Persist exactly the prompt boundary's selection, without reimplementing selection resolution.
    prompt: (input) =>
      Effect.gen(function* () {
        prompts.push(input)
        const user = yield* sessions.updateMessage({
          id: input.messageID ?? MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          agent: input.agent ?? "build",
          model: {
            ...(input.model ?? one),
            variant: input.variant,
            serviceTier: input.serviceTier,
            upstream: input.upstream,
          },
          time: { created: Date.now() },
        })
        if (input.noReply) return { info: user, parts: [] }
        yield* status.set(input.sessionID, { type: "busy" })
        yield* options.hold ?? Effect.void
        const result = reply({ ...input, messageID: user.id })
        yield* sessions.updateMessage(result.info)
        yield* Effect.forEach(result.parts, (part) => sessions.updatePart(part), { discard: true })
        yield* status.set(input.sessionID, { type: "idle" })
        return result
      }).pipe(Effect.orDie),
    loop: (input) => Effect.succeed(reply({ sessionID: input.sessionID, parts: [] })),
  }
  const context: Tool.Context = {
    sessionID: parent.id,
    messageID: assistant.id,
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    extra: { promptOps: ops },
    ask: () => Effect.void,
    metadata: (input) =>
      Effect.sync(() => {
        if (input.metadata) metadata.push(input.metadata)
      }),
  }
  const task = yield* (yield* TaskTool).init()
  const spawn = yield* (yield* SpawnAgentTool).init()
  const followup = yield* (yield* FollowupTaskTool).init()
  const create = (name: string, selection: Selection = {}, agent = "general", background = false) =>
    kind === "task"
      ? task.execute({ description: name, prompt: name, subagent_type: agent, background, ...selection }, context)
      : spawn.execute({ task_name: name, message: name, agent_type: agent, ...selection }, context)
  const resume = (sessionID: SessionID, selection: Selection = {}, caller = context) =>
    Effect.gen(function* () {
      if (kind === "task") {
        const user = (yield* sessions.messages({ sessionID })).findLast((message) => message.info.role === "user")
        return yield* task.execute(
          {
            description: "resume",
            prompt: "resume",
            subagent_type: user?.info.agent ?? "general",
            task_id: sessionID,
            ...selection,
          },
          caller,
        )
      }
      const member = yield* collaboration.member(sessionID)
      if (!member) return yield* Effect.die("spawned child must be registered")
      return yield* followup.execute({ target: member.path, message: "resume", ...selection }, caller)
    })
  const id = (result: Result) => {
    if (typeof result.metadata.sessionId !== "string") throw new Error("tool must return child sessionId")
    return SessionID.make(result.metadata.sessionId)
  }
  const finished = (result: Result) =>
    Effect.gen(function* () {
      const completed = yield* jobs.wait({ id: id(result), timeout: 2000 })
      expect(completed.timedOut).toBe(false)
      expect(completed.info?.status).toBe("completed")
      return id(result)
    })
  return {
    sessions,
    agents,
    jobs,
    collaboration,
    status,
    parent,
    context,
    prompts,
    metadata,
    task,
    create,
    resume,
    id,
    finished,
  }
})

describe("per-child model selection at tool boundaries", () => {
  for (const kind of ["task", "spawn"] as const) {
    it.instance(
      `${kind}: independent children persist creation and resume selections without role cross-talk`,
      () =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>()
          const test = yield* fixture(kind, { hold: Deferred.await(release) })
          const defaults = yield* test.agents.get("general")
          const first = yield* test.create("first", { model: "selection/one", variant: "high" }, "general", true)
          const second = yield* test.create("second", { model: "selection/two", variant: "low" }, "general", true)
          yield* Deferred.succeed(release, undefined)
          const a = yield* test.finished(first)
          const b = yield* test.finished(second)
          selected(first, one, "high")
          selected(second, two, "low")
          expect(yield* latest(a)).toEqual({ ...one, variant: "high" })
          expect(yield* latest(b)).toEqual({ ...two, variant: "low" })

          const changed = yield* test.resume(a, { model: "selection/two", variant: "high" })
          yield* test.finished(changed)
          selected(changed, two, "high")
          expect(yield* latest(a)).toEqual({ ...two, variant: "high" })
          expect(yield* latest(b)).toEqual({ ...two, variant: "low" })
          const retained = yield* test.resume(a)
          yield* test.finished(retained)
          selected(retained, two, "high")
          expect(yield* latest(a)).toEqual({ ...two, variant: "high" })

          const inherited = yield* test.create("inherited")
          yield* test.finished(inherited)
          selected(inherited, one, "low")
          expect(yield* latest(test.id(inherited))).toEqual({ ...one, variant: "low" })
          expect(yield* test.agents.get("general")).toEqual(defaults)
          expect(yield* test.agents.listSubagentModels()).toEqual({})
        }),
      { config },
    )

    it.instance(
      `${kind}: effort-only, default clearing, omitted resume, and reset use the effective child selection`,
      () =>
        Effect.gen(function* () {
          const test = yield* fixture(kind)
          const first = yield* test.create("effort_only", { variant: "high" })
          const child = yield* test.finished(first)
          selected(first, one, "high")
          expect(yield* latest(child)).toEqual({ ...one, variant: "high" })

          const cleared = yield* test.resume(child, { variant: "default" })
          yield* test.finished(cleared)
          selected(cleared, one, "default")
          expect(yield* latest(child)).toEqual({ ...one, variant: "default" })
          const assistant = yield* turn(test.parent.id, { ...two, variant: "low" })
          test.context.messageID = assistant.id
          const retained = yield* test.resume(child)
          yield* test.finished(retained)
          selected(retained, one, "default")
          expect(yield* latest(child)).toEqual({ ...one, variant: "default" })

          const reset = yield* test.resume(child, { reset_model: true })
          yield* test.finished(reset)
          selected(reset, two, "low")
          expect(yield* latest(child)).toEqual({ ...two, variant: "low" })
        }),
      { config },
    )

    it.instance(
      `${kind}: model-only switches clear inherited effort and effort-only resumes keep the chosen model`,
      () =>
        Effect.gen(function* () {
          const test = yield* fixture(kind)
          const first = yield* test.create("model_only", { model: "selection/two" })
          const child = yield* test.finished(first)
          selected(first, two, "default")
          expect(yield* latest(child)).toEqual({ ...two, variant: "default" })
          const effort = yield* test.resume(child, { variant: "high" })
          yield* test.finished(effort)
          selected(effort, two, "high")
          expect(yield* latest(child)).toEqual({ ...two, variant: "high" })
          const changed = yield* test.resume(child, { model: "selection/one" })
          yield* test.finished(changed)
          selected(changed, one, "default")
          expect(yield* latest(child)).toEqual({ ...one, variant: "default" })
        }),
      { config },
    )

    it.instance(
      `${kind}: reset restores specialist defaults rather than the explicit creation override`,
      () =>
        Effect.gen(function* () {
          const test = yield* fixture(kind)
          const first = yield* test.create("specialist", { model: "selection/one", variant: "low" }, "specialist")
          const child = yield* test.finished(first)
          selected(first, one, "low")
          const reset = yield* test.resume(child, { reset_model: true })
          yield* test.finished(reset)
          selected(reset, two, "high")
          expect(yield* latest(child)).toEqual({ ...two, variant: "high" })
          const cleared = yield* test.resume(child, { variant: "default" })
          yield* test.finished(cleared)
          selected(cleared, two, "default")
          const retained = yield* test.resume(child)
          yield* test.finished(retained)
          selected(retained, two, "default")
          expect(yield* latest(child)).toEqual({ ...two, variant: "default" })
          expect(yield* test.agents.get("specialist")).toMatchObject({ model: two, variant: "high" })
        }),
      { config },
    )

    it.instance(
      `${kind}: invalid, disabled, and conflicting requests fail before child or job creation`,
      () =>
        Effect.gen(function* () {
          const test = yield* fixture(kind)
          for (const selection of [
            { model: "one" },
            { model: "unknown/one" },
            { model: "selection/missing" },
            { model: "selection/blocked" },
            { model: "disabled-selection/one" },
            { model: "not-enabled-selection/one" },
            { variant: "missing" },
            { variant: "disabled" },
            { model: "selection/one", reset_model: true },
            { variant: "low", reset_model: true },
          ]) {
            yield* rejected(test.create("invalid", selection), /model|provider|variant|reset/i)
            expect(yield* test.sessions.children(test.parent.id)).toEqual([])
            expect(yield* test.jobs.list()).toEqual([])
            expect(yield* test.collaboration.list(test.parent.id)).toEqual([])
            expect(test.prompts).toEqual([])
            expect(test.metadata).toEqual([])
          }
        }),
      { config },
    )

    it.instance(
      `${kind}: omitted selections preserve existing inherited variant, service tier, and upstream behavior`,
      () =>
        Effect.gen(function* () {
          const model = { ...one, variant: "low", serviceTier: "fast", upstream: "pinned-origin" }
          const test = yield* fixture(kind, { model })
          const initial = yield* test.create("omitted")
          const child = yield* test.finished(initial)
          expect(yield* latest(child)).toEqual(model)
          const resumed = yield* test.resume(child)
          yield* test.finished(resumed)
          expect(yield* latest(child)).toEqual(model)
          selected(initial, one, "low")
          selected(resumed, one, "low")
        }),
      { config },
    )

    it.instance(
      `${kind}: failed idle changes leave messages, effective selection, and job metadata untouched`,
      () =>
        Effect.gen(function* () {
          const test = yield* fixture(kind)
          const first = yield* test.create("unchanged", { model: "selection/two", variant: "high" })
          const child = yield* test.finished(first)
          const messages = yield* test.sessions.messages({ sessionID: child })
          const job = yield* test.jobs.get(child)
          const member = yield* test.collaboration.member(child)
          const count = test.metadata.length
          for (const selection of [{ model: "selection/missing" }, { variant: "disabled" }]) {
            yield* rejected(test.resume(child, selection), /model|variant/i)
            expect(yield* test.sessions.messages({ sessionID: child })).toEqual(messages)
            expect(yield* test.jobs.get(child)).toEqual(job)
            expect(yield* test.collaboration.member(child)).toEqual(member)
            expect(test.metadata).toHaveLength(count)
          }
          const retained = yield* test.resume(child)
          yield* test.finished(retained)
          selected(retained, two, "high")
        }),
      { config },
    )

    it.instance(
      `${kind}: a failed resume metadata callback restores the prior selection and permits retry`,
      () =>
        Effect.gen(function* () {
          const test = yield* fixture(kind)
          const initial = yield* test.create("retry", { model: "selection/two", variant: "high" })
          const child = yield* test.finished(initial)
          const messages = yield* test.sessions.messages({ sessionID: child })
          const job = yield* test.jobs.get(child)
          const member = yield* test.collaboration.member(child)
          yield* rejected(
            test.resume(
              child,
              { model: "selection/one", variant: "low" },
              {
                ...test.context,
                metadata: () => Effect.die(new Error("fixture metadata refused")),
              },
            ),
            /fixture metadata refused/,
          )
          expect(yield* test.sessions.messages({ sessionID: child })).toEqual(messages)
          expect(yield* test.jobs.get(child)).toEqual(job)
          expect(yield* test.collaboration.member(child)).toEqual(member)
          const retry = yield* test.resume(child, { model: "selection/one", variant: "low" })
          yield* test.finished(retry)
          selected(retry, one, "low")
          expect(yield* latest(child)).toEqual({ ...one, variant: "low" })
        }),
      { config },
    )

    it.instance(
      `${kind}: busy resume rejects selection changes without mutating the active child`,
      () =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>()
          const test = yield* fixture(kind, { hold: Deferred.await(release) })
          const first = yield* test.create("busy", { model: "selection/one", variant: "low" }, "general", true)
          const child = test.id(first)
          yield* pollWithTimeout(
            test.status.get(child).pipe(Effect.map((status) => (status.type === "busy" ? true : undefined))),
            "child never entered its prompt",
          )
          const messages = yield* test.sessions.messages({ sessionID: child })
          const job = yield* test.jobs.get(child)
          const count = test.metadata.length
          yield* rejected(test.resume(child, { model: "selection/two", variant: "high" }), /running|busy/i)
          expect(yield* test.sessions.messages({ sessionID: child })).toEqual(messages)
          expect(yield* latest(child)).toEqual({ ...one, variant: "low" })
          expect(yield* test.jobs.get(child)).toEqual(job)
          expect(test.metadata).toHaveLength(count)
          yield* Deferred.succeed(release, undefined)
          yield* test.finished(first)
        }),
      { config },
    )

    it.instance(
      `${kind}: only the direct parent can change an idle sibling's selection`,
      () =>
        Effect.gen(function* () {
          const test = yield* fixture(kind)
          const first = yield* test.create("first", { model: "selection/one", variant: "low" })
          const second = yield* test.create("second", { model: "selection/two", variant: "high" })
          const child = yield* test.finished(first)
          const sibling = yield* test.finished(second)
          const assistant = (yield* test.sessions.messages({ sessionID: sibling })).findLast(
            (message) => message.info.role === "assistant",
          )
          if (!assistant) return yield* Effect.die("sibling needs an assistant turn")
          const caller = { ...test.context, sessionID: sibling, messageID: assistant.info.id }
          const messages = yield* test.sessions.messages({ sessionID: child })
          yield* rejected(test.resume(child, { model: "selection/two", variant: "low" }, caller), /direct parent/i)
          yield* rejected(test.resume(child, { reset_model: true }, caller), /direct parent/i)
          expect(yield* test.sessions.messages({ sessionID: child })).toEqual(messages)
          const allowed = yield* test.resume(child, { model: "selection/two", variant: "low" })
          yield* test.finished(allowed)
          selected(allowed, two, "low")
        }),
      { config },
    )

    for (const pin of [{ serviceTier: "fast" }, { upstream: "pinned-origin" }]) {
      it.instance(
        `${kind}: incompatible inherited ${Object.keys(pin)[0]} produces an actionable error before creation`,
        () =>
          Effect.gen(function* () {
            const test = yield* fixture(kind, { model: { ...one, variant: "low", ...pin } })
            const message = yield* rejected(test.create("incompatible", { model: "selection/two" }), /tier|upstream/i)
            expect(message).toContain("selection/two")
            expect(message).toMatch(/choose.*compatible|user.*clear/i)
            expect(yield* test.sessions.children(test.parent.id)).toEqual([])
            expect(yield* test.jobs.list()).toEqual([])
            expect(test.prompts).toEqual([])
            expect(test.metadata).toEqual([])
          }),
        { config },
      )
    }
  }

  for (const order of [
    ["task", "task"],
    ["task", "followup"],
    ["followup", "task"],
  ] as const) {
    it.instance(
      `${order.join("/")}: only one concurrent idle resume applies selection and publishes metadata`,
      () =>
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const releaseMetadata = yield* Deferred.make<void>()
          const releasePrompt = yield* Deferred.make<void>()
          const gate = { hold: Effect.void }
          const test = yield* fixture(order[0] === "followup" || order[1] === "followup" ? "spawn" : "task", gate)
          const team = yield* Team.Service
          const initial = yield* test.create("concurrent", { model: "selection/one", variant: "low" })
          const child = yield* test.finished(initial)
          gate.hold = Deferred.await(releasePrompt)
          const metadataCount = test.metadata.length
          const params = {
            task_id: child,
            description: "resume",
            prompt: "resume",
            subagent_type: "general",
            background: true,
          }
          const resume = (
            tool: "task" | "followup",
            selection: Selection,
            caller: Tool.Context,
            sideEffects = false,
          ) =>
            tool === "followup"
              ? test.resume(child, selection, caller)
              : test.task.execute(
                  { ...params, ...selection, ...(sideEffects ? { team: "race", name: "loser" } : {}) },
                  caller,
                )
          const first = yield* resume(
            order[0],
            { model: "selection/two", variant: "high" },
            {
              ...test.context,
              metadata: (input) =>
                test.context
                  .metadata(input)
                  .pipe(
                    Effect.andThen(Deferred.succeed(entered, undefined)),
                    Effect.andThen(Deferred.await(releaseMetadata)),
                  ),
            },
          ).pipe(Effect.forkScoped)
          yield* awaitWithTimeout(Deferred.await(entered), "first resume did not reach metadata")
          const second = yield* awaitWithTimeout(
            resume(order[1], { model: "selection/one", variant: "high" }, test.context, true).pipe(Effect.exit),
            "competing background resume did not return",
          )
          yield* Deferred.succeed(releaseMetadata, undefined)
          const results = [yield* Fiber.await(first), second]
          expect(results.filter((result) => result._tag === "Success")).toHaveLength(1)
          const winner = results.find((result) => result._tag === "Success")
          const loser = results.find((result) => result._tag === "Failure")
          if (!winner || !loser) return yield* Effect.die("exactly one concurrent resume must succeed")
          expect(Cause.pretty(loser.cause)).toMatch(/running|busy/i)
          expect(test.metadata).toHaveLength(metadataCount + 1)
          expect(yield* team.whoami(child)).toBeUndefined()
          expect(yield* team.whoami(test.parent.id)).toBeUndefined()
          yield* pollWithTimeout(
            test.status.get(child).pipe(Effect.map((status) => (status.type === "busy" ? true : undefined))),
            "winning resume never entered its prompt",
          )
          selected(winner.value, two, "high")
          expect(yield* latest(child)).toEqual({ ...two, variant: "high" })
          expect((yield* test.jobs.get(child))?.metadata).toMatchObject({ model: two, variant: "high" })
          if (order[0] === "followup") expect((yield* test.collaboration.member(child))?.status).toBe("running")
          yield* Deferred.succeed(releasePrompt, undefined)
          yield* test.finished(winner.value)
        }),
      { config },
    )
  }

  it.instance(
    "task background completion preserves the parent's newest model, effort, tier, and upstream",
    () =>
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>()
        const test = yield* fixture("task", { hold: Deferred.await(release) })
        const child = yield* test.create("background", { model: "selection/two", variant: "high" }, "general", true)
        const model = { ...two, variant: "default", serviceTier: "priority", upstream: "new-origin" }
        yield* turn(test.parent.id, model)
        yield* Deferred.succeed(release, undefined)
        yield* test.finished(child)
        const completion = yield* pollWithTimeout(
          Effect.sync(() => test.prompts.findLast((input) => input.sessionID === test.parent.id && input.noReply)),
          "background completion was not injected into parent",
        )
        expect(completion).toMatchObject({
          model: two,
          variant: "default",
          serviceTier: "priority",
          upstream: "new-origin",
        })
        yield* pollWithTimeout(
          test.sessions
            .messages({ sessionID: test.parent.id })
            .pipe(
              Effect.map((messages) =>
                messages.filter((message) => message.info.role === "user").length === 3 ? true : undefined,
              ),
            ),
          "background completion user message was not persisted",
        )
        expect(yield* latest(test.parent.id)).toEqual(model)
      }),
    { config },
  )

  it.instance(
    "task validates explicit selection before attempting worktree creation",
    () =>
      Effect.gen(function* () {
        const test = yield* fixture("task")
        yield* rejected(
          test.task.execute(
            {
              description: "invalid worktree",
              prompt: "must not run",
              subagent_type: "general",
              worktree: true,
              ...{ model: "selection/missing" },
            },
            test.context,
          ),
          /model.*missing|missing.*model/i,
        )
        expect(yield* test.sessions.children(test.parent.id)).toEqual([])
        expect(yield* test.jobs.list()).toEqual([])
        expect(test.prompts).toEqual([])
      }),
    { config },
  )
})
