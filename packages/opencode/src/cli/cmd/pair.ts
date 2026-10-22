import { EOL } from "os"
import { cmd } from "./cmd"
import { ServerAuth } from "@/server/auth"
import { errorMessage } from "@/util/error"
import { renderUnicodeCompact } from "uqr"

const DEFAULT_SERVER = "http://127.0.0.1:4096"

type ServerInfo = { urls?: string[] }

type PairingCode = { code: string; expires_in: number }

function normalizeServerUrl(input: string) {
  const url = new URL(input.includes("://") ? input : `http://${input}`)
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  return url.origin
}

function isLoopback(hostname: string) {
  return (
    hostname === "localhost" || hostname.endsWith(".localhost") || hostname.startsWith("127.") || hostname === "[::1]"
  )
}

async function requestJSON<T>(url: string, init: RequestInit & { headers: Record<string, string> }) {
  const response = await fetch(url, init)
  if (response.status === 404)
    throw new Error("the server does not support pairing; upgrade opencode on the machine running the server")
  if (response.status === 401) throw new Error("wrong username or password")
  if (!response.ok) throw new Error(`server error ${response.status}`)
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- boundary cast of an untyped JSON body
  return (await response.json()) as T
}

export const PairCommand = cmd({
  command: "pair [url]",
  describe: "pair the opencode app with a running server (prints connect links and a QR code)",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: `server URL (default ${DEFAULT_SERVER})`,
      })
      .option("password", {
        alias: "p",
        type: "string",
        describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: "u",
        type: "string",
        describe: "basic auth username (defaults to OPENCODE_SERVER_USERNAME or 'opencode')",
      })
      .option("advertise", {
        type: "string",
        describe: "advertise an external URL (reverse proxy or tunnel) in links and the QR code",
      }),
  handler: async (args) => {
    const base = normalizeServerUrl(args.url ?? DEFAULT_SERVER)
    const advertise = args.advertise ? normalizeServerUrl(args.advertise) : undefined
    if (!base) throw new Error(`invalid server URL: ${args.url ?? DEFAULT_SERVER}`)
    if (args.advertise && !advertise) throw new Error(`invalid advertise URL: ${args.advertise}`)

    const headers = ServerAuth.headers({ password: args.password, username: args.username })
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

    try {
      // Fork-local route (the app-facing v2 probe path /api/info deliberately does
      // not exist, so mobile clients detect this server as the v1 contract it fully serves).
      const info = await requestJSON<ServerInfo>(`${base}/global/info`, { headers })
      const pairing = await requestJSON<PairingCode>(`${base}/api/pair`, { method: "POST", headers })

      const urls = [...new Set([...(advertise ? [advertise] : []), ...(info.urls?.length ? info.urls : [base])])]
      const links = urls.map((url) => new URL(`/auth/connect/${pairing.code}`, url).href)
      // Loopback URLs are useless to the scanning device, so the QR code only carries reachable addresses.
      const remote = urls.filter((url) => !isLoopback(new URL(url).hostname))

      process.stdout.write(
        [
          "",
          `  Open a link to connect. Links work once and expire in ${Math.round(pairing.expires_in / 60)} minutes.`,
          "",
          ...links.map((link) => `  ${link}`),
          ...(remote.length
            ? [
                "",
                // uqr separates rows with "\n" on every platform, so splitting on EOL ("\r\n" on Windows) indents only the first row.
                renderUnicodeCompact(JSON.stringify({ code: pairing.code, urls: remote }), { border: 2 })
                  .split("\n")
                  .map((line) => "  " + line)
                  .join(EOL),
              ]
            : []),
          "",
          ...(remote.length
            ? ["  Scan the QR code with the opencode app, or open a link on the device.", ""]
            : [
                "  The server only listens on this machine, so the QR code is omitted.",
                "",
                "  Over SSH? Forward the port, then open the link on your machine:",
                `  ssh -L ${new URL(base).port}:127.0.0.1:${new URL(base).port} <host>`,
                "",
                "  To connect from other devices, restart the server listening on your network",
                '  (`opencode serve --hostname 0.0.0.0`, or set "hostname": "0.0.0.0" under "server" in config).',
                "",
              ]),
        ].join(EOL) + EOL,
      )
    } catch (error) {
      process.stderr.write(`Pairing failed: ${errorMessage(error)}${EOL}`)
      process.exitCode = 1
    }
  },
})
