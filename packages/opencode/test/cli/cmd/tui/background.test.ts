import { describe, expect, test } from "bun:test"
import { backgroundNotice, shellResult, shellTone } from "../../../../src/cli/cmd/tui/util/background"

describe("shell results", () => {
  test.each([
    [{ status: "running" }, "running", "info"],
    [{ status: "exited", exit: 0 }, "exit 0", "info"],
    [{ status: "exited", exit: 2 }, "exit 2", "error"],
    [{ status: "exited", signal: "SIGTERM" }, "SIGTERM", "error"],
    [{ status: "exited" }, "exited", "info"],
    [{ status: "timeout" }, "timed out", "warning"],
    [{ status: "killed", exit: 137 }, "killed", "warning"],
  ] as const)("describes %o", (shell, result, tone) => {
    expect(shellResult(shell)).toBe(result)
    expect(shellTone(shell)).toBe(tone)
  })
})

describe("background notices", () => {
  const shell = { source: "shell", shellID: "sh_1", command: "bun test\n  --watch", state: "exited", exit: 0 }

  test.each([
    [{}, "info", "↳ Shell finished"],
    [{ exit: 1 }, "error", "! Shell failed (exit 1)"],
    [{ exit: undefined, signal: "SIGKILL" }, "error", "! Shell failed (SIGKILL)"],
    [{ state: "timeout", exit: undefined }, "warning", "! Shell timed out"],
    [{ state: "killed", exit: undefined }, "warning", "! Shell killed"],
    [{ user: true }, "info", "↳ User shell finished"],
  ] as const)("labels shell notice %o", (input, tone, label) => {
    expect(backgroundNotice({ ...shell, ...input })).toEqual({
      tone,
      label,
      detail: "bun test --watch",
      shellID: "sh_1",
    })
  })

  test("prefers the shell description over its command", () => {
    expect(backgroundNotice({ ...shell, description: "Run tests" })?.detail).toBe("Run tests")
    expect(backgroundNotice({ ...shell, description: " " })?.detail).toBe("bun test --watch")
  })

  test.each([
    ["completed", "info", "↳ Explore finished"],
    ["error", "error", "! Explore failed"],
    ["cancelled", "warning", "! Explore cancelled"],
  ] as const)("labels a %s subagent notice", (state, tone, label) => {
    expect(
      backgroundNotice({
        source: "subagent",
        sessionID: "ses_child",
        agent: "explore",
        description: "Find the config loader",
        state,
      }),
    ).toEqual({ tone, label, detail: "Find the config loader", sessionID: "ses_child" })
  })

  test("ignores other synthetic text", () => {
    expect(backgroundNotice(undefined)).toBeUndefined()
    expect(backgroundNotice({})).toBeUndefined()
    expect(backgroundNotice({ collaboration: { pending: true } })).toBeUndefined()
  })
})
