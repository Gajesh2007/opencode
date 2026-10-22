import { once } from "node:events"
import { createInterface } from "node:readline"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Auth } from "../../../src/auth"

const mode = process.argv[2]
const info: Auth.Info = JSON.parse(process.argv[3])
const key = "openai-codex"
const lines = createInterface({ input: process.stdin })
const run = Effect.runPromise
const layer =
  mode === "concurrent"
    ? Auth.layer.pipe(
        Layer.provide(
          Layer.effect(
            AppFileSystem.Service,
            Effect.gen(function* () {
              const fs = yield* AppFileSystem.Service
              return AppFileSystem.Service.of({
                ...fs,
                // Simulate slow file I/O after reading, widening lost-update races.
                readJson: (file) => fs.readJson(file).pipe(Effect.tap(() => Effect.sleep("20 millis"))),
              })
            }),
          ).pipe(Layer.provide(AppFileSystem.defaultLayer)),
        ),
        Layer.provide(EffectFlock.defaultLayer),
      )
    : Auth.defaultLayer
const auth = await run(Auth.Service.pipe(Effect.provide(layer)))

if (mode === "stale") {
  await run(auth.set(key, info))
  const expected = Auth.fingerprint(await run(auth.get(key)))
  const resume = once(lines, "line")
  process.stdout.write("ready\n")
  await resume
  const fresh = Auth.fingerprint(await run(auth.get(key)))
  const staleResult = await run(auth.set(key, info, expected).pipe(Effect.result))
  const freshResult = await run(auth.set(key, info, fresh).pipe(Effect.result))
  process.stdout.write(
    JSON.stringify({
      staleRejected: staleResult._tag === "Failure",
      freshRejected: freshResult._tag === "Failure",
    }) + "\n",
  )
}

if (mode === "set" || mode === "remove") {
  await run(auth.set(key, info))
  if (mode === "remove") await run(auth.remove(key))
  process.stdout.write("written\n")
}

if (mode === "unrelated") {
  const other = { type: "oauth" as const, access: "other-access", refresh: "other-refresh", expires: 0 }
  await run(auth.set(key, info))
  await run(auth.set("other-provider", other))
  const expected = Auth.fingerprint(await run(auth.get("other-provider")))
  const resume = once(lines, "line")
  process.stdout.write("ready\n")
  await resume
  const result = await run(
    auth.set("other-provider", { ...other, access: "other-refreshed" }, expected).pipe(Effect.result),
  )
  process.stdout.write(JSON.stringify({ updated: result._tag === "Success" }) + "\n")
}

if (mode === "concurrent") {
  const resume = once(lines, "line")
  process.stdout.write("ready\n")
  await resume
  for (let index = 0; index < 4; index++) {
    await run(auth.set(`${process.argv[4]}-${index}`, info))
  }
  process.stdout.write("written\n")
}

lines.close()
