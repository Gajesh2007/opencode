/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, spyOn, test } from "bun:test"
import { onCleanup } from "solid-js"
import { Global } from "@opencode-ai/core/global"
import type { Model } from "@opencode-ai/sdk/v2"
import { App } from "@/cli/cmd/tui/app"
import { ArgsProvider } from "@/cli/cmd/tui/context/args"
import { ExitProvider } from "@/cli/cmd/tui/context/exit"
import { KVProvider } from "@/cli/cmd/tui/context/kv"
import { LocalProvider, useLocal } from "@/cli/cmd/tui/context/local"
import { ProjectProvider } from "@/cli/cmd/tui/context/project"
import { PromptRefProvider } from "@/cli/cmd/tui/context/prompt"
import { RouteProvider } from "@/cli/cmd/tui/context/route"
import { SDKProvider } from "@/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "@/cli/cmd/tui/context/sync"
import { ThemeProvider } from "@/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "@/cli/cmd/tui/context/tui-config"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useCommandSlashes } from "@/cli/cmd/tui/keymap"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import { DialogProvider, useDialog } from "@/cli/cmd/tui/ui/dialog"
import { Toast, ToastProvider, useToast } from "@/cli/cmd/tui/ui/toast"
import { Filesystem } from "@/util/filesystem"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createFetch, eventSource, json, wait } from "../cmd/tui/sync-fixture"

