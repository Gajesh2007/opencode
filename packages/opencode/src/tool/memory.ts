import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./memory.txt"
import { Agent } from "../agent/agent"
import { Memory } from "@/memory/memory"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["view", "append", "replace"]).annotate({
    description: "view your memory, append a new entry, or replace it entirely",
  }),
  content: Schema.optional(Schema.String).annotate({ description: "Text to append or replace (for append/replace)" }),
})

type MemoryMetadata = { scope?: string }

export const MemoryTool = Tool.define<typeof Parameters, MemoryMetadata, Memory.Service | Agent.Service>(
  "memory",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    const agents = yield* Agent.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const agent = yield* agents.get(ctx.agent)
          if (!agent?.memory) {
            return {
              title: "memory",
              metadata: {},
              output: "This agent has no memory store configured (set `memory: user|project|local` in its config).",
            }
          }
          const scope = agent.memory
          if (params.action === "view") {
            const content = yield* memory.read({ name: agent.name, scope })
            return { title: `memory (${scope})`, metadata: { scope }, output: content ?? "(memory is empty)" }
          }
          if (!params.content) {
            return { title: "memory", metadata: { scope }, output: `${params.action} requires content.` }
          }
          if (params.action === "append") yield* memory.append({ name: agent.name, scope, text: params.content })
          else yield* memory.write({ name: agent.name, scope, text: params.content })
          const content = yield* memory.read({ name: agent.name, scope })
          return { title: `memory ${params.action} (${scope})`, metadata: { scope }, output: content ?? "(empty)" }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, MemoryMetadata>
  }),
)
