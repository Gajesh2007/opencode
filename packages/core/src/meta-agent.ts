export * as MetaAgent from "./meta-agent.js"

import { MetaAgent } from "@opencode/schema/meta-agent"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { KV } from "./kv.js"
import { Session } from "./session.js"
import { Model } from "./model.js"
import { KeyedMutex } from "./effect/keyed-mutex.js"

export const Info = MetaAgent.Info
export type Info = MetaAgent.Info
export const Patch = Schema.Struct({
  sessionID: Session.ID,
  enabled: Schema.optionalKey(Schema.Boolean),
  basePrompt: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Model.Ref),
})
const decode = Schema.decodeUnknownOption(Info)
const prefix = "fork.meta-agent/"
export interface Interface {
  readonly get: (id: Session.ID) => Effect.Effect<Info | undefined>
  readonly set: (input: typeof Patch.Type) => Effect.Effect<Info>
  readonly clear: (id: Session.ID) => Effect.Effect<void>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/MetaAgent") {}
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const lock = yield* KeyedMutex.make<Session.ID>()
    const get = (id: Session.ID) =>
      kv.get(prefix + id).pipe(Effect.map((value) => Option.getOrUndefined(decode(value))))
    return Service.of({
      get,
      set: (input) =>
        lock.withLock(input.sessionID)(
          Effect.gen(function* () {
            const previous = yield* get(input.sessionID)
            const value: Info = {
              sessionID: input.sessionID,
              enabled: input.enabled ?? previous?.enabled ?? true,
              basePrompt: input.basePrompt ?? previous?.basePrompt ?? "",
              model: input.model ?? previous?.model,
            }
            yield* kv.set(prefix + input.sessionID, value)
            return value
          }),
        ),
      clear: (id) => lock.withLock(id)(kv.remove(prefix + id)),
    })
  }),
)
export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node] })
