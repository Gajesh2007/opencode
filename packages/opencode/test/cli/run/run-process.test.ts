// Subprocess integration tests for `opencode run` (non-interactive mode).
// These exercise the real CLI binary against a TestLLMServer running in the
// same process. See `test/lib/cli-process.ts` for the harness — each test uses
// `opencode.run(message, opts?)` to spawn `bun src/index.ts run ...` with
// `OPENCODE_CONFIG_CONTENT` providing the test provider config inline.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

describe("opencode run (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "--yolo-forever warns that attach clients cannot change server permissions",
    ({ opencode }) =>
      Effect.gen(function* () {
        for (const args of [
          ["attach", "http://127.0.0.1:1", "--fork"],
          ["run", "--attach", "http://127.0.0.1:1", "--demo"],
        ]) {
          // Invalid flag combinations stop before connecting to any server.
          const result = yield* opencode.spawn([...args, "--yolo-forever"])
          opencode.expectExit(result, 1)
          expect(result.stderr).toContain("YOLO FOREVER is local only")
          expect(result.stderr).toContain("attached server must start with --yolo-forever")
          expect(result.stdout).not.toContain("Warning: YOLO FOREVER")
        }
      }),
    60_000,
  )

  cliIt.concurrent(
    "--yolo-forever reaches the local runtime and child tools without corrupting JSON output",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.tool("bash", {
          command: "printenv OPENCODE_YOLO_FOREVER",
          description: "Read the inherited process flag",
        })
        yield* llm.text("inherited flag checked")
        const result = yield* opencode.run("check the flag", {
          format: "json",
          extraArgs: ["--yolo-forever"],
          env: { OPENCODE_PERMISSION: JSON.stringify({ bash: "deny" }) },
        })
        opencode.expectExit(result, 0)
        expect(result.stderr).toContain("Warning: YOLO FOREVER")
        expect(result.stderr).toContain("including explicit denies")
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "tool_use",
            part: expect.objectContaining({
              tool: "bash",
              state: expect.objectContaining({ status: "completed", output: expect.stringContaining("true") }),
            }),
          }),
        )
      }),
    60_000,
  )

  // Happy path: prompt completes, output reaches stdout, process exits 0.
  // If this fails, all the others likely will too — debug here first.
  cliIt.concurrent(
    "exits 0 and writes the response to stdout on a successful prompt",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const result = yield* opencode.run("say hi")
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("hello from the test llm")
      }),
    60_000,
  )

  // Regression for #27371: an unknown model used to hang the process forever
  // waiting on a session.status === idle event that never arrived. The fix
  // makes the SDK call surface an error promptly so the process exits nonzero.
  // We assert nonzero exit AND wall-clock under the harness timeout — a hang
  // would expire the timeout and produce a different (signal-killed) failure.
  cliIt.concurrent(
    "exits nonzero promptly when the model is unknown (regression for #27371)",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.run("say hi", {
          model: "test/nonexistent-model",
          timeoutMs: 15_000,
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(15_000)
      }),
    30_000,
  )

  // Locks in the current behavior: when the LLM stream errors mid-response
  // (the prompt was accepted, then the upstream provider failed), opencode
  // emits a session.error event and the process exits 0 today.
  //
  // This is debatable — a future cleanup might flip it to exit 1. If you're
  // changing this expectation, do it deliberately and say so in the PR.
  cliIt.concurrent(
    "mid-stream LLM error still exits 0 today (contract lock-in)",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.fail("upstream provider exploded mid-stream")
        const result = yield* opencode.run("trigger midstream error", { timeoutMs: 30_000 })
        expect(result.exitCode).toBe(0)
      }),
    60_000,
  )

  // --format json puts one JSON object per line on stdout for each emitted
  // event. Consumers (CI scripts, tooling) parse this stream. Asserts the
  // shape so a future event-emit change has to update this expectation.
  cliIt.concurrent(
    "--format json emits parseable line-delimited JSON to stdout",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("structured output")
        const result = yield* opencode.run("say hi", { format: "json" })
        opencode.expectExit(result, 0)

        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.length).toBeGreaterThan(0)
        for (const evt of events) {
          expect(typeof evt.type).toBe("string")
          expect(typeof evt.sessionID).toBe("string")
        }
        // At least one `text` event should appear with the LLM's response.
        const text = events.find((e) => e.type === "text")
        expect(text).toBeDefined()
      }),
    60_000,
  )
})
