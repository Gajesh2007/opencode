import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Memory } from "@/memory/memory"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Memory.defaultLayer)

afterEach(async () => {
  await disposeAllInstances()
})

describe("memory", () => {
  it.instance("project scope writes, reads, and appends under .opencode/memory", () =>
    Effect.gen(function* () {
      const mem = yield* Memory.Service
      const file = yield* mem.path({ name: "scout", scope: "project" })
      expect(file.endsWith(path.join(".opencode", "memory", "scout.md"))).toBe(true)

      expect(yield* mem.read({ name: "scout", scope: "project" })).toBeUndefined()
      yield* mem.write({ name: "scout", scope: "project", text: "remember: use bun" })
      expect(yield* mem.read({ name: "scout", scope: "project" })).toContain("use bun")

      yield* mem.append({ name: "scout", scope: "project", text: "also: run tests from package dir" })
      const after = yield* mem.read({ name: "scout", scope: "project" })
      expect(after).toContain("use bun")
      expect(after).toContain("package dir")
    }),
  )

  it.instance("local scope is a distinct .local.md file", () =>
    Effect.gen(function* () {
      const mem = yield* Memory.Service
      const file = yield* mem.path({ name: "scout", scope: "local" })
      expect(file.endsWith(path.join(".opencode", "memory", "scout.local.md"))).toBe(true)

      yield* mem.write({ name: "scout", scope: "local", text: "machine-local note" })
      expect(yield* mem.read({ name: "scout", scope: "local" })).toContain("machine-local")
      // project scope is independent of local
      expect(yield* mem.read({ name: "scout", scope: "project" })).toBeUndefined()
    }),
  )
})
