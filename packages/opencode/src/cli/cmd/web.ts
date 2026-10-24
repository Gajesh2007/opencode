import { Effect } from "effect"
import { Server } from "../../server/server"
import { ServerPairing } from "../../server/pairing"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import {
  withNetworkOptions,
  resolveNetworkOptions,
  withRemoteOptions,
  prepareRemoteAccess,
  startRemoteAccess,
} from "../network"
import open from "open"
import { networkInterfaces } from "os"
import { withYoloForever } from "../yolo-forever"

function getNetworkIPs() {
  const nets = networkInterfaces()
  const results: string[] = []

  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue

    for (const netInfo of net) {
      // Skip internal and non-IPv4 addresses
      if (netInfo.internal || netInfo.family !== "IPv4") continue

      // Skip Docker bridge networks (typically 172.x.x.x)
      if (netInfo.address.startsWith("172.")) continue

      results.push(netInfo.address)
    }
  }

  return results
}

export const WebCommand = effectCmd({
  command: "web",
  builder: (yargs) =>
    withRemoteOptions(withNetworkOptions(withYoloForever(yargs))).option("dangerously-skip-permissions", {
      type: "boolean",
      describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
      default: false,
    }),
  describe: "start opencode server and open web interface",
  // Server loads instances per-request via x-opencode-directory header — no
  // ambient project InstanceContext needed at startup.
  instance: false,
  handler: Effect.fn("Cli.web")(function* (args) {
    if (args["dangerously-skip-permissions"]) process.env.OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS = "true"
    if (args.remote) {
      const print = (line: string) => UI.println(line)
      if (!(yield* Effect.promise(() => prepareRemoteAccess({ yes: args.yes, command: "web", print })))) return
    }
    if (!process.env.OPENCODE_SERVER_PASSWORD) {
      UI.println(UI.Style.TEXT_WARNING_BOLD + "!  OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    // The browser can't know a generated pairing password, so with --remote it signs in through a one-time link.
    const browse = (url: string) => {
      open(args.remote ? new URL(`/auth/connect/${ServerPairing.issue().code}`, url).href : url).catch(() => {})
    }
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    if (opts.hostname === "0.0.0.0") {
      // Show localhost for local access
      const localhostUrl = `http://localhost:${server.port}`
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, localhostUrl)

      // Show network IPs for remote access
      const networkIPs = getNetworkIPs()
      if (networkIPs.length > 0) {
        for (const ip of networkIPs) {
          UI.println(
            UI.Style.TEXT_INFO_BOLD + "  Network access:    ",
            UI.Style.TEXT_NORMAL,
            `http://${ip}:${server.port}`,
          )
        }
      }

      if (opts.mdns) {
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  mDNS:              ",
          UI.Style.TEXT_NORMAL,
          `${opts.mdnsDomain}:${server.port}`,
        )
      }

      // Open localhost in browser
      browse(localhostUrl)
    } else {
      const displayUrl = server.url.toString()
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
      browse(displayUrl)
    }

    if (args.remote)
      startRemoteAccess((line, status) =>
        status.state === "connected"
          ? UI.println(UI.Style.TEXT_INFO_BOLD + "  Remote access:     ", UI.Style.TEXT_NORMAL, status.url ?? "")
          : UI.println(UI.Style.TEXT_DIM + "  " + line + UI.Style.TEXT_NORMAL),
      )

    yield* Effect.never
  }),
})
