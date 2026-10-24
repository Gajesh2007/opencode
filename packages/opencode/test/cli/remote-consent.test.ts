import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { remoteConsent, remoteWarning, type RemoteConsentPrompt } from "../../src/cli/remote-consent"
import { PairingState } from "../../src/server/pairing-state"
import { cliIt } from "../lib/cli-process"
import { removePairingFile } from "../server/fake-tunnel"
import { captureOutput } from "./capture-output"

const pairWarning = [
  "This will expose your OpenCode server to the internet.",
  "Traffic is end-to-end encrypted, and access requires your server password.",
  "To pair locally instead, run `opencode pair` without the --remote flag.",
]

beforeEach(removePairingFile)

afterEach(() => {
  removePairingFile()
  process.exitCode = 0
})

// Records whether the user was asked, so tests can assert the prompt was skipped.
function terminal(input: { readonly interactive: boolean; readonly answer?: boolean | symbol }) {
  const asked: true[] = []
  const prompt: RemoteConsentPrompt = {
    interactive: () => input.interactive,
    confirm: async () => {
      asked.push(true)
      return input.answer ?? false
    },
  }
  return { prompt, asked }
}

async function consent(input: { yes: boolean; command?: "pair" | "serve" | "web" }, prompt: RemoteConsentPrompt) {
  const capture = captureOutput()
  const accepted = await remoteConsent(input, prompt).finally(capture.restore)
  return { accepted, ...capture.output }
}

describe("remote access consent", () => {
  test("first enable asks before remote access is enabled and remembers acceptance", async () => {
    const accepting = terminal({ interactive: true, answer: true })
    const first = await consent({ yes: false }, accepting.prompt)
    expect(first.accepted).toBe(true)
    expect(accepting.asked).toHaveLength(1)
    for (const line of pairWarning) expect(first.stdout).toContain(line)
    expect(PairingState.read()).toEqual({ remoteAccepted: true })

    const again = terminal({ interactive: true, answer: false })
    expect((await consent({ yes: false }, again.prompt)).accepted).toBe(true)
    expect(again.asked).toHaveLength(0)
  })

  test("declining enables nothing and asks again next time", async () => {
    const declining = terminal({ interactive: true, answer: false })
    expect((await consent({ yes: false }, declining.prompt)).accepted).toBe(false)
    expect(declining.asked).toHaveLength(1)
    expect(process.exitCode || 0).toBe(0)
    expect(PairingState.read()).toEqual({})

    const cancelling = terminal({ interactive: true, answer: Symbol("clack:cancel") })
    expect((await consent({ yes: false }, cancelling.prompt)).accepted).toBe(false)
    expect(cancelling.asked).toHaveLength(1)
    expect(process.exitCode).toBe(130)
    expect(PairingState.read()).toEqual({})
  })

  test("already accepted remote access does not ask, even without a terminal", async () => {
    PairingState.acceptRemote()
    const headless = terminal({ interactive: false })
    expect((await consent({ yes: false }, headless.prompt)).accepted).toBe(true)
    expect(headless.asked).toHaveLength(0)
    expect(process.exitCode || 0).toBe(0)
  })

  test("without a terminal, first enable fails unless --yes accepts", async () => {
    const headless = terminal({ interactive: false })
    const refused = await consent({ yes: false }, headless.prompt)
    expect(refused.accepted).toBe(false)
    expect(process.exitCode).toBe(1)
    expect(headless.asked).toHaveLength(0)
    expect(refused.stderr).toBe([...pairWarning, "Run interactively or pass --yes to continue.", ""].join(os.EOL))
    expect(PairingState.read()).toEqual({})

    process.exitCode = 0
    expect((await consent({ yes: true }, headless.prompt)).accepted).toBe(true)
    expect(headless.asked).toHaveLength(0)
    expect(PairingState.read()).toEqual({ remoteAccepted: true })
  })

  test("serve and web suggest their own command for staying local", () => {
    expect(remoteWarning("pair")).toBe(pairWarning.join(os.EOL))
    expect(remoteWarning("serve").split(os.EOL)).toEqual([
      ...pairWarning.slice(0, 2),
      "To serve locally instead, run `opencode serve` without the --remote flag.",
    ])
    expect(remoteWarning("web").split(os.EOL).at(-1)).toBe(
      "To serve locally instead, run `opencode web` without the --remote flag.",
    )
  })
})

describe("remote access from the command line", () => {
  cliIt.live(
    "without a terminal, --remote fails before contacting a server or listening",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        // Stands in for the server to pair with: nothing may reach it, and a real server could get exposed.
        const requests: string[] = []
        const tripwire = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch: (request) => {
                requests.push(request.url)
                return new Response("unexpected request", { status: 503 })
              },
            }),
          ),
          (server) => Effect.promise(() => server.stop(true)),
        )
        const server = `http://127.0.0.1:${tripwire.port}`
        const env = { OPENCODE_SERVER_PASSWORD: "secret" }
        const [pair, combined, serve, help] = yield* Effect.all(
          [
            opencode.spawn(["pair", "--remote", server], { env }),
            opencode.spawn(["pair", "--remote", "--url", "https://dev.example.com", server], { env }),
            // No interface has this address, so even a serve that skipped consent could not listen and go remote.
            opencode.spawn(["serve", "--remote", "--hostname", "192.0.2.1"]),
            opencode.spawn(["pair", "--help"]),
          ],
          { concurrency: "unbounded" },
        )

        opencode.expectExit(pair, 1, "pair --remote")
        expect(pair.stderr).toContain([...pairWarning, "Run interactively or pass --yes to continue.", ""].join(os.EOL))
        opencode.expectExit(combined, 1, "pair --remote --url")
        expect(combined.stderr).toContain("--remote cannot be combined with --url")
        opencode.expectExit(serve, 1, "serve --remote")
        expect(serve.stderr).toContain(
          [
            ...pairWarning.slice(0, 2),
            "To serve locally instead, run `opencode serve` without the --remote flag.",
            "Run interactively or pass --yes to continue.",
            "",
          ].join(os.EOL),
        )
        expect(serve.stdout).not.toContain("listening on")
        opencode.expectExit(help, 0, "pair --help")
        for (const flag of ["--remote", "--yes", "--url"]) expect(help.stderr).toContain(flag)

        expect(requests).toEqual([])
        expect(fs.existsSync(path.join(home, ".config", "opencode", "pairing.json"))).toBe(false)
      }),
    120_000,
  )
})
