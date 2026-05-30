import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Context, Effect, Layer, Semaphore } from "effect"

/**
 * Default maximum number of subagent sessions allowed to run concurrently.
 *
 * opencode historically ran subagent fan-out (the `task` tool, and now the
 * `workflow` engine) with NO cap — every parallel tool call forked its own
 * session immediately. That is fine for a handful of agents but melts down at
 * the "review every file with N reviewers" scale this is built for. We gate the
 * actual subagent work behind a single shared semaphore so thousands of queued
 * units drain through a bounded window instead of stampeding the provider.
 *
 * 200 (up from Claude Code's default of 10) is deliberately aggressive: the
 * flagship use case is reviewing thousands of files concurrently. Override with
 * `experimental.subagent_concurrency` in config or `OPENCODE_SUBAGENT_CONCURRENCY`.
 */
export const DEFAULT_CONCURRENCY = 200

export interface Interface {
  /** The resolved concurrency cap. An Effect because config is read lazily inside an instance. */
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
    // runs this exactly once (process-wide) and shares the resulting semaphore,
    // so the cap is a single global gate across the task tool and the engine.
    const resolved = yield* Effect.cached(
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const cap = Math.max(
          1,
          Math.floor(flags.subagentConcurrency ?? cfg.experimental?.subagent_concurrency ?? DEFAULT_CONCURRENCY),
        )
        return { cap, semaphore: Semaphore.makeUnsafe(cap) }
      }),
    )
    return Service.of({
      cap: resolved.pipe(Effect.map((r) => r.cap)),
      withPermit: (effect) => resolved.pipe(Effect.flatMap((r) => r.semaphore.withPermits(1)(effect))),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(RuntimeFlags.defaultLayer))

export * as SubagentLimit from "./subagent-limit"
