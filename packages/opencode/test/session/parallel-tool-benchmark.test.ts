import { describe, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdir } from "node:fs/promises"
import {
  budget,
  fixture,
  rewritePrompt,
  run,
  relay,
  sandboxCommand,
  score,
  settings,
  toolTelemetry,
  type Call,
  type Caps,
  type Fixture,
} from "../../script/bench-parallel-tools"
import { tmpdir } from "../fixture/fixture"

const isolated = process.platform === "darwin" ? test : test.skip

function read(task: Fixture, file: string, turn: number, text = task.files[file]): Call {
  return {
    tool: "read",
    turn,
    startMs: turn * 10,
    endMs: turn * 10 + 1,
    ok: true,
    reads: [{ file, text, ok: true }],
    writes: [],
    output: text,
  }
}

function result(task: Fixture, calls: Call[], files = { ...task.files, ...task.finalFiles }) {
  return score(task, { calls, files, completed: true, answers: [{ text: JSON.stringify(task.expected), ms: 100 }] })
}

describe("parallel tool benchmark scoring (no provider)", () => {
  test("fixtures are reproducible and trials have distinct answers", () => {
    expect(fixture("known-files", 2)).toEqual(fixture("known-files", 2))
    expect(fixture("known-files", 2).expected).not.toEqual(fixture("known-files", 3).expected)
    expect(fixture("dependent-reads").files["pointer.json"]).toBeDefined()
  })

  test("counts necessary evidence, not repeated calls or empty reads", () => {
    const task = fixture("known-files")
    const calls = task.observations.map((item) => read(task, item.file, 0))
    const valid = result(task, calls)
    expect(valid.correct).toBe(true)
    expect(valid.validUniqueNecessaryReads).toBe(4)
    expect(valid.uniqueNecessaryFiles).toBe(4)
    expect(valid.batchWidths).toEqual([4])
    expect(valid.readBatchWidths).toEqual([4])
    expect(valid.timeToCorrectFinalAnswerMs).toBe(100)
    const repeated = result(task, [
      ...calls,
      read(task, "data/amber.json", 1),
      read(task, "data/unused.json", 1),
      read(task, "data/jade.json", 1, ""),
    ])
    expect(repeated.validUniqueNecessaryReads).toBe(4)
    expect(repeated.redundantReads).toBe(1)
    expect(repeated.unnecessaryReads).toBe(1)
    expect(repeated.incompleteReads).toBe(1)
    expect(result(task, calls.slice(0, 3)).correct).toBe(false)
    expect(result(task, calls.slice(0, 3)).timeToCorrectFinalAnswerMs).toBeNull()
  })

  test("ReadMany credits successful files individually, never failed siblings", () => {
    const task = fixture("known-files")
    const calls = task.observations.map((item) => read(task, item.file, 0))
    const combined = { ...calls[0], tool: "read_many", reads: calls.flatMap((call) => call.reads) }
    expect(result(task, [combined]).validUniqueNecessaryReads).toBe(4)
    expect(result(task, [combined]).batchWidths).toEqual([1])
    expect(result(task, [combined]).readBatchWidths).toEqual([4])
    combined.reads[1] = { ...combined.reads[1], ok: false }
    expect(result(task, [combined]).correct).toBe(false)
    expect(result(task, [combined]).validUniqueNecessaryReads).toBe(3)
    expect(result(task, [combined]).readErrors).toBe(1)
  })

  test("discovery must precede dependent reads in a later model turn", () => {
    const task = fixture("discovery")
    const search: Call = {
      tool: "grep",
      turn: 0,
      startMs: 0,
      endMs: 1,
      ok: true,
      reads: [],
      writes: [],
      output: `src/routes.ts: ${task.files["src/routes.ts"]}`,
    }
    const reads = task.observations.slice(2).map((item) => read(task, item.file, 1))
    expect(result(task, [search, ...reads]).correct).toBe(true)
    expect(result(task, reads).dependencyViolations).toBe(2)
    expect(result(task, [search, ...reads.map((call) => ({ ...call, turn: 0 }))]).correct).toBe(false)
    const withoutContext = { ...search, output: "src/routes.ts: BENCH_TARGET = true" }
    expect(result(task, [withoutContext, ...reads]).correct).toBe(false)
    const extraRead = read(task, "src/routes.ts", 1)
    expect(
      result(task, [withoutContext, extraRead, ...reads.map((call) => ({ ...call, turn: 2, startMs: 20, endMs: 21 }))])
        .correct,
    ).toBe(true)
  })

  test("known-looking dependent paths do not excuse speculative batching", () => {
    const task = fixture("dependent-reads")
    const calls = task.observations.map((item, i) => read(task, item.file, i))
    expect(result(task, calls).correct).toBe(true)
    expect(
      result(
        task,
        calls.map((call) => ({ ...call, turn: 0 })),
      ).dependencyViolations,
    ).toBe(1)
    expect(result(task, [{ ...calls[0], ok: false, reads: [] }, calls[1]]).correct).toBe(false)
  })

  test("overlapping edits and merged stages fail even with the right final file", () => {
    const task = fixture("conflicting-edits")
    const edit = (turn: number): Call => ({
      tool: "apply_patch",
      turn,
      startMs: turn * 10,
      endMs: turn * 10 + 1,
      ok: true,
      reads: [],
      writes: ["counter.json"],
      output: "updated",
    })
    const calls = [
      read(task, "counter.json", 0),
      edit(1),
      read(task, "counter.json", 2, '{"value":7}'),
      edit(3),
      read(task, "counter.json", 4, '{"value":21}'),
    ]
    const valid = result(task, calls)
    expect(valid.correct).toBe(true)
    expect(valid.validUniqueNecessaryReads).toBe(3)
    expect(valid.uniqueNecessaryFiles).toBe(1)
    expect(valid.redundantReads).toBe(0)
    const conflicting = result(task, [calls[0], calls[1], calls[2], { ...calls[3], turn: 1 }, calls[4]])
    expect(conflicting.conflictingWritePairs).toBe(1)
    expect(conflicting.correct).toBe(false)
    expect(result(task, [calls[0], calls[1], calls[4]]).correct).toBe(false)
  })

  test("acceptance requires the final answer and intact protected files", () => {
    const task = fixture("known-files")
    const calls = task.observations.map((item) => read(task, item.file, 0))
    expect(result(task, calls, { ...task.files, "data/unused.json": "changed" }).correct).toBe(false)
    expect(
      score(task, {
        calls,
        files: task.files,
        completed: false,
        answers: [{ text: JSON.stringify(task.expected), ms: 1 }],
      }).correct,
    ).toBe(false)
    expect(
      score(task, {
        calls,
        files: task.files,
        completed: true,
        answers: [
          { text: JSON.stringify(task.expected), ms: 1 },
          { text: "not the final answer", ms: 2 },
        ],
      }).correct,
    ).toBe(false)
  })
})

