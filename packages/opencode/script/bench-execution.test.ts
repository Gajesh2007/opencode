import { expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Config } from "../src/config/config"
import { Agent } from "../src/agent/agent"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { Plugin } from "../src/plugin"
import { Ripgrep } from "../src/file/ripgrep"
import { Snapshot } from "../src/snapshot"
import { ShellTool } from "../src/tool/shell"
import { Truncate } from "../src/tool/truncate"
import { MessageID, SessionID } from "../src/session/schema"
import { TestInstance } from "../test/fixture/fixture"
import { testEffect } from "../test/lib/effect"

// Opt-in, offline benchmark of actual services. Fixture creation and warmup are not timed.
// BENCH_EXECUTION=1 bun test ./script/bench-execution.test.ts --timeout 120000
const it = testEffect(
  Layer.mergeAll(
    Snapshot.defaultLayer,
    Ripgrep.defaultLayer,
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Config.defaultLayer,
    Agent.defaultLayer,
    RuntimeFlags.defaultLayer,
    Plugin.defaultLayer,
    Truncate.defaultLayer,
  ),
)

const measure = Effect.fnUntraced(function* <A, E, R>(name: string, work: Effect.Effect<A, E, R>) {
  yield* Effect.sync(() => Bun.gc(true))
  const rss = process.memoryUsage().rss
  let peak = rss
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss)
  }, 5)
  const start = performance.now()
  const result = yield* work.pipe(Effect.ensuring(Effect.sync(() => clearInterval(timer))))
  peak = Math.max(peak, process.memoryUsage().rss)
  console.log(
    JSON.stringify({
      name,
      ms: +(performance.now() - start).toFixed(2),
      peakRssMiB: +(peak / 2 ** 20).toFixed(2),
      rssGrowthMiB: +((peak - rss) / 2 ** 20).toFixed(2),
      maxRssMiB: +(process.resourceUsage().maxRSS / (process.platform === "darwin" ? 2 ** 20 : 1024)).toFixed(2),
    }),
  )
  return result
})

if (process.env.BENCH_EXECUTION) {
  it.instance("truncation of one million lines", () =>
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const trunc = yield* Truncate.Service
      const text = "1234567890\n".repeat(1_000_000)
      yield* trunc.output("warmup")
      for (let trial = 0; trial < 3; trial++) {
        const sample = `${trial}:${text}`
        const result = yield* measure("truncate-million-lines", trunc.output(sample))
        if (!result.truncated) throw new Error("expected truncation")
        expect(result.content).toContain("998001 lines truncated")
        expect(Number((yield* fs.stat(result.outputPath)).size)).toBe(Buffer.byteLength(sample))
        yield* fs.remove(result.outputPath)
      }
    }),
  )

  it.instance(
    "snapshot clean and single-file dirty steps",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const fs = yield* AppFileSystem.Service
        const snapshot = yield* Snapshot.Service
        yield* Effect.forEach(
          Array.from({ length: 1000 }, (_, i) => i),
          (i) => fs.writeFileString(path.join(tmp.directory, `file-${i}.txt`), "initial\n"),
          { concurrency: 16 },
        )
        const hash = yield* snapshot.track()
        expect(hash).toBeTruthy()
        for (let trial = 0; trial < 3; trial++) {
          yield* measure(
            "snapshot-clean-25",
            Effect.forEach(Array.from({ length: 25 }), () =>
              snapshot.track().pipe(Effect.tap((next) => Effect.sync(() => expect(next).toBe(hash)))),
            ),
          )
          yield* measure(
            "snapshot-dirty-25",
            Effect.forEach(
              Array.from({ length: 25 }, (_, i) => i),
              (i) =>
                fs
                  .writeFileString(path.join(tmp.directory, "file-0.txt"), `${trial}-${i}\n`)
                  .pipe(Effect.andThen(snapshot.track())),
            ),
          )
          yield* fs.writeFileString(path.join(tmp.directory, "file-0.txt"), "initial\n")
          yield* snapshot.track()
        }
      }),
    { git: true },
  )

  it.instance("shell 16 MiB with a 1 ms metadata consumer", () =>
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const tool = yield* ShellTool
      const shell = yield* tool.init()
      const size = 16 * 1024 * 1024
      const context = {
        sessionID: SessionID.make("ses_bench"),
        messageID: MessageID.make("msg_bench"),
        callID: "",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        ask: () => Effect.void,
        metadata: () => Effect.sleep("1 millis"),
      }
      yield* shell.execute({ command: "true", description: "warmup" }, context)
      for (let trial = 0; trial < 3; trial++) {
        let updates = 0
        const result = yield* measure(
          "shell-16MiB",
          shell.execute(
            {
              command: `"${process.execPath}" -e 'const b=Buffer.alloc(65536,97);for(let i=0;i<256;i++)await Bun.write(Bun.stdout,b)'`,
              description: "emit 16 MiB",
            },
            {
              ...context,
              metadata: () =>
                Effect.sleep("1 millis").pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      updates++
                    }),
                  ),
                ),
            },
          ),
        )
        const file = result.metadata.outputPath
        if (typeof file !== "string") throw new Error("missing full output")
        const stat = yield* fs.stat(file)
        console.log(
          JSON.stringify({ name: "shell-correctness", updates, expectedBytes: size, savedBytes: Number(stat.size) }),
        )
        expect(Number(stat.size)).toBe(size)
        yield* fs.remove(file)
      }
    }),
  )

  it.instance("file traversal with a slow limited consumer", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const rg = yield* Ripgrep.Service
      yield* Effect.forEach(
        Array.from({ length: 20000 }, (_, i) => i),
        (i) => fs.writeFileString(path.join(tmp.directory, `file-${i}.txt`), ""),
        { concurrency: 32 },
      )
      for (let trial = 0; trial < 3; trial++) {
        const result = yield* measure(
          "traversal-take-101",
          rg.files({ cwd: tmp.directory }).pipe(
            Stream.mapEffect((file) => Effect.sleep("1 millis").pipe(Effect.as(file))),
            Stream.take(101),
            Stream.runCollect,
          ),
        )
        expect(result.length).toBe(101)
      }
    }),
  )
}
