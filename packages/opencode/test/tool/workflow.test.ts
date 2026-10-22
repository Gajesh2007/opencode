import { describe, expect } from "bun:test"
import { Cause, Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { childResult, runChildTurn, type TaskPromptOps } from "@/agent/child-session"
import { SubagentLimit } from "@/agent/subagent-limit"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { WorkflowTool } from "@/tool/workflow"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const model = { modelID: ModelID.make("test"), providerID: ProviderID.make("test") }
const dependencies = Layer.mergeAll(
  Agent.defaultLayer,
  Session.defaultLayer,
  SubagentLimit.defaultLayer,
  Truncate.defaultLayer,
)
const it = testEffect(dependencies.pipe(Layer.provideMerge(RuntimeFlags.layer({ experimentalWorkflow: true }))))

function reply(
  sessionID: SessionID,
  text: string,
  error?: MessageV2.Assistant["error"],
  finish = "stop",
): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      parentID: MessageID.ascending(),
      agent: "general",
      mode: "general",
      ...model,
      cost: 0,
      path: { cwd: "/fixture", root: "/fixture" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now(), completed: Date.now() },
      finish,
      error,
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID, type: "text", text }],
  }
}

const fixture = Effect.fn("WorkflowTest.fixture")(function* (
  respond: (input: Parameters<TaskPromptOps["prompt"]>[0]) => ReturnType<TaskPromptOps["prompt"]>,
) {
  const sessions = yield* Session.Service
  const parent = yield* sessions.create({ title: "workflow parent", agent: "build" })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: parent.id,
    role: "user",
    agent: "build",
    model,
    time: { created: Date.now() },
  })
  const assistant = reply(parent.id, "")
  if (assistant.info.role !== "assistant") return yield* Effect.die("expected assistant")
  assistant.info.parentID = user.id
  yield* sessions.updateMessage(assistant.info)
  const ops: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
    prompt: respond,
    loop: (input) => Effect.succeed(reply(input.sessionID, "")),
  }
  const tool = yield* (yield* WorkflowTool).init()
  const abort = new AbortController()
  return {
    ops,
    abort,
    run: (synthesis = false) =>
      tool.execute(
        {
          description: "outcome test",
          units: [{ id: "a.ts" }],
          passes: [{ name: "logic", agent: "general", prompt: "review" }],
          format: "findings",
          ...(synthesis ? { synthesis: { agent: "general", prompt: "synthesize" } } : {}),
        },
        {
          sessionID: parent.id,
          messageID: assistant.info.id,
          agent: "build",
          abort: abort.signal,
          messages: [],
          extra: { promptOps: ops, bypassAgentCheck: true },
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      ),
  }
})