describe("parallel tool benchmark guards (no provider)", () => {
  const caps: Caps = {
    calls: 2,
    callsPerSample: 2,
    inputTokens: 2048,
    outputTokens: 100,
    usd: 0.003,
    walltimeMs: 1000,
    sampleMs: 1000,
  }

  test("reserves cost before dispatch; unknown or failed usage cannot refund attempts", () => {
    const guard = budget(caps, { input: 1, output: 2 })
    expect(guard.reserve(100, 0)).toBeCloseTo(0.001324)
    expect(guard.reserve(100, 1)).toBeCloseTo(0.001324)
    expect(() => guard.reserve(100, 0)).toThrow("call-cap")
    expect(guard.state.calls).toBe(2)
    expect(guard.state.reservedUsd).toBeCloseTo(0.002648)
    expect(() => budget(caps, { input: 10, output: 20 }).reserve(100, 0)).toThrow("spend-cap")
    expect(() => budget(caps, { input: 1, output: 2 }).reserve(2048, 0)).toThrow("input-cap")
    expect(() => budget(caps, { input: 1, output: 2 }).reserve(10, 2)).toThrow("call-cap")
    expect(() => budget(caps, {} as { input: number; output: number })).toThrow("invalid-price-ceiling")
    expect(() => budget(caps, { input: Infinity, output: 1 })).toThrow("invalid-price-ceiling")
    expect(() => budget(caps, { input: Number.MAX_VALUE, output: 1 }).reserve(100, 0)).toThrow("invalid-reservation")
    expect(() => guard.reserve(NaN, 0)).toThrow("invalid-reservation")
    expect(() => guard.reserve(-1, 0)).toThrow("invalid-reservation")
  })

  test("live authorization, snapshot and all price ceilings are explicit", async () => {
    expect(() => settings({ mode: "live" })).toThrow("live-not-authorized")
    expect(() => settings({ mode: "live", allowLive: true })).toThrow("live-requires-snapshot-caps-and-prices")
    await expect(run({ mode: "live" })).rejects.toThrow("live-not-authorized")
    expect(() => settings({ mode: "offline", caps: { calls: NaN } })).toThrow("invalid-calls")
    expect(() => settings({ mode: "offline", caps: { outputTokens: Infinity } })).toThrow("invalid-output-tokens")
    expect(() => settings({ mode: "offline", caps: { walltimeMs: 3600001 } })).toThrow("invalid-walltime")
    expect(() => settings({ mode: "offline", models: [] })).toThrow("invalid-models")
    expect(() => settings({ mode: "offline", only: [] })).toThrow("invalid-fixtures")
    const live = {
      mode: "live" as const,
      allowLive: true,
      caps: { calls: 2, usd: 1 },
      arms: {
        baseline: { prompt: "baseline", readMany: false },
        candidate: { prompt: "candidate", readMany: false, parallelToolCalls: true },
      },
    }
    for (const prices of [{}, { input: 1 }, { output: 1 }, { input: 0, output: 1 }, { input: NaN, output: 1 }]) {
      expect(() => settings({ ...live, prices: prices as { input: number; output: number } })).toThrow(
        "invalid-price-ceiling",
      )
    }
    expect(() => settings({ ...live, caps: { calls: 2, usd: 20.01 }, prices: { input: 1, output: 1 } })).toThrow(
      "invalid-spend-cap",
    )
    expect(settings({ ...live, prices: { input: 1, output: 1 } }).caps.usd).toBe(1)
    expect(() =>
      settings({
        ...live,
        prices: { input: 1, output: 1 },
        arms: { ...live.arms, baseline: { ...live.arms.baseline, parallelToolCalls: false } },
      }),
    ).toThrow("serial-ablation-label-required")
  })

  test("prompt replacement is exact, immutable, and rejects absent or duplicate snapshots", () => {
    const original = {
      input: [{ role: "system", content: [{ type: "input_text", text: "builtin\nenvironment" }] }],
      model: "test",
    }
    const rewritten = rewritePrompt(original, "builtin", "baseline")
    expect(JSON.stringify(rewritten)).toContain("baseline\\nenvironment")
    expect(JSON.stringify(original)).toContain("builtin\\nenvironment")
    expect(() => rewritePrompt(original, "unknown", "baseline")).toThrow("prompt-snapshot-mismatch")
    expect(() => rewritePrompt(["builtin", "builtin"], "builtin", "baseline")).toThrow("prompt-snapshot-mismatch")
  })
})