function model(providerID: string, id: string, tiers = ["ultrafast"], npm = "@ai-sdk/openai"): Model {
  return {
    id,
    providerID,
    name: id,
    api: { id, npm, url: "https://example.com/v1" },
    capabilities: {
      reasoning: true,
      temperature: true,
      attachment: false,
      toolcall: true,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
    limit: { context: 128000, output: 4096 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-09-01",
    serviceTiers: Object.fromEntries(tiers.map((tier) => [tier, { serviceTier: tier }])),
  }
}

async function mount(root: string) {
  const previous = Global.Path.state
  Global.Path.state = root
  await Bun.write(`${root}/kv.json`, "{}")
  await Bun.write(
    `${root}/model.json`,
    JSON.stringify({
      serviceTier: { "openai/gpt-6-astra": "priority", "openai/gpt-5.6-sol": "ultrafast" },
      variant: { "openai/gpt-6-astra": "high" },
    }),
  )
  const models = [
    model("openai", "gpt-6-astra", ["priority", "ultrafast"]),
    model("openai", "gpt-5.6-sol"),
    model("openai", "gpt-5.4", ["priority"]),
    model("openai", "compatible", ["ultrafast"], "@ai-sdk/openai-compatible"),
    model("openrouter", "openai/gpt-6-astra", ["ultrafast"], "@openrouter/ai-sdk-provider"),
    model("openai-codex", "gpt-6-astra"),
  ]
  const calls = createFetch((url) => {
    if (url.pathname === "/config") return json({ model: "openai/gpt-6-astra" })
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary" }])
    if (url.pathname !== "/config/providers") return
    return json({
      providers: ["openai", "openrouter", "openai-codex"].map((id) => ({
        id,
        name: id,
        models: Object.fromEntries(models.filter((model) => model.providerID === id).map((model) => [model.id, model])),
      })),
      default: { openai: "gpt-6-astra" },
    })
  })
  // Keep external plugin loading out of the command and local-state integration test.
  const plugins = spyOn(TuiPluginRuntime, "init").mockResolvedValue()
  const writes = spyOn(Filesystem, "writeJson")
  let local!: ReturnType<typeof useLocal>
  let sync!: ReturnType<typeof useSync>
  let toast!: ReturnType<typeof useToast>
  let dialog!: ReturnType<typeof useDialog>
  let slashes!: ReturnType<typeof useCommandSlashes>

  function Probe() {
    local = useLocal()
    sync = useSync()
    toast = useToast()
    dialog = useDialog()
    slashes = useCommandSlashes()
    return (
      <>
        <App />
        <Toast />
      </>
    )
  }

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
                <RouteProvider initialRoute={{ type: "plugin", id: "test" }}>
                  <TuiConfigProvider config={config}>
                    <SDKProvider url="http://test" fetch={calls.fetch} events={eventSource()}>
                      <ProjectProvider>
                        <SyncProvider>
                          <ThemeProvider mode="dark">
                            <LocalProvider>
                              <DialogProvider>
                                <PromptRefProvider>
                                  <Probe />
                                </PromptRefProvider>
                              </DialogProvider>
                            </LocalProvider>
                          </ThemeProvider>
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

  const app = await testRender(() => <Harness />, { width: 100, height: 30 })
  await wait(() => local?.model.ready && sync.status === "complete")
  return {
    app,
    local,
    sync,
    toast,
    dialog,
    toggle() {
      const slash = slashes().find((entry) => entry.display === "/ultrafast")
      expect(slash).toBeDefined()
      slash!.onSelect()
    },
    async saved() {
      await Promise.all(writes.mock.results.map((result) => result.value))
      return Bun.file(`${root}/model.json`).json()
    },
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      await Promise.all(writes.mock.results.map((result) => result.value))
      writes.mockRestore()
      plugins.mockRestore()
      Global.Path.state = previous
    },
  }
}

test("/ultrafast toggles the current model's persistent tier and warns about higher pricing", async () => {
  await using tmp = await tmpdir()
  await using tui = await mount(tmp.path)
  const current = tui.local.model.current()
  expect(tui.local.model.serviceTier.current()).toBe("priority")
  tui.dialog.replace(() => <text>Command palette</text>)

  tui.toggle()

  expect(tui.dialog.stack).toHaveLength(0)
  expect(tui.local.model.current()).toEqual(current)
  expect(tui.local.model.serviceTier.current()).toBe("ultrafast")
  expect(tui.local.model.variant.selected()).toBe("high")
  expect(tui.toast.currentToast).toMatchObject({ title: "Ultrafast enabled", variant: "warning" })
  await tui.app.renderOnce()
  expect(tui.app.captureCharFrame()).toContain("Higher pricing applies")
  expect(tui.app.captureCharFrame()).toContain("preview access")
  expect((await tui.saved()).serviceTier["openai/gpt-6-astra"]).toBe("ultrafast")

  tui.toggle()

  expect(tui.local.model.current()).toEqual(current)
  expect(tui.local.model.serviceTier.selected()).toBe("default")
  expect(tui.local.model.serviceTier.current()).toBeUndefined()
  expect(tui.toast.currentToast).toMatchObject({ title: "Ultrafast disabled", variant: "info" })
  expect((await tui.saved()).serviceTier).toEqual({
    "openai/gpt-6-astra": "default",
    "openai/gpt-5.6-sol": "ultrafast",
  })

  tui.local.model.set({ providerID: "openai", modelID: "gpt-5.6-sol" })
  expect(tui.local.model.serviceTier.current()).toBe("ultrafast")
  tui.toggle()
  expect(tui.local.model.serviceTier.selected()).toBe("default")
  tui.local.model.set(current!)
  expect(tui.local.model.serviceTier.selected()).toBe("default")
  tui.toggle()
  expect(tui.local.model.serviceTier.current()).toBe("ultrafast")
})

test("/ultrafast rejects unsupported models, SDKs, OpenRouter and Codex without changing their selection", async () => {
  await using tmp = await tmpdir()
  await using tui = await mount(tmp.path)
  for (const current of [
    { providerID: "openai", modelID: "gpt-5.4" },
    { providerID: "openai", modelID: "compatible" },
    { providerID: "openrouter", modelID: "openai/gpt-6-astra" },
    { providerID: "openai-codex", modelID: "gpt-6-astra" },
  ]) {
    tui.local.model.set(current)
    tui.toggle()
    expect(tui.local.model.current()).toEqual(current)
    expect(tui.local.model.serviceTier.selected()).toBeUndefined()
    expect(tui.toast.currentToast?.variant).toBe("warning")
    expect(tui.toast.currentToast?.message).toContain("direct OpenAI API")
    expect(tui.toast.currentToast?.message).toContain("/models")
  }
  tui.sync.set("provider", [])
  tui.toggle()
  expect(tui.local.model.current()).toBeUndefined()
  expect(tui.toast.currentToast?.variant).toBe("warning")
  expect((await tui.saved()).serviceTier).toEqual({
    "openai/gpt-6-astra": "priority",
    "openai/gpt-5.6-sol": "ultrafast",
  })
})
