import type { Argv, InferredOptionTypes } from "yargs"
import { Config } from "@/config/config"
import { PairingState } from "@/server/pairing-state"
import { RemoteAccess } from "@/server/remote"
import { ServerInfo } from "@/server/server-info"
import { Effect } from "effect"
import { remoteConsent } from "./remote-consent"

const options = {
  port: {
    type: "number" as const,
    describe: "port to listen on",
    default: 0,
  },
  hostname: {
    type: "string" as const,
    describe: "hostname to listen on",
    default: "127.0.0.1",
  },
  mdns: {
    type: "boolean" as const,
    describe: "enable mDNS service discovery (defaults hostname to 0.0.0.0)",
    default: false,
  },
  "mdns-domain": {
    type: "string" as const,
    describe: "custom domain name for mDNS service (default: opencode.local)",
    default: "opencode.local",
  },
  cors: {
    type: "string" as const,
    array: true,
    describe: "additional domains to allow for CORS",
    default: [] as string[],
  },
}

export type NetworkOptions = InferredOptionTypes<typeof options>

export function withNetworkOptions<T>(yargs: Argv<T>) {
  return yargs.options(options)
}
export const resolveNetworkOptions = Effect.fn("Cli.resolveNetworkOptions")(function* (args: NetworkOptions) {
  const config = yield* Config.Service.use((cfg) => cfg.getGlobal())
  return resolveNetworkOptionsNoConfig(args, config)
})

export function resolveNetworkOptionsNoConfig(args: NetworkOptions, config?: Config.Info) {
  const portExplicitlySet = process.argv.includes("--port")
  const hostnameExplicitlySet = process.argv.includes("--hostname")
  const mdnsExplicitlySet = process.argv.includes("--mdns")
  const mdnsDomainExplicitlySet = process.argv.includes("--mdns-domain")
  const mdns = mdnsExplicitlySet ? args.mdns : (config?.server?.mdns ?? args.mdns)
  const mdnsDomain = mdnsDomainExplicitlySet ? args["mdns-domain"] : (config?.server?.mdnsDomain ?? args["mdns-domain"])
  const port = portExplicitlySet ? args.port : (config?.server?.port ?? args.port)
  const hostname = hostnameExplicitlySet
    ? args.hostname
    : mdns && !config?.server?.hostname
      ? "0.0.0.0"
      : (config?.server?.hostname ?? args.hostname)
  const configCors = config?.server?.cors ?? []
  const argsCors = Array.isArray(args.cors) ? args.cors : args.cors ? [args.cors] : []
  const cors = [...configCors, ...argsCors]

  return { hostname, port, mdns, mdnsDomain, cors }
}

const remoteOptions = {
  remote: {
    type: "boolean" as const,
    describe: "expose the server to the internet through an OpenTunnel remote address (asks the first time)",
    default: false,
  },
  yes: {
    alias: "y",
    type: "boolean" as const,
    describe:
      "accept exposing the server to the internet when --remote enables remote access for the first time (required without an interactive terminal)",
    default: false,
  },
}

export function withRemoteOptions<T>(yargs: Argv<T>) {
  return yargs.options(remoteOptions)
}

/**
 * Before Server.listen with --remote: asks to expose the server the first time, then makes sure it has a password,
 * falling back to the saved pairing password that `opencode pair` reads. Returns whether to go on.
 */
export async function prepareRemoteAccess(input: {
  yes: boolean
  command: "serve" | "web"
  print: (line: string) => void
}) {
  if (!(await remoteConsent({ yes: input.yes, command: input.command }))) return false
  if (process.env.OPENCODE_SERVER_PASSWORD) return true
  // Set before Server.listen: each listener reads its auth config from the environment when it starts.
  process.env.OPENCODE_SERVER_PASSWORD = PairingState.password()
  input.print(
    "OPENCODE_SERVER_PASSWORD is not set; using the saved pairing password (`opencode pair` reads it automatically).",
  )
  return true
}

/** After Server.listen with --remote: routes remote access to the listener and prints its status changes. */
export function startRemoteAccess(print: (line: string, status: RemoteAccess.Status) => void) {
  const printer = remoteStatusPrinter(print)
  const unsubscribe = RemoteAccess.subscribe(printer)
  const target = ServerInfo.target()
  if (target === undefined) {
    printer({ enabled: false, state: "error", error: "no network listener" })
    return unsubscribe
  }
  RemoteAccess.enable({ target })
  return unsubscribe
}

/** Prints each remote access status change once. A new attempt after a failed one is not news. */
export function remoteStatusPrinter(print: (line: string, status: RemoteAccess.Status) => void) {
  let last: RemoteAccess.Status | undefined
  return (status: RemoteAccess.Status) => {
    const line = remoteStatusLine(status)
    const retry = status.state === "connecting" && !status.error && last?.state === "connecting"
    if (retry || (last !== undefined && line === remoteStatusLine(last))) return
    last = status
    print(line, status)
  }
}

function remoteStatusLine(status: RemoteAccess.Status) {
  if (status.state === "connected") return `Remote access: ${status.url ?? "connected"}`
  if (status.state === "provisioning") return "Setting up remote access; this can take a minute..."
  if (status.state === "error") return `Remote access failed: ${status.error ?? "unknown error"}`
  if (status.state === "off") return "Remote access is off."
  if (status.error) return `Remote access unavailable (${status.error}); retrying...`
  return "Remote access connecting..."
}
