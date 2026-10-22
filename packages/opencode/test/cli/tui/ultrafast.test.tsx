/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, spyOn, test } from "bun:test"
import { createSignal, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Global } from "@opencode-ai/core/global"
import type { Model } from "@opencode-ai/sdk/v2"
import { App } from "@/cli/cmd/tui/app"
import { Prompt, type PromptProps, type PromptRef } from "@/cli/cmd/tui/component/prompt"
import { FrecencyProvider } from "@/cli/cmd/tui/component/prompt/frecency"
import { PromptHistoryProvider } from "@/cli/cmd/tui/component/prompt/history"
import { PromptStashProvider } from "@/cli/cmd/tui/component/prompt/stash"
import { ArgsProvider } from "@/cli/cmd/tui/context/args"
import { EditorContextProvider } from "@/cli/cmd/tui/context/editor"
import { ExitProvider } from "@/cli/cmd/tui/context/exit"
import { KVProvider } from "@/cli/cmd/tui/context/kv"
import { LocalProvider, useLocal } from "@/cli/cmd/tui/context/local"
import { ProjectProvider, useProject } from "@/cli/cmd/tui/context/project"
import { PromptRefProvider } from "@/cli/cmd/tui/context/prompt"
import { RouteProvider } from "@/cli/cmd/tui/context/route"
import { SDKProvider } from "@/cli/cmd/tui/context/sdk"
import { StreamingMetricsProvider } from "@/cli/cmd/tui/context/streaming-metrics"
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
    variants: { high: { reasoningEffort: "high" } },
    serviceTiers: Object.fromEntries(tiers.map((tier) => [tier, { serviceTier: tier }])),
  }
}

const supported = [
  model("openai", "gpt-6.1-sol"),
  model("openai-codex", "gpt-6.1-sol"),
  model("amazon-bedrock", "us.openai.gpt-6.1-sol"),
  model("amazon-bedrock", "global.openai.gpt-6.1-sol"),
  model("amazon-bedrock", "openai.gpt-6.1-sol", ["ultrafast"], "@ai-sdk/amazon-bedrock/mantle"),
  model("azure", "gpt-6.1-sol", ["ultrafast"], "@ai-sdk/azure"),
  model("custom", "sol61-deployment"),
]

const aliases = supported.map((model) => ({
  ...model,
  id: `${model.id}-ultrafast`,
  options: { serviceTier: "ultrafast" },
}))

const unsupported = [
  model("openai", "gpt-5.4", ["priority"]),
  model("openai", "compatible", [], "@ai-sdk/openai-compatible"),
  model("openrouter", "openai/gpt-6-astra", ["throughput"], "@openrouter/ai-sdk-provider"),
  model("vercel", "openai/gpt-6.1-sol", ["priority", "flex"], "@ai-sdk/gateway"),
  model("openai-codex", "gpt-6-astra", []),
  model("amazon-bedrock", "no-runtime-tiers", []),
  model("amazon-bedrock", "no-mantle-tiers", [], "@ai-sdk/amazon-bedrock/mantle"),
  model("azure", "no-tiers", [], "@ai-sdk/azure"),
  { ...model("custom", "no-tiers"), serviceTiers: undefined },
]