test("upstream reader errors are cancelled and never escape as raw errors", async () => {
  const stopped: string[] = []
  const secret = "private-upstream-exception-must-not-escape"
  const stream = relay(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(secret))
      },
    }),
    {
      chunk() {},
      finish() {
        throw new Error("flush must not run")
      },
      stop(reason) {
        stopped.push(reason)
      },
    },
  )
  expect(await new Response(stream).text()).toBe("")
  expect(stopped).toEqual(["provider-body-error"])
  expect(JSON.stringify(stopped)).not.toContain(secret)
})

test("tool telemetry separates emissions, invocations, terminals and unknowns", () => {
  const task = fixture("known-files")
  const calls = [
    { ...read(task, "data/amber.json", 0), callID: "read-one", status: "completed", truncated: true },
    {
      ...read(task, "data/cobalt.json", 0),
      callID: "bad-one",
      tool: "invalid",
      status: "error",
      ok: false,
      reads: [],
    },
  ]
  const out = toolTelemetry(
    calls,
    [
      'INFO service=session.timing timing={"phase":"tool","callID":"read-one","tool":"read","status":"completed","durationMs":3,"elapsedMs":10,"requestID":"request-one"} phase',
      "INFO llm.runtime=ai-sdk llm.native_unsupported_reason=private-fallback-detail llm runtime selected",
    ].join("\n"),
    [
      {
        turn: 0,
        calls: [
          { id: "read-one", tool: "read", advertised: true, emittedMs: 0, readyMs: 1 },
          { id: "bad-one", tool: "unadvertised-tool", advertised: false, emittedMs: 0, readyMs: 1 },
          { id: "incomplete-one", tool: "read", advertised: true, emittedMs: 0 },
        ],
      },
    ],
    "native",
  )
  expect(out.emittedToolCalls).toBe(3)
  expect(out.invokedToolCalls).toBe(1)
  expect(out.terminalToolCalls).toBe(2)
  expect(out.unknownToolCalls).toBe(1)
  expect(out.unknownInvocationToolCalls).toBe(2)
  expect(out.unobservedEmittedToolCalls).toBe(1)
  expect(out.tools[0].truncated).toBe(true)
  expect(out.toolDurations[0].callID).toBe(out.tools[0].callID)
  expect(out.toolDurations[0].status).toBe("completed")
  expect(out.runtime.observed).toEqual(["ai-sdk"])
  expect(out.runtime.fallback).toBe(true)
  expect(out.runtime.matched).toBe(false)
  expect(out.runtime.fallbackReasonSha256).toHaveLength(1)
  expect(JSON.stringify(out)).not.toContain("private-fallback-detail")
})

