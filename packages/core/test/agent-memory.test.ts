import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "node:path"
import { AgentMemory } from "@opencode/core/agent-memory"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Global } from "@opencode/util/global"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const withMemory = <A, E>(run: (memory: AgentMemory.Interface, root: string) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const global = Global.make({
      data: path.join(tmp.path, "data"),
      config: path.join(tmp.path, "config"),
      tmp: tmp.path,
    })
    const current = location({ directory: AbsolutePath.make(path.join(tmp.path, "project")) })
    return yield* Effect.gen(function* () {
      const memory = yield* AgentMemory.Service
      return yield* run(memory, tmp.path)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(AgentMemory.node, [
          Global.node.replace(Layer.succeed(Global.Service, global)),
          Location.node.replace(Layer.succeed(Location.Service, current)),
        ]),
      ),
    )
  })

it.live("keeps user, project and local memory in their existing locations", () =>
  withMemory((memory, root) =>
    Effect.gen(function* () {
      expect(yield* memory.path({ name: "reviewer", scope: "user" })).toBe(path.join(root, "config/memory/reviewer.md"))
      expect(yield* memory.path({ name: "reviewer", scope: "project" })).toBe(
        path.join(root, "project/.opencode/memory/reviewer.md"),
      )
      expect(yield* memory.path({ name: "reviewer", scope: "local" })).toBe(
        path.join(root, "project/.opencode/memory/reviewer.local.md"),
      )
      expect(yield* memory.read({ name: "reviewer", scope: "user" })).toBeUndefined()
      yield* memory.write({ name: "reviewer", scope: "user", text: "Keep facts." })
      expect(yield* memory.read({ name: "reviewer", scope: "user" })).toBe("Keep facts.\n")
      expect(yield* memory.read({ name: "reviewer", scope: "project" })).toBeUndefined()
    }),
  ),
)

it.live("serializes concurrent memory appends and supports replacement", () =>
  withMemory((memory) =>
    Effect.gen(function* () {
      const target = { name: "reviewer", scope: "local" as const }
      yield* Effect.forEach(
        Array.from({ length: 12 }, (_, i) => `fact ${i}`),
        (text) => memory.write({ ...target, text, append: true }),
        { concurrency: "unbounded" },
      )
      const text = yield* memory.read(target)
      expect(new Set(text?.trim().split("\n")).size).toBe(12)
      yield* memory.write({ ...target, text: "replacement" })
      expect(yield* memory.read(target)).toBe("replacement\n")
    }),
  ),
)

it.live("rejects names escaping a memory root and preserves nested agent names", () =>
  withMemory((memory, root) =>
    Effect.gen(function* () {
      for (const name of ["../outside", "/outside", "nested/../outside", "nested\\..\\outside"])
        expect(yield* memory.path({ name, scope: "user" }).pipe(Effect.flip)).toBeInstanceOf(AgentMemory.InvalidName)
      expect(yield* memory.path({ name: "reviewers/security", scope: "user" })).toBe(
        path.join(root, "config/memory/reviewers/security.md"),
      )
    }),
  ),
)