async function mount(root: string, withPrompt = false, promptProps: PromptProps = {}) {
  const [props, setPromptProps] = createStore<PromptProps>({ sessionID: "ses_ultrafast", ...promptProps })
  const [showPrompt, setShowPrompt] = createSignal(withPrompt)
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
    ...supported,
    ...aliases,
    ...unsupported,
  ]
  const calls = createFetch((url) => {
    if (url.pathname === "/config") return json({ model: "openai/gpt-6-astra" })
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary" }])
    if (url.pathname === "/command") return json([{ name: "test", template: "Continue" }])
    if (url.pathname !== "/config/providers") return
    return json({
      providers: [...new Set(models.map((model) => model.providerID))].map((id) => ({
        id,
        name: id,
        models: Object.fromEntries(models.filter((model) => model.providerID === id).map((model) => [model.id, model])),
      })),
      default: { openai: "gpt-6-astra" },
    })
  })
  const requests: Request[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.method === "POST") {
      if (new URL(request.url).pathname.startsWith("/session/")) requests.push(request)
      if (new URL(request.url).pathname.endsWith("/warm"))
        return new Promise<Response>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          })
        })
      return json({})
    }
    return calls.fetch(input, init)
  }) as typeof globalThis.fetch
  // Keep external plugin loading out of the command and local-state integration test.
  const plugins = spyOn(TuiPluginRuntime, "init").mockResolvedValue()
  const writes = spyOn(Filesystem, "writeJson")
  let local!: ReturnType<typeof useLocal>
  let sync!: ReturnType<typeof useSync>
  let project!: ReturnType<typeof useProject>
  let toast!: ReturnType<typeof useToast>
  let dialog!: ReturnType<typeof useDialog>
  let slashes!: ReturnType<typeof useCommandSlashes>
  let prompt: PromptRef | undefined

  function Probe() {
    local = useLocal()
    sync = useSync()
    project = useProject()
    toast = useToast()
    dialog = useDialog()
    slashes = useCommandSlashes()
    return (
      <>
        <App />
        <Toast />
        <Show when={showPrompt()}>
          <StreamingMetricsProvider>
            <EditorContextProvider>
              <FrecencyProvider>
                <PromptHistoryProvider>
                  <PromptStashProvider>
                    <Prompt {...props} ref={(value) => (prompt = value)} />
                  </PromptStashProvider>
                </PromptHistoryProvider>
              </FrecencyProvider>
            </EditorContextProvider>
          </StreamingMetricsProvider>
        </Show>
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
                    <SDKProvider url="http://test" fetch={fetch} events={eventSource()}>
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
  await wait(() => local?.model.ready && sync.status === "complete" && (!withPrompt || !!prompt))
  return {
    app,
    local,
    sync,
    project,
    toast,
    dialog,
    slashes,
    requests,
    setPromptProps,
    unmountPrompt() {
      setShowPrompt(false)
    },
    readySession() {
      sync.set("session", [
        {
          id: "ses_ultrafast",
          slug: "warm",
          projectID: "proj_test",
          directory: root,
          title: "Warm",
          version: "1",
          time: { created: 0, updated: 0 },
        },
      ])
      sync.set("message", "ses_ultrafast", [])
    },
    get prompt() {
      return prompt
    },
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

test("prompt warming debounces edits, sends only IDs, and cools down each selection", async () => {
  await using tmp = await tmpdir()
  await using tui = await mount(tmp.path, true)
  tui.prompt!.set({ input: "Draft before session restoration", parts: [] })
  await Bun.sleep(450)
  expect(tui.requests).toHaveLength(0)
  tui.readySession()
  tui.prompt!.set({ input: "Private draft one", parts: [] })
  await Bun.sleep(250)
  expect(tui.requests).toHaveLength(0)
  tui.prompt!.set({ input: "Private draft two", parts: [] })
  await Bun.sleep(250)
  expect(tui.requests).toHaveLength(0)
  await wait(() => tui.requests.length === 1)
  expect(new URL(tui.requests[0].url).pathname).toBe("/session/ses_ultrafast/warm")
  expect(await tui.requests[0].json()).toEqual({
    providerID: "openai",
    modelID: "gpt-6-astra",
    agent: "build",
    variant: "high",
    serviceTier: "priority",
  })
  tui.prompt!.set({ input: "Private draft three", parts: [] })
  await Bun.sleep(450)
  expect(tui.requests).toHaveLength(1)
  tui.local.model.serviceTier.set("default")
  await wait(() => tui.requests.length === 2)
  expect(await tui.requests[1].json()).toMatchObject({ serviceTier: "default" })
})

test("prompt warming cancels on submit and skips commands, disconnected workspaces, and busy sessions", async () => {
  await using tmp = await tmpdir()
  await using tui = await mount(tmp.path, true)
  tui.readySession()
  tui.prompt!.set({ input: "Submit without waiting for warming", parts: [] })
  tui.prompt!.submit()
  await wait(() => tui.requests.length === 1)
  await Bun.sleep(450)
  expect(new URL(tui.requests[0].url).pathname).toBe("/session/ses_ultrafast/message")
  tui.prompt!.set({ input: "/test private argument", parts: [] })
  await Bun.sleep(450)
  expect(tui.requests).toHaveLength(1)
  tui.project.workspace.set("workspace_disconnected")
  tui.prompt!.set({ input: "Disconnected draft", parts: [] })
  await Bun.sleep(450)
  expect(tui.requests).toHaveLength(1)
  tui.project.workspace.set(undefined)
  tui.prompt!.set({ input: "Busy draft", parts: [] })
  tui.sync.set("session_status", "ses_ultrafast", { type: "busy" })
  await Bun.sleep(450)
  expect(tui.requests).toHaveLength(1)
})

test.each(["edit", "clear", "session", "hide", "submit", "unmount", "reasoning"])(
  "prompt warming aborts a dispatched request on %s",
  async (change) => {
    await using tmp = await tmpdir()
    await using tui = await mount(tmp.path, true)
    tui.readySession()
    tui.prompt!.set({ input: "Private draft pending warm", parts: [] })
    await wait(() => tui.requests.length === 1)
    const request = tui.requests[0]
    expect(new URL(request.url).pathname).toBe("/session/ses_ultrafast/warm")
    expect(request.signal.aborted).toBe(false)

    if (change === "edit") tui.prompt!.set({ input: "Edited private draft", parts: [] })
    if (change === "clear") tui.prompt!.reset()
    if (change === "session") tui.setPromptProps("sessionID", "ses_other")
    if (change === "hide") tui.setPromptProps("visible", false)
    if (change === "submit") tui.prompt!.submit()
    if (change === "unmount") tui.unmountPrompt()
    if (change === "reasoning") tui.local.session.setReasoningMode("ses_ultrafast", "pro")

    await wait(() => request.signal.aborted)
    if (change === "submit") await wait(() => tui.requests.length === 2)
    await Bun.sleep(450)
    expect(tui.requests.filter((request) => new URL(request.url).pathname.endsWith("/warm"))).toHaveLength(1)
  },
)

test("prompt warming cancels the old selection and sends only the new selection IDs", async () => {
  await using tmp = await tmpdir()
  await using tui = await mount(tmp.path, true)
  tui.readySession()
  tui.prompt!.set({ input: "Do not send this private draft", parts: [] })
  await wait(() => tui.requests.length === 1)
  const original = tui.requests[0]
  tui.local.model.set({ providerID: "openai", modelID: "gpt-5.6-sol" })
  await wait(() => original.signal.aborted)
  await wait(() => tui.requests.length === 2)
  expect(tui.requests[1].signal.aborted).toBe(false)
  expect(await tui.requests[1].json()).toEqual({
    providerID: "openai",
    modelID: "gpt-5.6-sol",
    agent: "build",
    serviceTier: "ultrafast",
  })
})

test.each([{ visible: false }, { disabled: true }, { sessionID: undefined }])(
  "prompt warming skips ineligible prompt %j",
  async (props) => {
    await using tmp = await tmpdir()
    await using tui = await mount(tmp.path, true, props)
    tui.readySession()
    tui.prompt!.set({ input: "Private draft", parts: [] })
    await Bun.sleep(450)
    expect(tui.requests).toHaveLength(0)
  },
)

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
  expect(tui.app.captureCharFrame()).toContain("provider and account access")
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

test("/ultrafast opts into advertised tiers on OpenAI, Bedrock runtime, Mantle, Azure and custom Responses", async () => {
  await using tmp = await tmpdir()
  await using tui = await mount(tmp.path)
  for (const model of supported) {
    const current = { providerID: model.providerID, modelID: model.id }
    const key = `${current.providerID}/${current.modelID}`
    tui.local.model.set(current)
    expect(tui.local.model.serviceTier.selected()).toBeUndefined()
    expect(tui.local.model.serviceTier.current()).toBeUndefined()
    expect((await tui.saved()).serviceTier[key]).toBeUndefined()

    tui.toggle()

    expect(tui.local.model.current()).toEqual(current)
    expect(tui.local.model.serviceTier.current()).toBe("ultrafast")
    expect(tui.toast.currentToast).toMatchObject({ title: "Ultrafast enabled", variant: "warning" })
    expect(tui.toast.currentToast?.message).toContain("Higher pricing applies")
    expect(tui.toast.currentToast?.message).toContain("provider and account access")
    expect((await tui.saved()).serviceTier[key]).toBe("ultrafast")

    tui.toggle()

    expect(tui.local.model.current()).toEqual(current)
    expect(tui.local.model.serviceTier.selected()).toBe("default")
    expect(tui.local.model.serviceTier.current()).toBeUndefined()
    expect(tui.toast.currentToast).toMatchObject({ title: "Ultrafast disabled", variant: "info" })
    expect((await tui.saved()).serviceTier[key]).toBe("default")
  }
})

test("/ultrafast disables inherited alias tiers with a persistent default override without changing model or reasoning", async () => {
  await using tmp = await tmpdir()
  await using tui = await mount(tmp.path)
  for (const model of aliases) {
    const current = { providerID: model.providerID, modelID: model.id }
    const key = `${current.providerID}/${current.modelID}`
    tui.local.model.set({ ...current })
    tui.local.model.variant.set("high")
    expect(tui.local.model.serviceTier.selected()).toBeUndefined()
    expect(tui.local.model.serviceTier.current()).toBe("ultrafast")
    expect(tui.slashes().find((entry) => entry.display === "/ultrafast")?.description).toBe("Disable Ultrafast")
    expect((await tui.saved()).serviceTier[key]).toBeUndefined()

    tui.toggle()

    expect(tui.local.model.current()).toEqual(current)
    expect(tui.local.model.variant.current()).toBe("high")
    expect(tui.local.model.serviceTier.selected()).toBe("default")
    expect(tui.local.model.serviceTier.current()).toBeUndefined()
    expect(tui.toast.currentToast).toMatchObject({ title: "Ultrafast disabled", variant: "info" })
    expect((await tui.saved()).serviceTier[key]).toBe("default")

    tui.local.model.set({ providerID: "openai", modelID: "gpt-6-astra" })
    tui.local.model.set(current)
    expect(tui.local.model.serviceTier.current()).toBeUndefined()
    expect(tui.slashes().find((entry) => entry.display === "/ultrafast")?.description).toBe("Enable Ultrafast")

    tui.toggle()

    expect(tui.local.model.current()).toEqual(current)
    expect(tui.local.model.variant.current()).toBe("high")
    expect(tui.local.model.serviceTier.current()).toBe("ultrafast")
    expect((await tui.saved()).serviceTier[key]).toBe("ultrafast")
  }
})

test("/tier highlights inherited Ultrafast and selecting Default overrides the alias tier", async () => {
  await using tmp = await tmpdir()
  await using tui = await mount(tmp.path)
  tui.local.model.set({ providerID: "amazon-bedrock", modelID: "us.openai.gpt-6.1-sol-ultrafast" })
  tui
    .slashes()
    .find((entry) => entry.display === "/tier")!
    .onSelect()
  await tui.app.renderOnce()
  expect(tui.app.captureCharFrame()).toMatch(/\u25cf\s+ultrafast/)

  tui.app.mockInput.pressArrow("up")
  tui.app.mockInput.pressEnter()

  expect(tui.dialog.stack).toHaveLength(0)
  expect(tui.local.model.serviceTier.selected()).toBe("default")
  expect(tui.local.model.serviceTier.current()).toBeUndefined()
  expect((await tui.saved()).serviceTier["amazon-bedrock/us.openai.gpt-6.1-sol-ultrafast"]).toBe("default")

  tui
    .slashes()
    .find((entry) => entry.display === "/tier")!
    .onSelect()
  await tui.app.renderOnce()
  expect(tui.app.captureCharFrame()).toMatch(/\u25cf\s+Default/)
})

test("service tier cycling respects inherited Ultrafast and explicit overrides", async () => {
  await using tmp = await tmpdir()
  await using tui = await mount(tmp.path)
  tui.local.model.set({ providerID: "openai", modelID: "gpt-6.1-sol-ultrafast" })
  expect(tui.local.model.serviceTier.current()).toBe("ultrafast")

  tui.local.model.serviceTier.cycle()

  expect(tui.local.model.serviceTier.selected()).toBe("default")
  expect(tui.local.model.serviceTier.current()).toBeUndefined()
  expect((await tui.saved()).serviceTier["openai/gpt-6.1-sol-ultrafast"]).toBe("default")

  tui.local.model.serviceTier.set("unavailable")
  expect(tui.local.model.serviceTier.current()).toBeUndefined()
  tui.local.model.serviceTier.cycle()
  expect(tui.local.model.serviceTier.current()).toBe("ultrafast")
})

test("prompt and command submissions preserve an alias's explicit default reset on the wire", async () => {
  await using tmp = await tmpdir()
  await using tui = await mount(tmp.path, true)
  const current = { providerID: "amazon-bedrock", modelID: "us.openai.gpt-6.1-sol-ultrafast" }
  tui.local.model.set(current)
  tui.local.model.variant.set("high")
  for (const serviceTier of ["ultrafast", "default"]) {
    if (serviceTier === "default") tui.toggle()
    for (const input of ["Continue", "/test Continue"]) {
      const count = tui.requests.length
      tui.prompt!.set({ input, parts: [] })
      tui.prompt!.submit()
      await wait(() => tui.requests.length === count + 1)
      expect(new URL(tui.requests[count].url).pathname).toBe(
        `/session/ses_ultrafast/${input.startsWith("/") ? "command" : "message"}`,
      )
      expect(await tui.requests[count].json()).toMatchObject({
        serviceTier,
        variant: "high",
        model: input.startsWith("/") ? `${current.providerID}/${current.modelID}` : current,
      })
    }
  }
  expect(tui.local.model.serviceTier.current()).toBeUndefined()
  expect((await tui.saved()).serviceTier["amazon-bedrock/us.openai.gpt-6.1-sol-ultrafast"]).toBe("default")
})

test("/ultrafast rejects models without the advertised tier without changing their selection", async () => {
  await using tmp = await tmpdir()
  await using tui = await mount(tmp.path)
  for (const model of unsupported) {
    const current = { providerID: model.providerID, modelID: model.id }
    tui.local.model.set(current)
    tui.toggle()
    expect(tui.local.model.current()).toEqual(current)
    expect(tui.local.model.serviceTier.selected()).toBeUndefined()
    expect(tui.toast.currentToast?.variant).toBe("warning")
    expect(tui.toast.currentToast?.message).toContain("not supported by the current model/provider")
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
