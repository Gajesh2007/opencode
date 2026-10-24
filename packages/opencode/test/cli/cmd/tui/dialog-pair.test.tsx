/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { Global } from "@opencode-ai/core/global"
import type { RemoteStatus } from "@opencode-ai/sdk/v2"
import { DialogPair } from "@/cli/cmd/tui/component/dialog-pair"
import { KVProvider } from "@/cli/cmd/tui/context/kv"
import { SDKProvider } from "@/cli/cmd/tui/context/sdk"
import { ThemeProvider } from "@/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "@/cli/cmd/tui/context/tui-config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "@/cli/cmd/tui/keymap"
import { DialogProvider, useDialog } from "@/cli/cmd/tui/ui/dialog"
import { ToastProvider } from "@/cli/cmd/tui/ui/toast"
import type { Pair } from "@/cli/cmd/tui/util/pair"
import { PairingState } from "@/server/pairing-state"
import { tmpdir } from "../../../fixture/fixture"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"
import { eventSource } from "./sync-fixture"

const REMOTE = "https://0123456789abcdef.tunnel.example"
const CREDENTIALS = { username: "opencode", password: "pairing-secret" }

// A fake opencode server with the pairing routes, enforcing basic auth when given credentials.
function server(credentials?: { username: string; password: string }) {
  const auth = credentials && `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`
  const state = {
    codes: 0,
    expiresIn: 300,
    pairError: undefined as { status: number; body: unknown } | undefined,
    remoteError: undefined as { status: number; body: unknown } | undefined,
    // Like a server from before remote access existed.
    remoteMissing: false,
    remote: { enabled: false, state: "off" } as RemoteStatus,
    updates: [] as boolean[],
    unauthorized: 0,
  }
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url)
      if (auth && request.headers.get("authorization") !== auth) {
        state.unauthorized++
        return new Response(null, { status: 401 })
      }
      if (url.pathname === "/global/info")
        return Response.json({
          version: "test",
          pid: 1,
          urls: [url.origin, ...(state.remote.state === "connected" ? [REMOTE] : [])],
          paths: { tmp: "/tmp" },
        })
      if (url.pathname === "/api/pair" && request.method === "POST") {
        if (state.pairError) return Response.json(state.pairError.body, { status: state.pairError.status })
        state.codes++
        return Response.json({ code: `code${state.codes}`, expires_in: state.expiresIn })
      }
      if (url.pathname === "/api/remote" && state.remoteMissing) return new Response("not found", { status: 404 })
      if (url.pathname === "/api/remote" && request.method === "GET") return Response.json(state.remote)
      if (url.pathname === "/api/remote" && request.method === "POST") {
        if (state.remoteError) return Response.json(state.remoteError.body, { status: state.remoteError.status })
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test server reading its own payload
        const body = (await request.json()) as { enabled: boolean }
        state.updates.push(body.enabled)
        state.remote = body.enabled ? { enabled: true, state: "connecting" } : { enabled: false, state: "off" }
        return Response.json(state.remote)
      }
      return new Response("not found", { status: 404 })
    },
  })
  return {
    state,
    url: http.url.origin,
    [Symbol.dispose]() {
      void http.stop(true)
    },
  }
}

async function mount(input: { root: string; url: string; listen?: () => Promise<Pair.Listener>; width?: number }) {
  const previous = { config: Global.Path.config, state: Global.Path.state }
  Global.Path.config = path.join(input.root, "config")
  Global.Path.state = path.join(input.root, "state")
  await mkdir(Global.Path.config, { recursive: true })
  await Bun.write(path.join(Global.Path.state, "kv.json"), "{}")

  function Open() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <DialogPair listen={input.listen} />))
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ToastProvider>
              <SDKProvider url={input.url} events={eventSource()}>
                <ThemeProvider mode="dark">
                  <DialogProvider>
                    <Open />
                  </DialogProvider>
                </ThemeProvider>
              </SDKProvider>
            </ToastProvider>
          </KVProvider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />, { width: input.width ?? 120, height: 50, kittyKeyboard: true })
  const frame = async () => {
    await app.renderOnce()
    return app.captureCharFrame()
  }
  return {
    app,
    frame,
    async until(fn: (frame: string) => boolean, timeout = 5000) {
      const start = Date.now()
      while (!fn(await frame())) {
        if (Date.now() - start > timeout) throw new Error(`timed out waiting for frame:\n${await frame()}`)
        await Bun.sleep(20)
      }
    },
    [Symbol.dispose]() {
      app.renderer.destroy()
      Global.Path.config = previous.config
      Global.Path.state = previous.state
    },
  }
}

