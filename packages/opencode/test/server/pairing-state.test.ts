import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { PairingState } from "../../src/server/pairing-state"
import { removePairingFile } from "./fake-tunnel"

beforeEach(removePairingFile)
afterEach(removePairingFile)

function seed(text: string, mode = 0o600) {
  fs.mkdirSync(path.dirname(PairingState.file()), { recursive: true })
  fs.writeFileSync(PairingState.file(), text, { mode })
  fs.chmodSync(PairingState.file(), mode)
}

describe("PairingState", () => {
  test("generates the password on first use and keeps it", () => {
    expect(PairingState.read()).toEqual({})
    const password = PairingState.password()

    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(PairingState.password()).toBe(password)
    expect(PairingState.read()).toEqual({ password })
  })

  test("generates a random 16 hex character route on first use and keeps it", () => {
    const route = PairingState.route()

    expect(route).toMatch(/^[0-9a-f]{16}$/)
    expect(PairingState.route()).toBe(route)
    expect(PairingState.read()).toEqual({ route })
  })

  test("generating one secret keeps the others", () => {
    const password = PairingState.password()
    const route = PairingState.route()
    PairingState.acceptRemote()

    expect(PairingState.read()).toEqual({ password, route, remoteAccepted: true })
  })

  test.skipIf(process.platform === "win32")("is readable by the user only", () => {
    PairingState.password()

    expect(fs.statSync(PairingState.file()).mode & 0o777).toBe(0o600)
    // Written through a temporary file that is renamed into place.
    expect(
      fs.readdirSync(path.dirname(PairingState.file())).filter((name) => name.startsWith("pairing.json.")),
    ).toEqual([])
  })

  test.skipIf(process.platform === "win32")("rewriting a readable file restricts it to the user", () => {
    seed(JSON.stringify({ route: "0123456789abcdef" }), 0o644)
    PairingState.acceptRemote()

    expect(fs.statSync(PairingState.file()).mode & 0o777).toBe(0o600)
    expect(PairingState.read()).toEqual({ route: "0123456789abcdef", remoteAccepted: true })
  })

  test("a corrupt file reads as empty and is replaced on the next write", () => {
    seed("{ not json")
    expect(PairingState.read()).toEqual({})

    const password = PairingState.password()
    expect(PairingState.read()).toEqual({ password })
  })

  test("a file with invalid fields reads as empty", () => {
    seed(JSON.stringify({ password: 42, route: "0123456789abcdef" }))
    expect(PairingState.read()).toEqual({})
  })

  test("an empty saved password is replaced", () => {
    seed(JSON.stringify({ password: "" }))
    expect(PairingState.password()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test("recording remote access consent keeps the secrets", () => {
    const password = PairingState.password()
    expect(PairingState.read().remoteAccepted).toBeUndefined()

    PairingState.acceptRemote()
    expect(PairingState.read()).toEqual({ password, remoteAccepted: true })
  })
})