isolated(
  "Seatbelt permits only the proxy endpoint and denies other connections and managed file reads",
  async () => {
    await using temp = await tmpdir()
    const protectedFile = path.join(temp.path, "managed.plist")
    await Bun.write(protectedFile, "synthetic-managed-preference")
    const address =
      Object.values(os.networkInterfaces())
        .flat()
        .find((item) => item && !item.internal && item.family === "IPv4")?.address ?? "127.0.0.1"
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("loopback") })
    const other = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("other") })
    try {
      const nonLoopback = `http://${address}:${other.port}`
      // The target is known reachable without the sandbox; connection-refused from
      // Bun inside Seatbelt must not be confused with an unresponsive remote host.
      expect(await fetch(nonLoopback).then((response) => response.text())).toBe("other")
      const command = sandboxCommand(
        [
          process.execPath,
          "--eval",
          `
      const fs = await import("node:fs");
      const net = await import("node:net");
      const loopback = await fetch(${JSON.stringify(`http://127.0.0.1:${server.port}`)}).then(r => r.text());
      const external = await new Promise(resolve => {
        const socket = net.connect({host:${JSON.stringify(address)},port:${other.port}});
        socket.on("error", e => resolve(e.code));
        socket.setTimeout(1000, () => { socket.destroy(); resolve("unexpected-timeout") });
        socket.on("connect", () => { socket.destroy(); resolve("unexpected-connect") });
      });
      let managed;
      try { fs.readFileSync(${JSON.stringify(protectedFile)}); managed="unexpected-read" } catch (e) { managed=e.code }
      let bind = "blocked";
      try { const s = Bun.serve({hostname:"127.0.0.1", port:0, fetch:()=>new Response()}); bind="allowed"; s.stop(true) } catch {}
      const nested = Bun.spawnSync([process.execPath, "--eval", ${JSON.stringify(`try { await fetch(${JSON.stringify(nonLoopback)}, { signal: AbortSignal.timeout(1000) }); console.log("allowed") } catch { console.log("blocked") }`)}], {timeout: 3000});
      console.log(JSON.stringify({loopback,external,managed,bind,descendant: nested.stdout.toString().trim()}));
    `,
        ],
        server.port,
      )
      expect(command[2]).toContain('(subpath "/Library/Managed Preferences")')
      command[2] += `\n(deny file-read* (literal ${JSON.stringify(protectedFile)}))`
      const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exit).toBe(0)
      expect(stderr).toBe("")
      const result = JSON.parse(stdout)
      expect(result.loopback).toBe("loopback")
      expect(["EPERM", "EACCES", "ECONNREFUSED"]).toContain(result.external)
      expect(["EPERM", "EACCES"]).toContain(result.managed)
      expect(result.bind).toBe("blocked")
      expect(result.descendant).toBe("blocked")
    } finally {
      await server.stop(true)
      await other.stop(true)
    }
  },
  15000,
)

isolated(
  "a dropped upstream socket forwards exactly one attempt and stops the shared run",
  async () => {
    await using temp = await tmpdir()
    let connections = 0
    let forwarded = 0
    const upstream = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {
          connections++
        },
        data(socket) {
          socket.end(
            'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\ndata: {"type":"response.created","response":{"id":"do-not-log-private-stream-data","model":"gpt-6.1-sol"}}\n\n',
          )
        },
      },
    })
    try {
      const output = path.join(temp.path, "drop.jsonl")
      const benchmark = await run({
        mode: "offline",
        models: ["gpt-6.1-sol"],
        only: ["known-files"],
        output,
        async offlineResponse(input) {
          forwarded++
          await input.response.body?.cancel()
          return fetch(`http://127.0.0.1:${upstream.port}`)
        },
      })
      expect(forwarded).toBe(1)
      expect(connections).toBe(1)
      expect(benchmark.complete).toBe(false)
      expect(benchmark.results).toHaveLength(1)
      expect(benchmark.results[0].modelTurns).toBe(1)
      expect(benchmark.results[0].stopReason).toBe("provider-body-error")
      expect(benchmark.results[0].correct).toBe(false)
      const records = (await Bun.file(output).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(records.at(-1).calls).toBe(1)
      expect(JSON.stringify(records)).not.toContain("do-not-log-private-stream-data")
      expect(JSON.stringify(records)).not.toContain(temp.path)
    } finally {
      upstream.stop(true)
    }
  },
  30000,
)