test("pairs through the in-process server's listener with its credentials", async () => {
  await using tmp = await tmpdir()
  using fake = server(CREDENTIALS)
  const calls: string[] = []
  using view = await mount({
    root: tmp.path,
    url: "http://opencode.internal",
    listen: async () => {
      calls.push("listen")
      return { url: fake.url, ...CREDENTIALS }
    },
  })

  await view.until((frame) => frame.includes("Remote access Off"))
  const frame = await view.frame()
  const port = new URL(fake.url).port
  expect(frame).toContain("Pair device")
  expect(frame).toContain("Open a link to connect. Links work once and expire in 5 minutes.")
  expect(frame).toContain("This device")
  expect(frame).toContain(`http://localhost:${port}/auth/connect/code1`)
  expect(frame).toContain(`${fake.url}/auth/connect/code1`)
  expect(frame).toContain("To pair another device, turn on remote access")
  expect(frame).toMatch(/new links in [45]:\d\d/)
  expect(frame).toContain("enable remote r")
  // Loopback links are useless to another device, so there is no QR code to switch.
  expect(frame).not.toContain("Scan with the OpenCode app")
  expect(frame).not.toContain("browser QR")
  expect(calls).toEqual(["listen"])
  expect(fake.state.unauthorized).toBe(0)
}, 15000)

test("remote access asks for consent once, then connects and shows the remote link and QR code", async () => {
  await using tmp = await tmpdir()
  using fake = server(CREDENTIALS)
  using view = await mount({ root: tmp.path, url: "http://opencode.internal", listen: async () => ({ url: fake.url, ...CREDENTIALS }) })
  await view.until((frame) => frame.includes("Remote access Off"))

  // Declining (here with esc) returns to the dialog without enabling anything.
  view.app.mockInput.pressKey("r")
  await view.until((frame) => frame.includes("Expose your server to the internet?"))
  const consent = await view.frame()
  expect(consent).toContain("This will expose your OpenCode server to the internet.")
  expect(consent).toContain("Traffic is end-to-end encrypted, and access requires")
  view.app.mockInput.pressEscape()
  await view.until((frame) => frame.includes("Pair device") && frame.includes("Remote access Off"))
  expect(fake.state.updates).toEqual([])
  expect(PairingState.read().remoteAccepted).toBeUndefined()

  view.app.mockInput.pressKey("r")
  await view.until((frame) => frame.includes("Expose your server to the internet?"))
  view.app.mockInput.pressEnter()
  await view.until((frame) => frame.includes("Connecting…"))
  expect(fake.state.updates).toEqual([true])
  expect(PairingState.read().remoteAccepted).toBe(true)
  expect(await view.frame()).toContain("Links for other devices appear once remote access connects.")

  fake.state.remote = { enabled: true, state: "connected", url: REMOTE }
  await view.until((frame) => frame.includes("Remote access ● On") && frame.includes("Scan with the OpenCode app"))
  const connected = await view.frame()
  const code = /localhost:\d+\/auth\/connect\/(code\d+)/.exec(connected)?.[1]
  expect(code).toBeDefined()
  // The remote link is listed first.
  expect(connected.indexOf(`${REMOTE}/auth/connect/${code}`)).toBeGreaterThan(-1)
  expect(connected.indexOf(`${REMOTE}/auth/connect/${code}`)).toBeLessThan(
    connected.indexOf(`${fake.url}/auth/connect/${code}`),
  )
  expect(connected).toContain("█")

  view.app.mockInput.pressTab()
  await view.until((frame) => frame.includes("Scan to open in a browser") && frame.includes("app QR tab"))

  // Turning it off needs no consent.
  view.app.mockInput.pressKey("r")
  await view.until((frame) => frame.includes("Remote access Off"))
  expect(fake.state.updates).toEqual([true, false])
  await view.until((frame) => !frame.includes(REMOTE))
}, 20000)

