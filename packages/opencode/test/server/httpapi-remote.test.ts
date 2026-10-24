import { afterAll, afterEach, describe, expect, test } from "bun:test"
import * as Log from "@opencode-ai/core/util/log"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { RemoteAccess } from "../../src/server/remote"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Server } from "../../src/server/server"
import { ServerInfo } from "../../src/server/server-info"
import { withTimeout } from "../../src/util/timeout"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"
import { fakeTunnel, removePairingFile } from "./fake-tunnel"

void Log.init({ print: false })

const password = "remote-secret"
const authorization = `Basic ${btoa(`opencode:${password}`)}`
const remote = "https://0123456789abcdef.tunnel.test"

// Remote access, ServerInfo, and the listener's env-derived auth are process-global: restore all of them.
const cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
  RemoteAccess.disable()
  for (const fn of cleanup.splice(0).reverse()) await fn()
  ServerInfo.setURLs([])
  await disposeAllInstances()
  await resetDatabase()
})

afterAll(removePairingFile)

function app(input: { password?: string } = {}) {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: input.password }))),
    ),
    { disableLogger: true },
  ).handler
  return (path: string, init?: RequestInit) =>
    Promise.resolve(handler(new Request(new URL(path, "http://localhost"), init), HttpApiApp.context))
}

function install() {
  const fake = fakeTunnel()
  cleanup.push(RemoteAccess.setTunnel(fake.tunnel))
  return fake
}

function update(enabled: boolean, headers?: Record<string, string>) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ enabled }),
  }
}

// A real listener reads its auth config from the environment when it starts.
async function listen() {
  const original = process.env.OPENCODE_SERVER_PASSWORD
  process.env.OPENCODE_SERVER_PASSWORD = password
  cleanup.push(() => {
    if (original === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
    else process.env.OPENCODE_SERVER_PASSWORD = original
  })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, ephemeral: true })
  cleanup.push(() => withTimeout(listener.stop(true), 10_000, "timed out stopping the remote access listener"))
  return listener
}

describe("remote access HTTP API", () => {
  test("reports the status to authorized clients only", async () => {
    const request = app({ password })

    expect((await request("/api/remote")).status).toBe(401)
    expect((await request("/api/remote", update(false))).status).toBe(401)
    const status = await request("/api/remote", { headers: { authorization } })
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({ enabled: false, state: "off" })
  })

  test("turning remote access off always succeeds", async () => {
    const response = await app()("/api/remote", update(false))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ enabled: false, state: "off" })
  })

  test("refuses to expose a server without a password", async () => {
    const fake = install()
    ServerInfo.setURLs(["http://127.0.0.1:4096"])
    const response = await app()("/api/remote", update(true))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ message: expect.stringContaining("requires a server password") })
    expect(RemoteAccess.status()).toEqual({ enabled: false, state: "off" })
    expect(fake.started).toEqual([])
  })

  test("refuses to turn on without a network listener", async () => {
    const fake = install()
    ServerInfo.setURLs([])
    const response = await app({ password })("/api/remote", update(true, { authorization }))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ message: expect.stringContaining("requires a network listener") })
    expect(RemoteAccess.status()).toEqual({ enabled: false, state: "off" })
    expect(fake.started).toEqual([])
  })

  test("routes the listener through the tunnel and advertises the remote URL while connected", async () => {
    const fake = install()
    const listener = await listen()
    const local = listener.url.origin
    const request = (path: string, init?: RequestInit) => fetch(new URL(path, listener.url), init)
    const status = () => request("/api/remote", { headers: { authorization } }).then((response) => response.json())
    const info = () => request("/global/info", { headers: { authorization } }).then((response) => response.json())

    const enabled = await request("/api/remote", update(true, { authorization }))
    expect(enabled.status).toBe(200)
    expect(await enabled.json()).toEqual({ enabled: true, state: "connecting" })

    const run = await fake.run()
    expect(run.target).toBe(`127.0.0.1:${listener.port}`)
    run.onEvent({ type: "connecting" })
    expect(await status()).toEqual({ enabled: true, state: "connecting" })
    expect(await info()).toMatchObject({ urls: [local] })

    run.onEvent({ type: "connected", url: remote })
    expect(await status()).toEqual({ enabled: true, state: "connected", url: remote })
    expect(await info()).toMatchObject({ urls: [local, remote] })

    const disabled = await request("/api/remote", update(false, { authorization }))
    expect(await disabled.json()).toEqual({ enabled: false, state: "off" })
    expect(run.signal.aborted).toBe(true)
    expect(await info()).toMatchObject({ urls: [local] })
  })
})
