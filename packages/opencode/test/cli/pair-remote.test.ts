import { afterEach, describe, expect, test } from "bun:test"
import * as Log from "@opencode-ai/core/util/log"
import yargs from "yargs"
import { PairCommand, pairingURL, pairPassword, waitForRemote } from "../../src/cli/cmd/pair"
import { prepareRemoteAccess, startRemoteAccess } from "../../src/cli/network"
import { PairingState } from "../../src/server/pairing-state"
import { RemoteAccess } from "../../src/server/remote"
import { Server } from "../../src/server/server"
import { ServerInfo } from "../../src/server/server-info"
import { withTimeout } from "../../src/util/timeout"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"
import { fakeTunnel, removePairingFile } from "../server/fake-tunnel"
import { captureOutput } from "./capture-output"

void Log.init({ print: false })

const remote = "https://0123456789abcdef.tunnel.test"

// Remote access, ServerInfo, the pairing file, and the listener's env-derived auth are process-global.
const cleanup: Array<() => unknown> = []

afterEach(async () => {
  RemoteAccess.disable()
  for (const fn of cleanup.splice(0).reverse()) await fn()
  ServerInfo.setURLs([])
  removePairingFile()
  process.exitCode = 0
  await disposeAllInstances()
  await resetDatabase()
})

// Runs `opencode pair ...` in this process, through its real argument parsing.
async function pair(argv: string[]) {
  const capture = captureOutput()
  await yargs(["pair", ...argv])
    .command(PairCommand)
    .exitProcess(false)
    .parseAsync()
    .finally(capture.restore)
  return capture.output
}

// Starts a listener the way `serve` does; it reads its auth config from the environment.
async function listen() {
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, ephemeral: true })
  cleanup.push(() => withTimeout(listener.stop(true), 10_000, "timed out stopping the listener"))
  return listener
}

