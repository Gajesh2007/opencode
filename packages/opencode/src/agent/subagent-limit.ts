import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Context, Effect, Layer, Semaphore } from "effect"

/** Unlimited unless explicitly capped by config or OPENCODE_SUBAGENT_CONCURRENCY. */
export const DEFAULT_CONCURRENCY = Infinity

export interface Interface {
  /** The resolved cap (Infinity when unlimited), read lazily inside an instance. */
  readonly cap: Effect.Effect<number>
  /** Run `effect` once a permit is available, releasing it on completion. */
  readonly withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentLimit") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const config = yield* Config.Service
    // Resolve lazily, not at layer construction: config.get() needs an active
    // InstanceRef which isn't available when layers are built. Effect.cached
    // runs this exactly once (process-wide) and shares any configured semaphore
    // across all subagent work. The unlimited default needs no semaphore.
    const resolved = yield* Effect.cached(
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const cap = Math.max(
          1,
          Math.floor(flags.subagentConcurrency ?? cfg.experimental?.subagent_concurrency ?? DEFAULT_CONCURRENCY),
        )
        return { cap, semaphore: cap === Infinity ? undefined : Semaphore.makeUnsafe(cap) }
      }),
    )
    return Service.of({
      cap: resolved.pipe(Effect.map((r) => r.cap)),
      withPermit: (effect) =>
        resolved.pipe(Effect.flatMap((r) => (r.semaphore ? r.semaphore.withPermits(1)(effect) : effect))),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(RuntimeFlags.defaultLayer))

export * as SubagentLimit from "./subagent-limit"
