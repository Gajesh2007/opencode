import { describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database, sql } from "@/storage/db"
import { it } from "../lib/effect"

describe("Database.getChannelPath", () => {
  it.effect("returns database path for the current channel", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const expected = ["latest", "beta", "prod"].includes(InstallationChannel)
        ? path.join(Global.Path.data, "opencode.db")
        : path.join(Global.Path.data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)

      expect(Database.getChannelPath(flags)).toBe(expected)
    }).pipe(Effect.provide(RuntimeFlags.layer())),
  )

  it.effect("uses the shared database path when channel databases are disabled", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(Database.getChannelPath(flags)).toBe(path.join(Global.Path.data, "opencode.db"))
    }).pipe(Effect.provide(RuntimeFlags.layer({ disableChannelDb: true }))),
  )

  it.effect("accepts RuntimeFlags with skipMigrations for database callers", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(flags.skipMigrations).toBe(true)
      expect(Database.getChannelPath(flags)).toBe(Database.getChannelPath({ disableChannelDb: flags.disableChannelDb }))
    }).pipe(Effect.provide(RuntimeFlags.layer({ skipMigrations: true }))),
  )
})

describe("Database.Client", () => {
  it.live("cached queries do not rebuild unrelated runtime configuration", () =>
    Effect.gen(function* () {
      const client = Database.Client()
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = process.env.OPENCODE_AUTO_SHARE
          process.env.OPENCODE_AUTO_SHARE = "not-a-boolean"
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.OPENCODE_AUTO_SHARE
            else process.env.OPENCODE_AUTO_SHARE = previous
          }),
      )
      expect(Database.Client()).toBe(client)
      expect(Database.use((db) => db.get<{ value: number }>(sql`select 1 as value`))).toEqual({ value: 1 })
    }),
  )

  const bench = process.env.OPENCODE_BENCH_DATABASE ? it.live : it.live.skip
  bench(
    "benchmark warm database queries",
    () =>
      Effect.gen(function* () {
        Database.Client()
        const samples: number[] = []
        for (let run = 0; run < 5; run++) {
          const start = performance.now()
          for (let index = 0; index < 1000; index++) Database.use((db) => db.get(sql`select 1 as value`))
          samples.push((performance.now() - start) / 1000)
        }
        console.log(
          JSON.stringify({ benchmark: "database-warm-query", medianMs: samples.toSorted((a, b) => a - b)[2] }),
        )
      }),
    { timeout: 30_000 },
  )
})