test("remote access turns on without asking again once accepted", async () => {
  await using tmp = await tmpdir()
  using fake = server()
  using view = await mount({ root: tmp.path, url: fake.url })
  PairingState.acceptRemote()
  await view.until((frame) => frame.includes("Remote access Off"))

  view.app.mockInput.pressKey("r")
  await view.until((frame) => frame.includes("Connecting…"))
  expect(await view.frame()).not.toContain("Expose your server to the internet?")
  expect(fake.state.updates).toEqual([true])
}, 15000)

test("refused remote access shows the server's reason", async () => {
  await using tmp = await tmpdir()
  using fake = server()
  fake.state.remoteError = {
    status: 400,
    body: { _tag: "InvalidRequestError", message: "Remote access requires a network listener" },
  }
  using view = await mount({ root: tmp.path, url: fake.url })
  PairingState.acceptRemote()
  await view.until((frame) => frame.includes("Remote access Off"))

  view.app.mockInput.pressKey("r")
  await view.until((frame) => frame.includes("Remote access requires a network listener"))
  // The reason stays while the status keeps being watched.
  await Bun.sleep(1200)
  const frame = await view.frame()
  expect(frame).toContain("Remote access Off")
  expect(frame).toContain("Remote access requires a network listener")
  expect(frame).toContain("enable remote r")
}, 15000)

test("a server without remote access still pairs", async () => {
  await using tmp = await tmpdir()
  using fake = server()
  fake.state.remoteMissing = true
  using view = await mount({ root: tmp.path, url: fake.url })

  await view.until((frame) => frame.includes("/auth/connect/code1"))
  await view.until((frame) => frame.includes("does not support remote access"))
  expect(await view.frame()).not.toContain("enable remote")
}, 15000)

test("links are renewed when they expire", async () => {
  await using tmp = await tmpdir()
  using fake = server()
  fake.state.expiresIn = 2
  using view = await mount({ root: tmp.path, url: fake.url })

  await view.until((frame) => frame.includes("/auth/connect/code1"))
  expect(await view.frame()).toMatch(/new links in 0:0[12]/)
  await view.until((frame) => frame.includes("/auth/connect/code2"), 6000)
  const frame = await view.frame()
  expect(frame).not.toContain("/auth/connect/code1")
  expect(frame).toContain(`http://localhost:${new URL(fake.url).port}/auth/connect/code2`)
}, 15000)

test("a server that cannot pair explains why", async () => {
  await using tmp = await tmpdir()
  using fake = server()
  fake.state.pairError = {
    status: 400,
    body: {
      _tag: "InvalidRequestError",
      message: "Pairing requires a server password; set OPENCODE_SERVER_PASSWORD and restart the server",
    },
  }
  using view = await mount({ root: tmp.path, url: fake.url })

  await view.until((frame) => frame.includes("Could not create pairing links"))
  const frame = await view.frame()
  expect(frame).toContain("Pairing requires a server password; set OPENCODE_SERVER_PASSWORD and restart the server")
  expect(frame).toContain("Close and reopen /pair to try again.")
  expect(frame).not.toContain("enable remote")
}, 15000)

test("wrong credentials read as a rejection, not a crash", async () => {
  await using tmp = await tmpdir()
  using fake = server(CREDENTIALS)
  using view = await mount({
    root: tmp.path,
    url: "http://opencode.internal",
    listen: async () => ({ url: fake.url, username: "opencode", password: "wrong" }),
  })

  await view.until((frame) => frame.includes("The server rejected this client's credentials."))
}, 15000)

test("an in-process server that cannot listen explains why", async () => {
  await using tmp = await tmpdir()
  using view = await mount({
    root: tmp.path,
    url: "http://opencode.internal",
    listen: async () => ({ error: "Could not start a network listener: EADDRINUSE" }),
  })

  await view.until((frame) => frame.includes("Could not start a network listener: EADDRINUSE"))
}, 15000)
