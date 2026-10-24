/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { Global } from "@opencode-ai/core/global"
import type { ShellProcess } from "@opencode-ai/sdk/v2"
import { DialogShellOutput } from "@/cli/cmd/tui/component/dialog-shell-output"
import { ArgsProvider } from "@/cli/cmd/tui/context/args"
import { ExitProvider } from "@/cli/cmd/tui/context/exit"
import { KVProvider } from "@/cli/cmd/tui/context/kv"
import { ProjectProvider } from "@/cli/cmd/tui/context/project"
import { SDKProvider } from "@/cli/cmd/tui/context/sdk"
import { SyncProvider } from "@/cli/cmd/tui/context/sync"
import { ThemeProvider } from "@/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "@/cli/cmd/tui/context/tui-config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "@/cli/cmd/tui/keymap"
import { DialogProvider } from "@/cli/cmd/tui/ui/dialog"
import { ToastProvider } from "@/cli/cmd/tui/ui/toast"
import { tmpdir } from "../../../fixture/fixture"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"
import { createFetch, eventSource, json } from "./sync-fixture"

// A fake server-side shell command whose output and status the test controls.
function server() {
  const state = {
    found: true,
    output: "",
    info: {
      id: "sh_test",
      sessionID: "ses_test",
      source: "tool",
      command: "bun run build",
      cwd: "/tmp/opencode",
      shell: "/bin/bash",
      file: "/tmp/sh_test",
      status: "running",
      background: true,
      time: { started: 1 },
    } as ShellProcess,
    reads: [] as URLSearchParams[],
  }
  const missing = () => json({ _tag: "ShellNotFoundError", shellID: "sh_test", message: "not found" }, { status: 404 })
  const calls = createFetch((url) => {
    if (url.pathname === "/shell/sh_test") return state.found ? json(state.info) : missing()
    if (url.pathname !== "/shell/sh_test/output") return
    state.reads.push(url.searchParams)
    if (!state.found) return missing()
    const bytes = Buffer.from(state.output)
    const start = Math.min(Number(url.searchParams.get("cursor") ?? 0), bytes.length)
    const end = Math.min(bytes.length, start + Number(url.searchParams.get("limit") ?? 64 * 1024))
    return json({ output: bytes.subarray(start, end).toString(), cursor: end, size: bytes.length })
  })
  return { state, fetch: calls.fetch }
}

async function mount(root: string, fetch: typeof globalThis.fetch) {
  const previous = Global.Path.state
  Global.Path.state = root
  await Bun.write(`${root}/kv.json`, "{}")

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <ArgsProvider>
          <ExitProvider>
            <KVProvider>
              <ToastProvider>
                <TuiConfigProvider config={config}>
                  <SDKProvider url="http://test" fetch={fetch} events={eventSource()}>
                    <ProjectProvider>
                      <SyncProvider>
                        <ThemeProvider mode="dark">
                          <DialogProvider>
                            <DialogShellOutput shellID="sh_test" command="bun run build" />
                          </DialogProvider>
                        </ThemeProvider>
                      </SyncProvider>
                    </ProjectProvider>
                  </SDKProvider>
                </TuiConfigProvider>
              </ToastProvider>
            </KVProvider>
          </ExitProvider>
        </ArgsProvider>
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />, { width: 120, height: 40 })
  const frame = async () => {
    await app.renderOnce()
    return app.captureCharFrame()
  }
  return {
    frame,
    async until(fn: (frame: string) => boolean, timeout = 4000) {
      const start = Date.now()
      while (!fn(await frame())) {
        if (Date.now() - start > timeout) throw new Error(`timed out waiting for frame:\n${await frame()}`)
        await Bun.sleep(20)
      }
    },
    [Symbol.dispose]() {
      app.renderer.destroy()
      Global.Path.state = previous
    },
  }
}

test("shell output starts at the recent tail, follows new output, and stops once the command exited", async () => {
  await using tmp = await tmpdir()
  const shell = server()
  shell.state.output = "x".repeat(70 * 1024) + "\nfirst line\n"
  using view = await mount(tmp.path, shell.fetch)

  await view.until((frame) => frame.includes("first line") && frame.includes("Earlier output omitted"))
  const frame = await view.frame()
  expect(frame).toContain("Shell output")
  expect(frame).toContain("Running")
  expect(frame).toContain("$ bun run build")
  const size = Buffer.byteLength(shell.state.output)
  expect(shell.state.reads[0].get("cursor")).toBe(String(Number.MAX_SAFE_INTEGER))
  expect(shell.state.reads[1].get("cursor")).toBe(String(size - 64 * 1024))
  expect(shell.state.reads[1].get("limit")).toBe(String(64 * 1024))

  shell.state.output += "second line\n"
  await view.until((frame) => frame.includes("second line"))
  // Follows the cursor rather than rereading the tail.
  expect(shell.state.reads.at(-1)?.get("cursor")).toBe(String(size))

  shell.state.output += "last line\n"
  shell.state.info = { ...shell.state.info, status: "exited", exit: 3, time: { started: 1, completed: 2 } }
  await view.until((frame) => frame.includes("last line") && frame.includes("Exited · code 3"))
  const reads = shell.state.reads.length
  await Bun.sleep(1500)
  expect(shell.state.reads).toHaveLength(reads)
}, 15000)

test("shell output reports a command the server no longer knows and stops polling", async () => {
  await using tmp = await tmpdir()
  const shell = server()
  shell.state.found = false
  using view = await mount(tmp.path, shell.fetch)

  await view.until((frame) => frame.includes("Shell output is no longer available."))
  expect(await view.frame()).not.toContain("Loading output")
  await Bun.sleep(1500)
  expect(shell.state.reads).toHaveLength(0)
}, 10000)
