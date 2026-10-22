import { expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { run } from "../../script/bench-agent-tasks"
import { it } from "../lib/effect"

it.live(
  "offline agent tasks exercise the CLI and retain objective phase evidence",
  () =>
    Effect.promise(async () => {
      const result = await run({ mode: "fixture" })
      expect(result.results).toHaveLength(4)
      for (const task of result.results) {
        expect(task.accepted).toBe(true)
        expect(task.requests).toBe(4)
        expect(task.phaseCoverage).toBe(true)
        expect(task.durationMs).toBeGreaterThan(0)
        expect(task.phases.filter((r) => r.phase === "tool")).toHaveLength(3)
        expect(
          task.phases.every((r) => (r.durationMs === undefined || r.durationMs >= 0) && r.stepID && r.sessionID),
        ).toBe(true)
        expect(await Bun.file(path.join(task.directory, "acceptance.log")).exists()).toBe(true)
      }
    }),
  120_000,
)

it.live(
  "failed acceptance remains a failed retained benchmark sample",
  () =>
    Effect.promise(async () => {
      const result = await run({ mode: "fixture", only: "small-fix", fixtureFailure: true })
      expect(result.results[0].accepted).toBe(false)
      expect(result.results[0].acceptanceExitCode).not.toBe(0)
      const report = await Bun.file(path.join(result.output, "results.json")).json()
      expect(report.accepted).toBe(0)
      expect(report.results).toHaveLength(1)
      expect(await Bun.file(path.join(result.results[0].directory, "stdout.jsonl")).exists()).toBe(true)
    }),
  60_000,
)

it.live("live calls require explicit configuration and model", () =>
  Effect.promise(async () => {
    await expect(run({ mode: "live" })).rejects.toThrow("Live mode requires")
    await expect(run({ mode: "fixture", only: "unknown" })).rejects.toThrow("Unknown task")
    await expect(run({ mode: "fixture", timeoutMs: NaN })).rejects.toThrow("Timeout must be")
    await expect(run({ mode: "fixture", binary: "./opencode" })).rejects.toThrow("absolute file path")
    await expect(
      run({ mode: "fixture", binary: path.join(import.meta.dir, "missing-opencode-binary") }),
    ).rejects.toThrow("file does not exist")
    const invalid = Bun.spawnSync(
      [process.execPath, path.resolve(import.meta.dir, "../../script/bench-agent-tasks.ts"), "--binary", "./opencode"],
      { env: process.env },
    )
    expect(invalid.exitCode).not.toBe(0)
    expect(invalid.stderr.toString()).toContain("--binary must be an absolute file path")
  }),
)
