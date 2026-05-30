import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Global } from "@opencode-ai/core/global"
import { InstanceState } from "@/effect/instance-state"
import { Context, Effect, Layer } from "effect"
import path from "path"

/**
 * Per-agent persistent memory, modeled on Claude Code's agent `memory` field.
 *
 * An agent declares `memory: "user" | "project" | "local"` and gets a markdown
 * store that is (a) read fresh into its context each turn and (b) writable via
 * the `memory` tool, so durable facts persist across sessions. Scopes:
 *   - user    → ~/.config/opencode/memory/<agent>.md   (global to the user)
 *   - project → <dir>/.opencode/memory/<agent>.md      (checked into the repo)
 *   - local   → <dir>/.opencode/memory/<agent>.local.md (gitignored)
 *
 * The service takes the agent name + scope rather than depending on Agent.Service,
 * to avoid an Agent ↔ Memory layer cycle. Reads always hit disk (never the cached
 * agent definition) so external edits and cross-session writes are reflected.
 */
export type Scope = "user" | "project" | "local"

export interface Interface {
  readonly path: (input: { name: string; scope: Scope }) => Effect.Effect<string>
  readonly read: (input: { name: string; scope: Scope }) => Effect.Effect<string | undefined>
  readonly append: (input: { name: string; scope: Scope; text: string }) => Effect.Effect<void>
  readonly write: (input: { name: string; scope: Scope; text: string }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Memory") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const resolve = Effect.fn("Memory.path")(function* (input: { name: string; scope: Scope }) {
      if (input.scope === "user") return path.join(Global.Path.config, "memory", `${input.name}.md`)
      const ctx = yield* InstanceState.context
      const file = input.scope === "local" ? `${input.name}.local.md` : `${input.name}.md`
      // project/local memory lives in the project's .opencode dir (same place agents
      // are defined). Use the instance directory, which is the project root in practice.
      return path.join(ctx.directory, ".opencode", "memory", file)
    })

    return Service.of({
      path: resolve,
      read: Effect.fn("Memory.read")(function* (input: { name: string; scope: Scope }) {
        const content = yield* fs
          .readFileStringSafe(yield* resolve(input))
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        return content?.trim() ? content : undefined
      }),
      append: Effect.fn("Memory.append")(function* (input: { name: string; scope: Scope; text: string }) {
        const file = yield* resolve(input)
        const existing =
          (yield* fs.readFileStringSafe(file).pipe(Effect.catch(() => Effect.succeed(undefined)))) ?? ""
        const next = existing.trim() ? existing.trimEnd() + "\n" + input.text.trim() + "\n" : input.text.trim() + "\n"
        yield* fs.writeWithDirs(file, next).pipe(Effect.orDie)
      }),
      write: Effect.fn("Memory.write")(function* (input: { name: string; scope: Scope; text: string }) {
        yield* fs.writeWithDirs(yield* resolve(input), input.text.trim() + "\n").pipe(Effect.orDie)
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

export * as Memory from "./memory"
