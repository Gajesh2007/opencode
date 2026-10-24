import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import { PairingState } from "../../src/server/pairing-state"
import { RemoteAccess } from "../../src/server/remote"
import { ServerInfo } from "../../src/server/server-info"
import { fakeTunnel, remoteStatus, removePairingFile } from "./fake-tunnel"

const local = "http://127.0.0.1:4096"
const target = "127.0.0.1:4096"
const remote = "https://0123456789abcdef.tunnel.test"

// RemoteAccess and ServerInfo are process-global, so every test turns remote access off and restores both.
const cleanup: Array<() => void> = []

afterEach(() => {
  RemoteAccess.disable()
  for (const fn of cleanup.splice(0).reverse()) fn()
  ServerInfo.setURLs([])
})

afterAll(removePairingFile)

function install(tunnel: RemoteAccess.Tunnel) {
  cleanup.push(RemoteAccess.setTunnel(tunnel))
  ServerInfo.setURLs([local])
}

function states() {
  const seen: RemoteAccess.State[] = []
  cleanup.push(RemoteAccess.subscribe((status) => seen.push(status.state)))
  return seen
}

describe("RemoteAccess", () => {
  test("attaches the route in the background and lists its URL after the local ones", async () => {
    const fake = fakeTunnel()
    install(fake.tunnel)
    const seen = states()

    expect(RemoteAccess.enable({ target })).toEqual({ enabled: true, state: "connecting" })
    const run = await fake.run()
    expect(run.target).toBe(target)
    expect(run.route).toBe(PairingState.route())
    run.onEvent({ type: "connecting" })
    run.onEvent({ type: "connected", url: remote })

    expect(RemoteAccess.status()).toEqual({ enabled: true, state: "connected", url: remote })
    expect(ServerInfo.urls()).toEqual([local, remote])
    expect(seen).toEqual(["connecting", "connecting", "connected"])
  })

  test("reports provisioning until a device's first tunnel connects", async () => {
    const fake = fakeTunnel({ provisioned: false })
    install(fake.tunnel)

    RemoteAccess.enable({ target })
    const run = await fake.run()
    expect(RemoteAccess.status()).toEqual({ enabled: true, state: "provisioning" })
    run.onEvent({ type: "connecting" })
    expect(RemoteAccess.status()).toEqual({ enabled: true, state: "provisioning" })
    run.onEvent({ type: "connected", url: remote })
    expect(RemoteAccess.status()).toEqual({ enabled: true, state: "connected", url: remote })
  })

  test("turning off detaches the route and drops its URL", async () => {
    const fake = fakeTunnel()
    install(fake.tunnel)
    RemoteAccess.enable({ target })
    const run = await fake.run()
    run.onEvent({ type: "connected", url: remote })

    expect(RemoteAccess.disable()).toEqual({ enabled: false, state: "off" })
    expect(run.signal.aborted).toBe(true)
    expect(ServerInfo.urls()).toEqual([local])

    // A stopped run's late events change nothing.
    run.onEvent({ type: "connected", url: remote })
    expect(RemoteAccess.status()).toEqual({ enabled: false, state: "off" })
    expect(ServerInfo.urls()).toEqual([local])
  })

  test("drops the URL while reconnecting and reports why", async () => {
    const fake = fakeTunnel()
    install(fake.tunnel)
    RemoteAccess.enable({ target })
    const run = await fake.run()
    run.onEvent({ type: "connected", url: remote })
    run.onEvent({ type: "retrying", error: "Tunnel closed", delay: 1_000 })

    expect(RemoteAccess.status()).toEqual({ enabled: true, state: "connecting", error: "Tunnel closed" })
    expect(ServerInfo.urls()).toEqual([local])
  })

  test("a fatal tunnel failure stops with its error", async () => {
    const fake = fakeTunnel()
    install(fake.tunnel)
    RemoteAccess.enable({ target })
    const run = await fake.run()
    run.onEvent({ type: "connected", url: remote })
    run.onEvent({ type: "stopped", error: "Certificate issuance failed: quota" })

    expect(RemoteAccess.status()).toEqual({
      enabled: true,
      state: "error",
      error: "Certificate issuance failed: quota",
    })
    expect(ServerInfo.urls()).toEqual([local])
  })

  test("a tunnel that fails to start reports its error", async () => {
    install({ hostname: async () => undefined, run: () => Promise.reject(new Error("bridge unavailable")) })

    RemoteAccess.enable({ target })
    expect(await remoteStatus((status) => status.state === "error")).toEqual({
      enabled: true,
      state: "error",
      error: "bridge unavailable",
    })
  })

  test("failing to read or save the route reports an error", async () => {
    const fake = fakeTunnel()
    install(fake.tunnel)
    // A directory where the pairing file belongs makes reading it fail.
    removePairingFile()
    fs.mkdirSync(PairingState.file(), { recursive: true })
    cleanup.push(() => fs.rmSync(PairingState.file(), { recursive: true, force: true }))

    expect(RemoteAccess.enable({ target })).toEqual({ enabled: true, state: "connecting" })
    expect(await remoteStatus((status) => status.state === "error")).toEqual({
      enabled: true,
      state: "error",
      error: expect.any(String),
    })
    expect(fake.started).toEqual([])
  })

  test("enabling again with the same target keeps the attached route", async () => {
    const fake = fakeTunnel()
    install(fake.tunnel)
    RemoteAccess.enable({ target })
    const run = await fake.run()
    run.onEvent({ type: "connected", url: remote })

    expect(RemoteAccess.enable({ target })).toEqual({ enabled: true, state: "connected", url: remote })
    expect(run.signal.aborted).toBe(false)
    expect(fake.started).toHaveLength(1)
  })

  test("enabling with another target moves the route there", async () => {
    const fake = fakeTunnel()
    install(fake.tunnel)
    RemoteAccess.enable({ target })
    const first = await fake.run(0)

    RemoteAccess.enable({ target: "127.0.0.1:5000" })
    expect(first.signal.aborted).toBe(true)
    const second = await fake.run(1)
    expect(second.target).toBe("127.0.0.1:5000")
    expect(second.route).toBe(first.route)
  })

  test("enabling again after a fatal failure starts over", async () => {
    const fake = fakeTunnel()
    install(fake.tunnel)
    RemoteAccess.enable({ target })
    const first = await fake.run(0)
    first.onEvent({ type: "stopped", error: "Certificate issuance failed: quota" })

    expect(RemoteAccess.enable({ target })).toEqual({ enabled: true, state: "connecting" })
    const second = await fake.run(1)
    second.onEvent({ type: "connected", url: remote })
    expect(RemoteAccess.status()).toEqual({ enabled: true, state: "connected", url: remote })
  })

  test("turning off while the tunnel starts up never attaches it", async () => {
    const lookup = Promise.withResolvers<void>()
    const hostname = Promise.withResolvers<string | undefined>()
    const runs: string[] = []
    install({
      hostname: () => {
        lookup.resolve()
        return hostname.promise
      },
      run: async (run) => void runs.push(run.target),
    })

    RemoteAccess.enable({ target })
    await lookup.promise
    RemoteAccess.disable()
    hostname.resolve(undefined)
    // The abandoned start resumes in a microtask, which always runs before the next macrotask.
    await Bun.sleep(0)

    expect(RemoteAccess.status()).toEqual({ enabled: false, state: "off" })
    expect(runs).toEqual([])
  })
})
