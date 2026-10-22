import { describe, expect } from "bun:test"
import path from "node:path"
import { rename, utimes } from "node:fs/promises"
import { Deferred, Effect, Fiber, Layer, Option } from "effect"
import { Auth } from "../../src/auth"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Auth.defaultLayer, node))

describe("Auth", () => {
  it.live("refreshes initially unpersisted env providers independently without resurrecting aliases", () => {
    const previous = process.env.OPENCODE_AUTH_CONTENT
    const initial = { type: "oauth" as const, access: "initial-access", refresh: "initial-refresh", expires: 0 }
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      "initial-env-first": initial,
      "initial-env-second": initial,
      "initial-env-alias/": initial,
    })
    return Effect.gen(function* () {
      const auth = yield* Auth.Service
      const first = Auth.fingerprint(yield* auth.get("initial-env-first"))
      const second = Auth.fingerprint(yield* auth.get("initial-env-second"))
      yield* auth.set("initial-env-first", { ...initial, access: "first-refreshed" }, first)
      expect(Auth.fingerprint(yield* auth.get("initial-env-second"))).toBe(second)
      yield* auth.remove("initial-env-alias/")
      yield* auth.set("initial-env-second", { ...initial, access: "second-refreshed" }, second)
      expect(yield* auth.get("initial-env-first")).toMatchObject({ access: "first-refreshed" })
      expect(yield* auth.get("initial-env-second")).toMatchObject({ access: "second-refreshed" })
      expect(yield* auth.get("initial-env-alias/")).toBeUndefined()
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
          else process.env.OPENCODE_AUTH_CONTENT = previous
        }),
      ),
    )
  })

  it.live("preserves unrelated revisions and rejects account-switch ABA", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const original = { type: "oauth" as const, access: "revision-a", refresh: "refresh-a", expires: 0 }
      yield* auth.set("revision-account", original)
      const snapshot = yield* auth.get("revision-account")
      yield* auth.set("unrelated-revision", { type: "api", key: "unrelated" })
      yield* auth.set("revision-account", original, Auth.fingerprint(snapshot))
      const beforeSwitch = yield* auth.get("revision-account")
      yield* auth.set("revision-account", { ...original, access: "revision-b" })
      yield* auth.set("revision-account", original)
      const stale = yield* auth.set("revision-account", original, Auth.fingerprint(beforeSwitch)).pipe(Effect.result)
      expect(stale._tag).toBe("Failure")
      const unbound = yield* auth.set("revision-account", original, Auth.fingerprint(original)).pipe(Effect.result)
      expect(unbound._tag).toBe("Failure")
      yield* auth.remove("revision-account")
      yield* auth.remove("unrelated-revision")
    }),
  )

  it.live("serializes concurrent writers without dropping other providers", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const keys = Array.from({ length: 6 }, (_, index) => `concurrent-auth-${index}`)
      yield* Effect.all(
        keys.map((key) => auth.set(key, { type: "api", key })),
        { concurrency: "unbounded" },
      )
      const data = yield* auth.all()
      for (const key of keys) expect(data[key]).toMatchObject({ type: "api", key })
      yield* Effect.all(
        keys.map((key) => auth.remove(key)),
        { concurrency: "unbounded" },
      )
    }),
  )

  it.live("rejects a paused conditional persistence after another writer switches accounts", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const key = "conditional-account"
      const original = { type: "oauth" as const, access: "old-access", refresh: "old-refresh", expires: 0 }
      yield* auth.set(key, original)
      const expected = Auth.fingerprint(yield* auth.get(key))
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const pending = yield* Effect.gen(function* () {
        yield* Deferred.succeed(ready, undefined)
        yield* Deferred.await(release)
        return yield* auth.set(key, { ...original, access: "refreshed-access" }, expected).pipe(Effect.result)
      }).pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      yield* auth.set(key, { ...original, access: "other-account", refresh: "other-refresh" })
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(pending)
      expect(result._tag).toBe("Failure")
      expect(yield* auth.get(key)).toMatchObject({ access: "other-account", refresh: "other-refresh" })
      yield* auth.remove(key)
    }),
  )

  it.live("reads repeated refreshes from the persisted overlay of an immutable environment snapshot", () => {
    const previous = process.env.OPENCODE_AUTH_CONTENT
    const original = { type: "oauth" as const, access: "env-access", refresh: "env-refresh", expires: 0 }
    const snapshot = JSON.stringify({ "environment-account": original })
    process.env.OPENCODE_AUTH_CONTENT = snapshot
    return Effect.gen(function* () {
      const auth = yield* Auth.Service
      expect(yield* auth.get("environment-account")).toEqual(original)
      yield* auth.set(
        "environment-account",
        { ...original, access: "first-refresh" },
        Auth.fingerprint(yield* auth.get("environment-account")),
      )
      expect(process.env.OPENCODE_AUTH_CONTENT).toBe(snapshot)
      const refreshed = yield* auth.get("environment-account")
      expect(refreshed).toMatchObject({ access: "first-refresh" })
      yield* auth.set("environment-account", { ...original, access: "second-refresh" }, Auth.fingerprint(refreshed))
      yield* auth.set("another-provider", { type: "api", key: "other-key" })
      expect(yield* auth.get("environment-account")).toMatchObject({ access: "second-refresh" })
      const reloaded = yield* Auth.Service.pipe(Effect.provide(Auth.defaultLayer))
      expect(yield* reloaded.get("environment-account")).toMatchObject({ access: "second-refresh" })
      delete process.env.OPENCODE_AUTH_CONTENT
      yield* reloaded.set("environment-account", {
        ...original,
        access: "external-account",
        refresh: "external-refresh",
      })
      process.env.OPENCODE_AUTH_CONTENT = snapshot
      expect(yield* auth.get("environment-account")).toMatchObject({
        access: "external-account",
        refresh: "external-refresh",
      })
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
        "environment-account": { ...original, access: "new-env-account" },
      })
      expect(yield* auth.get("environment-account")).toMatchObject({ access: "new-env-account" })
      const stale = yield* auth.set("environment-account", original, Auth.fingerprint(refreshed)).pipe(Effect.result)
      expect(stale._tag).toBe("Failure")
      yield* auth.remove("environment-account")
      expect(yield* auth.get("environment-account")).toBeUndefined()
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
          else process.env.OPENCODE_AUTH_CONTENT = previous
        }),
      ),
    )
  })

  it.live("moves persisted OpenAI OAuth credentials to Codex subscription", () => {
    const previous = process.env.OPENCODE_AUTH_CONTENT
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: { type: "oauth", refresh: "refresh", access: "access", expires: 1 },
    })
    return Effect.gen(function* () {
      const data = yield* (yield* Auth.Service).all()
      expect(data.openai).toBeUndefined()
      expect(data["openai-codex"]).toMatchObject({ type: "oauth", refresh: "refresh" })
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
          else process.env.OPENCODE_AUTH_CONTENT = previous
        }),
      ),
    )
  })

  it.live("set normalizes trailing slashes in keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com/", {
          type: "wellknown",
          key: "TOKEN",
          token: "abc",
        })
        const data = yield* auth.all()
        expect(data["https://example.com"]).toBeDefined()
        expect(data["https://example.com/"]).toBeUndefined()
      }),
    ),
  )

  it.live("set cleans up pre-existing trailing-slash entry", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com/", {
          type: "wellknown",
          key: "TOKEN",
          token: "old",
        })
        yield* auth.set("https://example.com", {
          type: "wellknown",
          key: "TOKEN",
          token: "new",
        })
        const data = yield* auth.all()
        const keys = Object.keys(data).filter((key) => key.includes("example.com"))
        expect(keys).toEqual(["https://example.com"])
        const entry = data["https://example.com"]!
        expect(entry.type).toBe("wellknown")
        if (entry.type === "wellknown") expect(entry.token).toBe("new")
      }),
    ),
  )

  it.live("remove deletes both trailing-slash and normalized keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com", {
          type: "wellknown",
          key: "TOKEN",
          token: "abc",
        })
        yield* auth.remove("https://example.com/")
        const data = yield* auth.all()
        expect(data["https://example.com"]).toBeUndefined()
        expect(data["https://example.com/"]).toBeUndefined()
      }),
    ),
  )

  it.live("set and remove are no-ops on keys without trailing slashes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("anthropic", {
          type: "api",
          key: "sk-test",
        })
        const data = yield* auth.all()
        expect(data["anthropic"]).toBeDefined()
        yield* auth.remove("anthropic")
        const after = yield* auth.all()
        expect(after["anthropic"]).toBeUndefined()
      }),
    ),
  )

  it.live("serves settled credentials without the file lock and still sees replacements", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const file = path.join(Global.Path.data, "auth.json")
        yield* auth.set("cached-provider", { type: "api", key: "first" })
        // Age the file past the settle window, as a long-running session sees it.
        const settle = () =>
          Effect.promise(() => utimes(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000)))
        yield* settle()
        expect(yield* auth.get("cached-provider")).toMatchObject({ key: "first" })

        // Another process holds the lock (e.g. mid refresh): settled reads must not wait on it.
        const held = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const holder = yield* EffectFlock.Service.use((flock) =>
          flock.withLock(
            Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
            "auth.json",
            path.join(Global.Path.data, ".auth-locks"),
          ),
        ).pipe(Effect.provide(EffectFlock.defaultLayer), Effect.forkChild)
        yield* Deferred.await(held)
        const read = yield* auth.get("cached-provider").pipe(Effect.timeoutOption("1 second"))
        expect(Option.getOrUndefined(read)).toMatchObject({ key: "first" })
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(holder)

        // Writers replace the file atomically; a new file is re-read even when settled.
        const temporary = `${file}.replacement`
        yield* Effect.promise(() =>
          Bun.write(temporary, JSON.stringify({ "cached-provider": { type: "api", key: "second" } })),
        )
        yield* Effect.promise(() => rename(temporary, file))
        yield* settle()
        expect(yield* auth.get("cached-provider")).toMatchObject({ key: "second" })
      }),
    ),
  )

  it.live("re-reads a same-size rewrite inside the settle window", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const file = path.join(Global.Path.data, "auth.json")
        const content = (key: string) => JSON.stringify({ "cached-provider": { type: "api", key } })
        yield* Effect.promise(() => Bun.write(file, content("aaaa")))
        expect(yield* auth.get("cached-provider")).toMatchObject({ key: "aaaa" })
        // In place, same length, likely within the same millisecond: identity can't tell.
        yield* Effect.promise(() => Bun.write(file, content("bbbb")))
        expect(yield* auth.get("cached-provider")).toMatchObject({ key: "bbbb" })
      }),
    ),
  )
})
