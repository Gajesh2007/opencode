export * as AgentMemoryPlugin from "./agent-memory.js"

import { SystemPart, ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Agent } from "../agent.js"
import { AgentMemory } from "../agent-memory.js"
import { Permission } from "../permission.js"

const Input = Schema.Struct({
  action: Schema.Literals(["view", "append", "replace"]),
  content: Schema.optionalKey(Schema.String),
})
const Output = Schema.Struct({ content: Schema.String, scope: Schema.optionalKey(Agent.Memory) })

export const Plugin = define({
  id: "opencode.agent.memory",
  effect: Effect.fn("AgentMemoryPlugin")(function* (ctx) {
    const agents = yield* Agent.Service
    const memory = yield* AgentMemory.Service
    const permissions = yield* Permission.Service

    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const agent = yield* agents.get(event.agent)
        if (!agent?.memory) return
        const text = yield* memory.read({ name: agent.id, scope: agent.memory })
        if (text) event.system.push(SystemPart.make(`<agent_memory scope="${agent.memory}">\n${text}\n</agent_memory>`))
      }).pipe(Effect.catch((error) => Effect.logWarning("Unable to read agent memory", { error }))),
    )

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name: "memory",
          options: { codemode: false },
          description:
            "Read, append to, or replace this agent's configured persistent memory. Save durable facts useful in future sessions.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const agent = yield* agents.get(context.agent)
              if (!agent?.memory) return { output: { content: "This agent has no memory store configured." } }
              const target = { name: agent.id, scope: agent.memory }
              const file = yield* memory.path(target)
              yield* permissions.assert({
                action: "memory",
                resources: [file],
                save: [file],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              if (input.action !== "view" && !input.content)
                return yield* new ToolFailure({ message: `${input.action} requires content.` })
              const content =
                input.action === "view"
                  ? ((yield* memory.read(target)) ?? "(memory is empty)")
                  : yield* memory.write({ ...target, text: input.content!, append: input.action === "append" })
              return { output: { content, scope: agent.memory } }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: "Unable to access agent memory", error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
})
