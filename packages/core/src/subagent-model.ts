export * as SubagentModel from "./subagent-model.js"

import { Context, Effect, Layer, Option, Schema } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { KV } from "./kv.js"
import { Model } from "./model.js"
import { KeyedMutex } from "./effect/keyed-mutex.js"

const Models = Schema.Record(Schema.String, Model.Ref)
const decode = Schema.decodeUnknownOption(Models)
const key = "fork.subagent-models"
export interface Interface {
  readonly list: Effect.Effect<typeof Models.Type>
  readonly set: (agent: string, model?: Model.Ref) => Effect.Effect<void>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentModel") {}
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const lock = yield* KeyedMutex.make<string>()
    const list = kv.get(key).pipe(Effect.map((value) => Option.getOrElse(decode(value), () => ({}))))
    return Service.of({
      list,
      set: (agent, model) =>
        lock.withLock(key)(
          Effect.gen(function* () {
            const current = { ...(yield* list) }
            if (model) current[agent] = model
            else delete current[agent]
            yield* kv.set(key, current)
          }),
        ),
    })
  }),
)
export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node] })
