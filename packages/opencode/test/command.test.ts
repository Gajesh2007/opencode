import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Command } from "../src/command"
import { Config } from "../src/config/config"
import { InstanceState } from "../src/effect/instance-state"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { MCP } from "../src/mcp"
import { Skill } from "../src/skill"
import PROMPT_BATCH from "../src/command/template/batch.txt"
import PROMPT_REVIEW from "../src/command/template/review.txt"
import { testEffect } from "./lib/effect"

const layer = (flags: Partial<RuntimeFlags.Info> = {}, command: Config.Info["command"] = {}) =>
  Command.layer.pipe(
    Layer.provide(RuntimeFlags.layer(flags)),
    Layer.provide(Layer.mock(Config.Service, { get: () => Effect.succeed({ command }) })),
    Layer.provide(Layer.mock(MCP.Service, { prompts: () => Effect.succeed({}) })),
    Layer.provide(Layer.mock(Skill.Service, { all: () => Effect.succeed([]) })),
  )

for (const enabled of [false, true]) {
  describe(`Command with workflow ${enabled ? "enabled" : "disabled by default"}`, () => {
    const flags = enabled ? { experimentalWorkflow: true } : {}
    const it = testEffect(layer(flags))

    it.instance("only exposes the built-in review when opted in", () =>
      Effect.gen(function* () {
        const command = yield* Command.Service
        const review = yield* command.get("review")
        expect((yield* command.list()).some((item) => item.name === "review")).toBe(enabled)
        if (!enabled) {
          expect(review).toBeUndefined()
          return
        }
        const instance = yield* InstanceState.context
        expect(review).toEqual({
          name: "review",
          description: "review changes [commit|branch|pr], defaults to uncommitted",
          source: "command",
          agent: "review",
          template: PROMPT_REVIEW.replace("${path}", instance.worktree),
          subtask: true,
          hints: Command.hints(PROMPT_REVIEW),
        })
      }),
    )

    const custom = testEffect(
      layer(flags, {
        review: {
          description: "Custom review",
          agent: "build",
          model: "test/model",
          template: "Review $ARGUMENTS with $1",
          subtask: false,
        },
      }),
    )

    custom.instance("preserves a configured review command", () =>
      Effect.gen(function* () {
        const command = yield* Command.Service
        const review = yield* command.get("review")
        expect(review).toEqual({
          name: "review",
          description: "Custom review",
          source: "command",
          agent: "build",
          model: "test/model",
          template: "Review $ARGUMENTS with $1",
          subtask: false,
          hints: ["$1", "$ARGUMENTS"],
        })
        expect((yield* command.list()).filter((item) => item.name === "review")).toHaveLength(1)
      }),
    )

    it.instance("leaves batch and init available, but metaagent requires separate opt-in", () =>
      Effect.gen(function* () {
        const command = yield* Command.Service
        const instance = yield* InstanceState.context
        expect(yield* command.get("batch")).toEqual({
          name: "batch",
          description: "split work into worktree-isolated subagents that each open a PR",
          source: "command",
          agent: "batch",
          template: PROMPT_BATCH.replace("${path}", instance.worktree),
          subtask: true,
          hints: Command.hints(PROMPT_BATCH),
        })
        expect((yield* command.list()).map((item) => item.name)).toEqual(
          enabled ? ["init", "review", "batch"] : ["init", "batch"],
        )
      }),
    )
  })
}

testEffect(layer({ experimentalMetaAgent: true })).instance("exposes metaagent only after explicit opt-in", () =>
  Effect.gen(function* () {
    const command = yield* Command.Service
    expect(yield* command.get("metaagent")).toBeDefined()
    expect((yield* command.list()).map((item) => item.name)).toContain("metaagent")
  }),
)