describe("workflow outcomes", () => {
  for (const finish of ["length", "content-filter", "error", "unknown", "tool-calls"]) {
    for (const text of ["[]", '[{"title":"retained bug","description":"d"}]']) {
      it.instance(`keeps ${finish} findings incomplete even after successful synthesis: ${text}`, () =>
        Effect.gen(function* () {
          const prompts: string[] = []
          const f = yield* fixture((input) => {
            prompts.push(
              input.parts
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("\n"),
            )
            return Effect.succeed(
              reply(
                input.sessionID,
                prompts.length === 1 ? text : "No issues found.",
                undefined,
                prompts.length === 1 ? finish : "stop",
              ),
            )
          })
          const result = yield* f.run(true)
          expect(result.metadata).toMatchObject({ incomplete: 1, cellStatus: [{ outcome: "partial" }] })
          expect(prompts[1]).toContain("Coverage: INCOMPLETE")
          expect(prompts[1]).toContain(finish)
          if (text !== "[]") expect(prompts[1]).toContain("retained bug")
          expect(result.output).toContain("Coverage: INCOMPLETE")
          expect(result.output).toContain(finish)
        }),
      )
    }
  }

  for (const [text, outcome] of [
    ["[]", "completed"],
    ["", "empty"],
    ["not JSON", "malformed"],
    ['[{"title":"retained bug","description":"d"},{}]', "partial"],
  ] as const) {
    it.instance(`reports ${outcome} through the workflow tool`, () =>
      Effect.gen(function* () {
        const f = yield* fixture((input) => Effect.succeed(reply(input.sessionID, text)))
        const result = yield* f.run()
        expect(result.metadata).toMatchObject({
          cellStatus: [{ outcome }],
          incomplete: outcome === "completed" ? 0 : 1,
        })
        expect(result.output).toContain(outcome === "completed" ? "Coverage: complete" : "Coverage: INCOMPLETE")
        if (outcome === "partial") expect(result.output).toContain("retained bug")
      }),
    )
  }

  for (const error of [
    { name: "UnknownError", data: { message: "provider unavailable" } },
    { name: "MessageAbortedError", data: { message: "cancelled" } },
  ] satisfies MessageV2.Assistant["error"][]) {
    it.instance(`preserves partial evidence and ${error.name} for synthesis`, () =>
      Effect.gen(function* () {
        const prompts: string[] = []
        const f = yield* fixture((input) => {
          prompts.push(
            input.parts
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n"),
          )
          return Effect.succeed(
            reply(
              input.sessionID,
              prompts.length === 1 ? '[{"title":"partial bug","description":"d"}]' : "Everything is fine.",
              prompts.length === 1 ? error : undefined,
            ),
          )
        })
        const result = yield* f.run(true)
        expect(result.metadata).toMatchObject({
          incomplete: 1,
          cellStatus: [{ outcome: error.name === "MessageAbortedError" ? "cancelled" : "error" }],
        })
        expect(prompts[1]).toContain("Coverage: INCOMPLETE")
        expect(prompts[1]).toContain("partial bug")
        expect(result.output).toContain("Coverage: INCOMPLETE")
      }),
    )
  }

  it.instance("reports infrastructure and synthesis failures without losing coverage", () =>
    Effect.gen(function* () {
      const f = yield* fixture(() => Effect.die(new Error("transport failed")))
      const result = yield* f.run(true)
      expect(result.output).toContain("transport failed")
      expect(result.output).toContain("Synthesis incomplete (error)")
      expect(result.metadata).toMatchObject({ synthesis: "error" })
    }),
  )

  it.instance("retains findings when synthesis returns only a partial answer", () =>
    Effect.gen(function* () {
      let calls = 0
      const f = yield* fixture((input) =>
        Effect.succeed(
          reply(
            input.sessionID,
            ++calls === 1 ? '[{"title":"retained bug","description":"d"}]' : "partial synthesis",
            calls === 2 ? { name: "UnknownError", data: { message: "synthesis failed" } } : undefined,
          ),
        ),
      )
      const result = yield* f.run(true)
      expect(result.output).toContain("retained bug")
      expect(result.output).toContain("partial synthesis")
      expect(result.output).toContain("Synthesis incomplete (error)")
    }),
  )

  it.instance("does not synthesize or claim success after parent cancellation", () =>
    Effect.gen(function* () {
      let calls = 0
      const f = yield* fixture((input) => {
        calls++
        f.abort.abort()
        return Effect.succeed(reply(input.sessionID, "[]"))
      })
      const exit = yield* f.run(true).pipe(Effect.exit)
      expect(calls).toBe(1)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true)
    }),
  )

  for (const cancelledReply of [false, true]) {
    it.instance(`interrupts parent cancellation during synthesis (child cancelled: ${cancelledReply})`, () =>
      Effect.gen(function* () {
        let calls = 0
        const f = yield* fixture((input) => {
          if (++calls === 1) return Effect.succeed(reply(input.sessionID, "[]"))
          f.abort.abort()
          return Effect.succeed(
            reply(
              input.sessionID,
              "No issues found.",
              cancelledReply ? { name: "MessageAbortedError", data: { message: "cancelled" } } : undefined,
            ),
          )
        })
        const exit = yield* f.run(true).pipe(Effect.exit)
        expect(calls).toBe(2)
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      }),
    )
  }

  for (const error of [
    { name: "UnknownError", data: { message: "provider unavailable" } },
    { name: "MessageAbortedError", data: { message: "cancelled" } },
  ] satisfies MessageV2.Assistant["error"][]) {
    it.instance(`shared child runner rejects ${error.name} without empty recovery`, () =>
      Effect.gen(function* () {
        let calls = 0
        const f = yield* fixture((input) => {
          calls++
          return Effect.succeed(reply(input.sessionID, "partial", error))
        })
        const agent = yield* (yield* Agent.Service).get("general")
        if (!agent) return yield* Effect.die("missing general agent")
        const exit = yield* runChildTurn({
          ops: f.ops,
          plugin: Plugin.Service.of({
            trigger: (_name, _input, output) => Effect.succeed(output),
            list: () => Effect.succeed([]),
            init: () => Effect.void,
          }),
          parentSessionID: SessionID.descending(),
          childSessionID: SessionID.descending(),
          agent,
          description: "error",
          prompt: "review",
          model,
          tools: {},
        }).pipe(Effect.exit)
        expect(calls).toBe(1)
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(error.name === "MessageAbortedError")
      }),
    )
  }

  it.instance("rejects exhausted empty child replies rather than reporting completion", () =>
    Effect.gen(function* () {
      let calls = 0
      const f = yield* fixture((input) => {
        calls++
        return Effect.succeed(reply(input.sessionID, ""))
      })
      const agent = yield* (yield* Agent.Service).get("general")
      if (!agent) return yield* Effect.die("missing general agent")
      const exit = yield* runChildTurn({
        ops: f.ops,
        plugin: Plugin.Service.of({
          trigger: (_name, _input, output) => Effect.succeed(output),
          list: () => Effect.succeed([]),
          init: () => Effect.void,
        }),
        parentSessionID: SessionID.descending(),
        childSessionID: SessionID.descending(),
        agent,
        description: "empty",
        prompt: "review",
        model,
        tools: {},
      }).pipe(Effect.exit)
      expect(calls).toBe(3)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("no usable assistant reply")
      expect(childResult(reply(SessionID.descending(), " ")).status).toBe("empty")
    }),
  )
})

const disabled = testEffect(dependencies.pipe(Layer.provideMerge(RuntimeFlags.layer({}))))
disabled.instance("direct workflow calls cannot bypass the dedicated opt-in", () =>
  Effect.gen(function* () {
    const f = yield* fixture(() => Effect.die("must not prompt"))
    const result = yield* f.run()
    expect(result.output).toContain("OPENCODE_EXPERIMENTAL_WORKFLOW=true")
  }),
)
