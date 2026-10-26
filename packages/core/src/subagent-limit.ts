export * as SubagentLimit from "./subagent-limit.js"

import { Context, Effect, Layer, Semaphore } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Config } from "./config.js"

export interface Interface {
  readonly semaphore: Effect.Effect<Semaphore.Semaphore | undefined>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentLimit") {}
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const caps = new Map<number, Semaphore.Semaphore>()
    return Service.of({
      semaphore: Effect.gen(function* () {
        const cap = Config.latest(yield* config.entries(), "experimental")?.subagent_concurrency
        if (cap === undefined) return
        const existing = caps.get(cap)
        if (existing) return existing
        const semaphore = Semaphore.makeUnsafe(cap)
        caps.set(cap, semaphore)
        return semaphore
      }),
    })
  }),
)
export const node = makeLocationNode({ service: Service, layer, deps: [Config.node] })