isolated(
  "an inherited managed config cannot override the isolated inline benchmark config",
  async () => {
    await using temp = await tmpdir()
    const managed = path.join(temp.path, "hostile-managed")
    await mkdir(managed)
    const hostile = JSON.stringify({
      provider: { openai: { options: { baseURL: "https://example.invalid", apiKey: "private-managed-key" } } },
      agent: { build: { options: { serviceTier: "invalid-tier" } } },
    })
    await Bun.write(path.join(managed, "opencode.json"), hostile)
    const previous = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
    process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = managed
    try {
      const benchmark = await run({
        mode: "offline",
        output: path.join(temp.path, "managed.jsonl"),
        models: ["gpt-6.1-sol"],
        only: ["known-files"],
      })
      expect(benchmark.results).toHaveLength(2)
      expect(benchmark.results.every((sample) => sample.correct)).toBe(true)
      expect(await Bun.file(path.join(managed, "opencode.json")).text()).toBe(hostile)
      expect(await Bun.file(benchmark.output).text()).not.toContain("private-managed-key")
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
      else process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = previous
    }
  },
  30000,
)

isolated(
  "offline native CLI exercises real tools, both arms and all controls",
  async () => {
    await using temp = await tmpdir()
    const output = path.join(temp.path, "results.jsonl")
    const benchmark = await run({ mode: "offline", output, models: ["gpt-6.1-sol"] })
    expect(benchmark.complete).toBe(true)
    expect(benchmark.results).toHaveLength(8)
    expect(benchmark.results.map((sample) => [sample.fixture, sample.arm, sample.correct, sample.stopReason])).toEqual([
      ["known-files", "baseline", true, null],
      ["known-files", "candidate", true, null],
      ["discovery", "candidate", true, null],
      ["discovery", "baseline", true, null],
      ["dependent-reads", "baseline", true, null],
      ["dependent-reads", "candidate", true, null],
      ["conflicting-edits", "candidate", true, null],
      ["conflicting-edits", "baseline", true, null],
    ])
    expect(benchmark.results[0].modelTurns).toBe(2)
    expect(benchmark.results[0].requests.every((request) => request.parallelToolCalls !== false)).toBe(true)
    expect(benchmark.results[1].modelTurns).toBe(2)
    expect(benchmark.results[1].readBatchWidths).toEqual([4])
    expect(benchmark.results[2].modelTurns).toBe(3)
    expect(benchmark.results[2].validUniqueNecessaryReads).toBe(2)
    expect(benchmark.results[3].modelTurns).toBe(4)
    expect(benchmark.results[3].validUniqueNecessaryReads).toBe(3)
    expect(benchmark.results.every((sample) => sample.runtime.matched)).toBe(true)
    expect(benchmark.results[1].emittedToolCalls).toBe(4)
    expect(benchmark.results[1].invokedToolCalls).toBe(4)
    expect(benchmark.results[1].terminalToolCalls).toBe(4)
    expect(benchmark.results[1].unknownInvocationToolCalls).toBe(0)
    const text = await Bun.file(output).text()
    expect(text).not.toContain(temp.path)
    expect(text).not.toContain('"apiKey"')
    expect(text).not.toContain('"prompt":')
    expect(text).not.toContain('"authorization"')
    expect(text.trim().split("\n")).toHaveLength(10)
    await expect(run({ mode: "offline", output, models: ["gpt-6.1-sol"], only: ["known-files"] })).rejects.toThrow()
  },
  120000,
)

