import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"

type Scenario = "success" | "goal" | "error" | "reject" | "interrupt" | "stream-error"

// Run module mocks in a child so they cannot replace the SDK or CLI runtime in
// other tests. Exercise the real run handler without loading config or a model.
async function exercise(method: "prompt" | "command", scenario: Scenario, format: "json" | "default") {
  const { mock, spyOn } = await import("bun:test")
  const { Effect } = await import("effect")
  const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default
  const interrupt = new AbortController()
  const request = Promise.withResolvers<{ data?: object; error?: object }>()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const idle = Promise.withResolvers<void>()
  const finishGoal = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  let signal: AbortSignal | undefined
  let closed = false
  let finished = false
  let called: string | undefined
  const output: string[] = []
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk))
    return true
  })
  const status = (type: string) => ({ type: "session.status", properties: { sessionID: "session", status: { type } } })
  const goal = (status: string) => ({ type: "goal.updated", properties: { sessionID: "session", goal: { status } } })
  const part = (type: string) => ({
    type: "message.part.updated",
    properties: { part: { type, sessionID: "session", text: "final answer", time: { start: 1, end: 2 } } },
  })
  const submit = (name: string, options?: { signal: AbortSignal }) => {
    called = name
    assert.equal(options?.signal, signal)
    options?.signal.addEventListener("abort", () => request.reject(new Error("request aborted")), { once: true })
    return request.promise
  }
  const client = {
    config: { get: async () => ({ data: { share: "disabled" } }) },
    session: {
      create: async () => ({ data: { id: "session", directory: "/test" } }),
      prompt: (_: unknown, options?: { signal: AbortSignal }) => submit("prompt", options),
      command: (_: unknown, options?: { signal: AbortSignal }) => submit("command", options),
    },
    permission: {
      reply: async (_: unknown, options?: { signal: AbortSignal }) => {
        assert.equal(options?.signal, signal)
        started.resolve()
        await aborted.promise
        throw new Error("permission reply aborted")
      },
    },
    event: {
      subscribe: async (_: unknown, options?: { signal: AbortSignal }) => {
        signal = options?.signal
        signal?.addEventListener("abort", () => aborted.resolve(), { once: true })
        return {
          stream: (async function* () {
            try {
              yield status("busy")
              yield part("step-start")
              if (scenario === "error") {
                yield {
                  type: "permission.asked",
                  properties: { sessionID: "session", id: "permission", permission: "bash", patterns: ["*"] },
                }
              }
              started.resolve()
              await Promise.race([release.promise, aborted.promise])
              if (signal?.aborted) return
              if (scenario === "stream-error") throw new Error("output failed")
              if (scenario === "goal") {
                yield goal("active")
                yield status("idle")
                idle.resolve()
                await Promise.race([finishGoal.promise, aborted.promise])
                if (signal?.aborted) return
                yield status("busy")
              }
              yield part("text")
              yield part("step-finish")
              yield status("idle")
              if (scenario === "goal") yield goal("completed")
              // Like SSE, the source stays open after the session becomes idle.
              await aborted.promise
            } finally {
              closed = true
            }
          })(),
        }
      },
    },
  }
  mock.module("@opencode-ai/sdk/v2", () => ({ createOpencodeClient: () => client }))
  mock.module("@/agent/agent", () => ({ Agent: { Service: Effect.succeed({}) } }))
  mock.module("@/effect/runtime-flags", () => ({ RuntimeFlags: { Service: Effect.succeed({ autoShare: false }) } }))
  mock.module("@/server/auth", () => ({ ServerAuth: { headers: () => undefined } }))
  mock.module("@/cli/cmd/run/runtime", () => ({}))
  mock.module("@/cli/effect-cmd", () => ({
    effectCmd: (options: { handler: (args: unknown) => import("effect").Effect.Effect<void> }) => ({
      handler: (args: unknown) => Effect.runPromise(options.handler(args), { signal: interrupt.signal }),
    }),
  }))
  const { RunCommand } = await import("@/cli/cmd/run")
  const running = Promise.resolve(
    RunCommand.handler({
      message: ["hello"],
      attach: "http://unused.test",
      format,
      ...(method === "command" && { command: "test" }),
    } as Parameters<typeof RunCommand.handler>[0]),
  ).then(
    () => {
      finished = true
    },
    (error: unknown) => {
      finished = true
      return error
    },
  )
  await started.promise
  assert.equal(called, method)
  if (scenario === "interrupt") interrupt.abort()
  else if (scenario === "stream-error") release.resolve()
  else if (scenario === "reject") request.reject(new Error("request failed"))
  else if (scenario === "error") request.resolve({ error: { name: "BadRequest", data: { message: "invalid model" } } })
  else {
    request.resolve({ data: {} })
    // A turn boundary flushes the resolved request; event delivery is still gated.
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(finished, false, "handler returned before final events")
    release.resolve()
    if (scenario === "goal") {
      await Promise.race([idle.promise, running.then(() => assert.fail("handler returned while goal was active"))])
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(finished, false, "idle must not end an active goal")
      finishGoal.resolve()
    }
  }
  const error = await running
  // Interruption releases Effect's caller before the async callback unwinds.
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(signal?.aborted, true, "subscription was not cancelled")
  assert.equal(closed, true, "output iterator was not closed")
  if (scenario === "reject" || scenario === "interrupt" || scenario === "stream-error") assert.ok(error)
  else assert.equal(error, undefined)
  assert.equal(process.exitCode ?? 0, scenario === "error" || scenario === "stream-error" ? 1 : 0)
  if (scenario === "success" || scenario === "goal") {
    if (format === "default") assert.equal(output.join(""), "final answer\n")
    else {
      const events = output
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      assert.deepEqual(
        events.map((event) => event.type),
        ["step_start", "text", "step_finish"],
      )
      assert.equal(events[1].part.text, "final answer")
    }
  }
  if (scenario === "error") assert.ok(output.join("").includes('"type":"error"'))
  process.exitCode = 0
  stdout.mockRestore()
  console.log("passed")
}

for (const method of ["prompt", "command"] as const) {
  for (const [scenario, format] of [
    ["success", "json"],
    ["success", "default"],
    ["goal", "json"],
    ["error", "json"],
    ["reject", "json"],
    ["interrupt", "json"],
    ["stream-error", "json"],
  ] as const) {
    test(`${method}: drains output and cleans up (${scenario}, ${format})`, async () => {
      await using tmp = await tmpdir()
      const proc = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `await (${exercise.toString()})(${JSON.stringify(method)}, ${JSON.stringify(scenario)}, ${JSON.stringify(format)})`,
        ],
        {
          cwd: path.resolve(import.meta.dir, "../../.."),
          env: {
            PATH: process.env.PATH,
            HOME: tmp.path,
            OPENCODE_TEST_HOME: tmp.path,
            XDG_CONFIG_HOME: tmp.path,
            XDG_DATA_HOME: tmp.path,
            XDG_CACHE_HOME: tmp.path,
            XDG_STATE_HOME: tmp.path,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const timeout = setTimeout(() => proc.kill(), 10_000)
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        expect({ code, stderr, stdout }).toEqual({ code: 0, stderr: expect.any(String), stdout: "passed\n" })
      } finally {
        clearTimeout(timeout)
        if (proc.exitCode === null) proc.kill()
      }
    }, 15_000)
  }
}
