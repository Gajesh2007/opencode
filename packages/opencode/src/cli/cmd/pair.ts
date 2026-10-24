import { EOL } from "os"
import { cmd } from "./cmd"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ServerAuth } from "@/server/auth"
import { PairingState } from "@/server/pairing-state"
import type { RemoteAccess } from "@/server/remote"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { renderUnicodeCompact } from "uqr"
import { UI } from "../ui"
import { remoteStatusPrinter } from "../network"
import { remoteConsent } from "../remote-consent"

const DEFAULT_SERVER = "http://127.0.0.1:4096"

const REMOTE_TIMEOUT = 3 * 60 * 1000

const REMOTE_TIMEOUT_MESSAGE = [
  "Timed out waiting for the remote tunnel; run `opencode pair --remote` again to retry.",
  // The tunnel runs in the server's process, so only the server's environment matters.
  "Behind an HTTP proxy, start the server with HTTPS_PROXY set to the proxy's address (and NO_PROXY for hosts to reach directly).",
].join(EOL)

type ServerInfo = { urls?: string[] }

type PairingCode = { code: string; expires_in: number }

export const PairCommand = cmd({
  command: "pair [server]",
  describe: "pair the opencode app with a running server (prints connect links and a QR code)",
  builder: (yargs) =>
    yargs
      .positional("server", {
        type: "string",
        describe: `server URL (default ${DEFAULT_SERVER})`,
      })
      .option("password", {
        alias: "p",
        type: "string",
        describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD, then the saved pairing password)",
      })
      .option("username", {
        alias: "u",
        type: "string",
        describe: "basic auth username (defaults to OPENCODE_SERVER_USERNAME or 'opencode')",
      })
      .option("url", {
        type: "string",
        describe: "use this external HTTP(S) server URL in links and the QR code instead of the server's own",
      })
      .option("advertise", {
        type: "string",
        describe:
          "advertise an external URL (reverse proxy or tunnel) in links and the QR code, ahead of the server's own",
      })
      .option("remote", {
        type: "boolean",
        default: false,
        describe:
          "pair through the OpenTunnel remote address, enabling remote access if needed (exposes the server to the internet)",
      })
      .option("yes", {
        alias: "y",
        type: "boolean",
        default: false,
        describe:
          "accept exposing the server to the internet when --remote enables remote access for the first time (required without an interactive terminal)",
      }),
  handler: async (args) => {
    if (args.remote && args.url !== undefined) return fail("--remote cannot be combined with --url")
    const server = args.server ?? DEFAULT_SERVER
    const base = normalizeServerUrl(server)
    if (!base) return fail(`invalid server URL: ${server}`)
    const url = args.url === undefined ? undefined : pairingURL(args.url)
    if (args.url !== undefined && url === undefined)
      return fail("invalid --url: expected an HTTP(S) server URL without credentials, query parameters, or a fragment")
    const advertise = args.advertise ? normalizeServerUrl(args.advertise) : undefined
    if (args.advertise && !advertise) return fail(`invalid advertise URL: ${args.advertise}`)

    const headers = ServerAuth.headers({
      password: pairPassword({
        flag: args.password,
        env: Flag.OPENCODE_SERVER_PASSWORD,
        saved: PairingState.read().password,
      }),
      username: args.username,
    })
    if (!headers) {
      process.stderr.write(
        [
          "No password configured; pairing requires one.",
          "",
          "Start the server with OPENCODE_SERVER_PASSWORD set (or pass --password here to match it),",
          "then run `opencode pair` again.",
          "",
        ].join(EOL) + EOL,
      )
      process.exitCode = 1
      return
    }
    if (args.remote && !(await remoteConsent({ yes: args.yes }))) return

    try {
      const urls = args.remote ? [await remoteURL(base, headers)] : url ? [url] : await serverURLs(base, headers)
      const pairing = await requestJSON<PairingCode>(`${base}/api/pair`, { method: "POST", headers })

      const all = [...new Set([...(advertise ? [advertise] : []), ...urls])]
      const links = all.map((item) => new URL(`/auth/connect/${pairing.code}`, item).href)
      // Loopback URLs are useless to the scanning device, so the QR code only carries reachable addresses.
      const reachable = all.filter((item) => !isLoopback(new URL(item).hostname))
      const hints = reachable.length
        ? ["  Scan the QR code with the opencode app, or open a link on the device.", ""]
        : args.remote || url
          ? []
          : [
              "  The server only listens on this machine, so the QR code is omitted.",
              "",
              "  Over SSH? Forward the port, then open the link on your machine:",
              `  ssh -L ${new URL(base).port}:127.0.0.1:${new URL(base).port} <host>`,
              "",
              "  To connect from other devices, restart the server listening on your network",
              '  (`opencode serve --hostname 0.0.0.0`, or set "hostname": "0.0.0.0" under "server" in config).',
              "",
            ]

      process.stdout.write(
        [
          "",
          `  Open a link to connect. Links work once and expire in ${Math.round(pairing.expires_in / 60)} minutes.`,
          "",
          ...links.map((link) => `  ${link}`),
          ...(reachable.length
            ? [
                "",
                // uqr separates rows with "\n" on every platform, so splitting on EOL ("\r\n" on Windows) indents only the first row.
                renderUnicodeCompact(JSON.stringify({ code: pairing.code, urls: reachable }), { border: 2 })
                  .split("\n")
                  .map((line) => "  " + line)
                  .join(EOL),
              ]
            : []),
          "",
          ...hints,
        ].join(EOL) + EOL,
      )
    } catch (error) {
      process.stderr.write(`Pairing failed: ${errorMessage(error)}${EOL}`)
      process.exitCode = 1
    }
  },
})