isolated(
  "offline AI SDK uses the same fixture and call guard",
  async () => {
    await using temp = await tmpdir()
    const prompt = await Bun.file(new URL("../../src/session/prompt/gpt.txt", import.meta.url)).text()
    const benchmark = await run({
      mode: "offline",
      output: path.join(temp.path, "sdk.jsonl"),
      runtime: "ai-sdk",
      models: ["gpt-6-astra"],
      only: ["known-files"],
      caps: { callsPerSample: 3 },
      arms: {
        baseline: { prompt, readMany: false, parallelToolCalls: false, ablation: "serial" },
        candidate: { prompt, readMany: false, parallelToolCalls: true },
      },
    })
    expect(benchmark.results[0].correct).toBe(false)
    expect(benchmark.results[0].modelTurns).toBeLessThanOrEqual(3)
    expect(benchmark.results[0].stopReason).toBe("call-cap")
    expect(benchmark.results).toHaveLength(1)
    expect(benchmark.complete).toBe(false)
  },
  60000,
)

isolated(
  "offline ReadMany uses the registered implementation in both runtimes",
  async () => {
    await using temp = await tmpdir()
    const prompt = await Bun.file(new URL("../../src/session/prompt/gpt.txt", import.meta.url)).text()
    for (const runtime of ["native", "ai-sdk"] as const) {
      const benchmark = await run({
        mode: "offline",
        runtime,
        models: ["gpt-6.1-sol"],
        only: ["known-files"],
        output: path.join(temp.path, `${runtime}.jsonl`),
        arms: {
          baseline: { prompt, readMany: false, parallelToolCalls: false, ablation: "serial" },
          candidate: { prompt, readMany: true, parallelToolCalls: true },
        },
      })
      expect(benchmark.results.every((sample) => sample.correct)).toBe(true)
      expect(benchmark.results[1].batchWidths).toEqual([1])
      expect(benchmark.results[1].readBatchWidths).toEqual([4])
      expect(benchmark.results[1].validUniqueNecessaryReads).toBe(4)
      expect(benchmark.results[1].toolSchemaSha256).not.toBe(benchmark.results[0].toolSchemaSha256)
    }
  },
  60000,
)
