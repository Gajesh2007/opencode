/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, spyOn, test } from "bun:test"
import { createEffect, onCleanup } from "solid-js"
import { Global } from "@opencode-ai/core/global"
import { Prompt, type PromptRef } from "@/cli/cmd/tui/component/prompt"
import { FrecencyProvider } from "@/cli/cmd/tui/component/prompt/frecency"
import { PromptHistoryProvider, usePromptHistory } from "@/cli/cmd/tui/component/prompt/history"
import { PromptStashProvider, usePromptStash } from "@/cli/cmd/tui/component/prompt/stash"
import { ArgsProvider } from "@/cli/cmd/tui/context/args"
import { EditorContextProvider } from "@/cli/cmd/tui/context/editor"
import { ExitProvider } from "@/cli/cmd/tui/context/exit"
import { KVProvider } from "@/cli/cmd/tui/context/kv"
import { LocalProvider, useLocal } from "@/cli/cmd/tui/context/local"
import { ProjectProvider } from "@/cli/cmd/tui/context/project"
import { RouteProvider } from "@/cli/cmd/tui/context/route"
import { SDKProvider } from "@/cli/cmd/tui/context/sdk"
import { StreamingMetricsProvider } from "@/cli/cmd/tui/context/streaming-metrics"
import { SyncProvider, useSync } from "@/cli/cmd/tui/context/sync"
import { ThemeProvider } from "@/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "@/cli/cmd/tui/context/tui-config"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useCommandShortcut } from "@/cli/cmd/tui/keymap"
import { DialogProvider } from "@/cli/cmd/tui/ui/dialog"
import { ToastProvider } from "@/cli/cmd/tui/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createFetch, eventSource, json, wait } from "../cmd/tui/sync-fixture"

test("ordinary typing does not rebuild unchanged shortcut layers", async () => {
  await using tmp = await tmpdir()
  const previous = Global.Path.state
  Global.Path.state = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const calls = createFetch((url) => {
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary" }])
    if (url.pathname === "/config/providers") return json({ providers: [], default: {} })
  })
  let prompt: PromptRef | undefined
  let sync: ReturnType<typeof useSync>
  let local: ReturnType<typeof useLocal>
  let history: ReturnType<typeof usePromptHistory>
  let stash: ReturnType<typeof usePromptStash>
  let keymap: ReturnType<typeof createDefaultOpenTuiKeymap>

  function Input() {
    sync = useSync()
    local = useLocal()
    history = usePromptHistory()
    stash = usePromptStash()
    const shortcuts = Array.from({ length: 50 }, () => useCommandShortcut("session.child.first"))
    createEffect(() => shortcuts.forEach((shortcut) => shortcut()))
    return <Prompt ref={(value) => (prompt = value)} />
  }

  function Harness() {
    const renderer = useRenderer()
    keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({
      keybinds: { input_clear: "ctrl+u", prompt_stash: "ctrl+s", prompt_stash_pop: "ctrl+o" },
    })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <ArgsProvider>
          <ExitProvider>
            <KVProvider>
              <ToastProvider>
                <RouteProvider initialRoute={{ type: "home" }}>
                  <TuiConfigProvider config={config}>
                    <SDKProvider url="http://test" fetch={calls.fetch} events={eventSource()}>
                      <ProjectProvider>
                        <SyncProvider>
                          <StreamingMetricsProvider>
                            <ThemeProvider mode="dark">
                              <LocalProvider>
                                <EditorContextProvider>
                                  <DialogProvider>
                                    <FrecencyProvider>
                                      <PromptHistoryProvider>
                                        <PromptStashProvider>
                                          <Input />
                                        </PromptStashProvider>
                                      </PromptHistoryProvider>
                                    </FrecencyProvider>
                                  </DialogProvider>
                                </EditorContextProvider>
                              </LocalProvider>
                            </ThemeProvider>
                          </StreamingMetricsProvider>
                        </SyncProvider>
                      </ProjectProvider>
                    </SDKProvider>
                  </TuiConfigProvider>
                </RouteProvider>
              </ToastProvider>
            </KVProvider>
          </ExitProvider>
        </ArgsProvider>
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 20 })
  try {
    await wait(() => sync?.status === "complete" && local?.model.ready && !!prompt)
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    app.mockInput.pressKey("a")
    await wait(() => prompt?.current.input === "a")
    await app.renderOnce()

    const registrations = spyOn(keymap!, "registerLayer")
    const queries = spyOn(keymap!, "getCommandBindings")
    try {
      for (const char of "bcdefghijklmnopqrstuvwxyz") app.mockInput.pressKey(char)
      await wait(() => prompt?.current.input === "abcdefghijklmnopqrstuvwxyz")
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("abcdefghijklmnopqrstuvwxyz")
      expect(registrations).not.toHaveBeenCalled()
      expect(queries).not.toHaveBeenCalled()
    } finally {
      registrations.mockRestore()
      queries.mockRestore()
    }

    const input = app.renderer.currentFocusedEditor as TextareaRenderable
    app.mockInput.pressKey("!")
    await wait(() => prompt?.current.input === "abcdefghijklmnopqrstuvwxyz!")
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Shell")
    app.mockInput.pressBackspace()

    input.cursorOffset = 0
    await app.renderOnce()
    expect(input.visualCursor.offset).toBe(0)
    app.mockInput.pressKey("!")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Shell")
    input.cursorOffset = input.plainText.length
    await app.renderOnce()
    app.mockInput.pressBackspace()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Shell")
    expect(prompt?.current.input).toBe("abcdefghijklmnopqrstuvwxy")
    input.cursorOffset = 0
    await app.renderOnce()
    app.mockInput.pressBackspace()
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Shell")

    app.mockInput.pressKey("s", { ctrl: true })
    await wait(() => prompt?.current.input === "")
    await app.renderOnce()
    expect(stash!.list()).toHaveLength(1)
    app.mockInput.pressKey("s", { ctrl: true })
    expect(stash!.list()).toHaveLength(1)
    app.mockInput.pressKey("o", { ctrl: true })
    await app.renderOnce()
    expect(prompt?.current.input).toBe("abcdefghijklmnopqrstuvwxy")
    app.mockInput.pressKey("u", { ctrl: true })
    await app.renderOnce()
    expect(prompt?.current.input).toBe("")

    history!.append({ input: "previous prompt", parts: [] })
    app.mockInput.pressArrow("up")
    await app.renderOnce()
    expect(prompt?.current.input).toBe("previous prompt")
    app.mockInput.pressArrow("down")
    expect(prompt?.current.input).toBe("previous prompt")
    await app.renderOnce()
    app.mockInput.pressArrow("down")
    await wait(() => prompt?.current.input === "")
  } finally {
    app.renderer.destroy()
    Global.Path.state = previous
  }
})