function serverPassword(value: string | undefined) {
  const original = process.env.OPENCODE_SERVER_PASSWORD
  cleanup.push(() => {
    if (original === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
    else process.env.OPENCODE_SERVER_PASSWORD = original
  })
  if (value === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = value
}

function install(input?: { provisioned?: boolean }) {
  const fake = fakeTunnel(input)
  cleanup.push(RemoteAccess.setTunnel(fake.tunnel))
  return fake
}

describe("pair --url", () => {
  test.each([
    ["https://dev.example.com", "https://dev.example.com"],
    ["https://dev.example.com/", "https://dev.example.com"],
    ["http://192.168.1.5:4096//", "http://192.168.1.5:4096"],
    ["https://example.com/opencode/", "https://example.com/opencode"],
    ["HTTPS://Dev.Example.com", "https://dev.example.com"],
  ])("uses %s as %s", (input, expected) => {
    expect(pairingURL(input)).toBe(expected)
  })

  test.each([
    "ftp://example.com",
    "https://user:secret@example.com",
    "https://example.com/?token=1",
    "https://example.com/#app",
    "dev.example.com",
    "",
  ])("rejects %p", (input) => {
    expect(pairingURL(input)).toBeUndefined()
  })

  test("--remote cannot be combined with it", async () => {
    const output = await pair(["--remote", "--url", "https://dev.example.com", "http://127.0.0.1:9"])
    expect(output.stderr).toContain("--remote cannot be combined with --url")
    expect(output.stdout).toBe("")
    expect(process.exitCode).toBe(1)
  })

  test("an invalid value fails before contacting the server", async () => {
    const output = await pair(["--url", "https://user:secret@dev.example.com", "http://127.0.0.1:9"])
    expect(output.stderr).toContain(
      "invalid --url: expected an HTTP(S) server URL without credentials, query parameters, or a fragment",
    )
    expect(output.stderr).not.toContain("secret")
    expect(process.exitCode).toBe(1)
  })
})

describe("pair password", () => {
  test("prefers --password, then OPENCODE_SERVER_PASSWORD, then the saved pairing password", () => {
    expect(pairPassword({ flag: "flag", env: "env", saved: "saved" })).toBe("flag")
    expect(pairPassword({ env: "env", saved: "saved" })).toBe("env")
    expect(pairPassword({ saved: "saved" })).toBe("saved")
    expect(pairPassword({ flag: "", env: "", saved: "saved" })).toBe("saved")
    expect(pairPassword({})).toBeUndefined()
  })
})

describe("waiting for the remote tunnel", () => {
  test("returns its URL once connected, reporting each new status once", async () => {
    const upcoming: RemoteAccess.Status[] = [
      { enabled: true, state: "provisioning" },
      { enabled: true, state: "provisioning" },
      { enabled: true, state: "connecting", error: "relay unreachable" },
      { enabled: true, state: "connecting" },
      { enabled: true, state: "connecting", error: "relay unreachable" },
      { enabled: true, state: "connected", url: remote },
    ]
    const printed: string[] = []
    const url = await waitForRemote({
      first: { enabled: true, state: "connecting" },
      status: async () => upcoming.shift() ?? { enabled: false, state: "off" },
      print: (line) => printed.push(line),
      interval: 1,
    })
    expect(url).toBe(remote)
    expect(printed).toEqual([
      "Remote access connecting...",
      "Setting up remote access; this can take a minute...",
      "Remote access unavailable (relay unreachable); retrying...",
    ])
  })

  test("fails on a remote access error, when turned off, and after the timeout", async () => {
    // Resolves with the failure message; a wait that succeeds fails the test.
    const failure = (status: RemoteAccess.Status, timeout?: number) =>
      waitForRemote({ first: status, status: async () => status, print: () => {}, interval: 1, timeout }).then(
        (url) => `resolved with ${url}`,
        (error: unknown) => String(error),
      )

    expect(await failure({ enabled: true, state: "error", error: "Certificate issuance failed" })).toBe(
      "Error: remote access error: Certificate issuance failed",
    )
    expect(await failure({ enabled: false, state: "off" })).toBe("Error: remote access was turned off")
    const timeout = await failure({ enabled: true, state: "connecting" }, 20)
    expect(timeout).toContain("Timed out waiting for the remote tunnel; run `opencode pair --remote` again to retry.")
    expect(timeout).toContain("start the server with HTTPS_PROXY set")
  })
})

describe("remote pairing against a local server", () => {
  test("a server started with --remote pairs through its tunnel without password flags", async () => {
    const fake = install({ provisioned: false })
    serverPassword(undefined)

    // `serve --remote --yes`: accepts, then falls back to the saved pairing password before listening.
    const notes: string[] = []
    const capture = captureOutput()
    const ready = await prepareRemoteAccess({ yes: true, command: "serve", print: (line) => notes.push(line) }).finally(
      capture.restore,
    )
    expect(ready).toBe(true)
    expect(PairingState.read().remoteAccepted).toBe(true)
    expect(process.env.OPENCODE_SERVER_PASSWORD).toBe(PairingState.read().password)
    expect(notes).toEqual([
      "OPENCODE_SERVER_PASSWORD is not set; using the saved pairing password (`opencode pair` reads it automatically).",
    ])

    const listener = await listen()
    const lines: string[] = []
    cleanup.push(startRemoteAccess((line) => lines.push(line)))
    const run = await fake.run()
    expect(run.target).toBe(`127.0.0.1:${listener.port}`)
    run.onEvent({ type: "connecting" })
    run.onEvent({ type: "connected", url: remote })
    expect(lines).toEqual([
      "Remote access connecting...",
      "Setting up remote access; this can take a minute...",
      `Remote access: ${remote}`,
    ])

    // Remote access is already on, so `pair --remote` neither asks nor restarts the tunnel.
    const remotePair = await pair(["--remote", listener.url.origin])
    expect(process.exitCode || 0).toBe(0)
    expect(remotePair.stderr).toBe("")
    expect(remotePair.stdout).toContain(`  ${remote}/auth/connect/`)
    expect(remotePair.stdout).not.toContain(`${listener.url.origin}/auth/connect/`)
    expect(remotePair.stdout).toContain("Scan the QR code")
    expect(fake.started).toHaveLength(1)

    // A plain `pair` lists the local address and, while the tunnel is up, the remote one.
    const plain = await pair([listener.url.origin])
    expect(plain.stdout).toContain(`  ${listener.url.origin}/auth/connect/`)
    expect(plain.stdout).toContain(`  ${remote}/auth/connect/`)

    // The server reports a dropped tunnel once, however many attempts reconnecting takes.
    run.onEvent({ type: "retrying", error: "Tunnel closed", delay: 1_000 })
    run.onEvent({ type: "connecting" })
    run.onEvent({ type: "retrying", error: "Tunnel closed", delay: 2_000 })
    run.onEvent({ type: "connecting" })
    run.onEvent({ type: "connected", url: remote })
    expect(lines.slice(3)).toEqual([
      "Remote access unavailable (Tunnel closed); retrying...",
      `Remote access: ${remote}`,
    ])
  })

  test("pair --remote turns remote access on, then reports a tunnel that fails", async () => {
    const fake = install()
    serverPassword("remote-secret")
    PairingState.acceptRemote()
    const listener = await listen()

    const pairing = pair(["--remote", "--password", "remote-secret", listener.url.origin])
    const run = await fake.run()
    expect(run.target).toBe(`127.0.0.1:${listener.port}`)
    run.onEvent({ type: "stopped", error: "Certificate issuance failed" })
    const output = await pairing

    expect(output.stderr).toContain("Remote access connecting...")
    expect(output.stderr).toContain("Pairing failed: remote access error: Certificate issuance failed")
    expect(output.stdout).toBe("")
    expect(process.exitCode).toBe(1)
  })
})