/**
 * The password to pair with: --password, then OPENCODE_SERVER_PASSWORD, then the saved pairing password that
 * servers started with --remote, or by the TUI's /pair, use.
 */
export function pairPassword(input: { flag?: string; env?: string; saved?: string }) {
  return input.flag || input.env || input.saved || undefined
}

/** The --url value as links use it, or undefined unless it is an HTTP(S) URL without credentials, query, or fragment. */
export function pairingURL(value: string) {
  const url = URL.parse(value)
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined
  if (url.username || url.password || url.search || url.hash) return undefined
  return (url.origin + url.pathname).replace(/\/+$/, "")
}

/** Follows the server's remote access status until its tunnel connects, and returns the public URL. */
export async function waitForRemote(input: {
  first: RemoteAccess.Status
  status: () => Promise<RemoteAccess.Status>
  print: (line: string) => void
  interval?: number
  timeout?: number
}) {
  const deadline = Date.now() + (input.timeout ?? REMOTE_TIMEOUT)
  const printer = remoteStatusPrinter(input.print)
  const follow = async (current: RemoteAccess.Status): Promise<string> => {
    if (current.state === "connected" && current.url) return current.url
    if (current.state === "error") throw new Error(`remote access error: ${current.error ?? "unknown error"}`)
    if (current.state === "off") throw new Error("remote access was turned off")
    printer(current)
    if (Date.now() >= deadline) throw new Error(REMOTE_TIMEOUT_MESSAGE)
    await Bun.sleep(input.interval ?? 1000)
    return follow(await input.status())
  }
  return follow(input.first)
}

// Turns remote access on; the server attaches the tunnel in the background.
async function remoteURL(base: string, headers: Record<string, string>) {
  const request = (init?: RequestInit) =>
    requestJSON<RemoteAccess.Status>(
      `${base}/api/remote`,
      { ...init, headers: { ...headers, "Content-Type": "application/json" } },
      "remote access",
    )
  return waitForRemote({
    first: await request({ method: "POST", body: JSON.stringify({ enabled: true }) }),
    status: () => request(),
    print: (line) => process.stderr.write(`  ${line}${EOL}`),
  })
}

async function serverURLs(base: string, headers: Record<string, string>) {
  // Fork-local route (the app-facing v2 probe path /api/info deliberately does
  // not exist, so mobile clients detect this server as the v1 contract it fully serves).
  const info = await requestJSON<ServerInfo>(`${base}/global/info`, { headers })
  return info.urls?.length ? info.urls : [base]
}

function normalizeServerUrl(input: string) {
  const url = URL.parse(input.includes("://") ? input : `http://${input}`)
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return undefined
  return url.origin
}

function isLoopback(hostname: string) {
  return (
    hostname === "localhost" || hostname.endsWith(".localhost") || hostname.startsWith("127.") || hostname === "[::1]"
  )
}

async function requestJSON<T>(
  url: string,
  init: RequestInit & { headers: Record<string, string> },
  feature = "pairing",
) {
  const response = await fetch(url, init)
  if (response.status === 404)
    throw new Error(`the server does not support ${feature}; upgrade opencode on the machine running the server`)
  if (response.status === 401) throw new Error("wrong username or password")
  if (!response.ok) throw new Error(await rejection(response))
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- boundary cast of an untyped JSON body
  return (await response.json()) as T
}

// Rejected requests (e.g. remote access without a server password) explain themselves in a JSON `message`.
async function rejection(response: Response) {
  const body: unknown = await response.json().catch(() => undefined)
  return isRecord(body) && typeof body.message === "string" ? body.message : `server error ${response.status}`
}

function fail(message: string) {
  UI.error(message)
  process.exitCode = 1
}
