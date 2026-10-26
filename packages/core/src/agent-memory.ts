export * as AgentMemory from "./agent-memory.js"

import { Agent } from "@opencode/schema/agent"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import path from "node:path"
import { Location } from "./location.js"

export class InvalidName extends Schema.TaggedError<InvalidName>()("AgentMemory.InvalidName", {
  name: Schema.String,
}) {}

export type Input = { readonly name: string; readonly scope: Agent.Memory }

export interface Interface {
  readonly path: (input: Input) => Effect.Effect<string, InvalidName>
  readonly read: (input: Input) => Effect.Effect<string | undefined, InvalidName | FSUtil.Error>
  readonly write: (
    input: Input & { readonly text: string; readonly append?: boolean },
  ) => Effect.Effect<string, InvalidName | FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AgentMemory") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const lock = Semaphore.makeUnsafe(1)
    const resolve = Effect.fn("AgentMemory.path")(function* (input: Input) {
      const segments = input.name.split(/[\\/]/)
      if (segments.some((segment) => !segment || segment === "." || segment === "..") || input.name.includes("\0"))
        return yield* new InvalidName({ name: input.name })
      const root = input.scope === "user" ? global.config : path.join(location.directory, ".opencode")
      const suffix = input.scope === "local" ? ".local.md" : ".md"
      return path.join(root, "memory", `${segments.join(path.sep)}${suffix}`)
    })
    return Service.of({
      path: resolve,
      read: Effect.fn("AgentMemory.read")(function* (input) {
        const text = yield* fs.readFileStringSafe(yield* resolve(input))
        return text?.trim() ? text : undefined
      }),
      write: Effect.fn("AgentMemory.write")((input) =>
        lock.withPermit(
          Effect.gen(function* () {
            const file = yield* resolve(input)
            const previous = input.append ? ((yield* fs.readFileStringSafe(file)) ?? "") : ""
            const text = `${previous.trim() ? previous.trimEnd() + "\n" : ""}${input.text.trim()}\n`
            yield* fs.writeWithDirs(file, text)
            return text
          }),
        ),
      ),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Global.node, Location.node] })
