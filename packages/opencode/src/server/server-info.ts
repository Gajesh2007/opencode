export * as ServerInfo from "./server-info"

import { networkInterfaces } from "node:os"

let current: ReadonlyArray<string> = []
let remote: ReadonlyArray<string> = []

// Registered by Server.listen so /global/info can advertise every address the
// server is reachable on. The last listener wins, matching Server.url.
export function setURLs(urls: ReadonlyArray<string>) {
  current = urls
}

// Remote access URLs (an OpenTunnel route) while the tunnel is attached.
export function setRemoteURLs(urls: ReadonlyArray<string>) {
  remote = urls
}

/** Local addresses first, then remote ones. */
export function urls() {
  return [...current, ...remote]
}

/** "host:port" of the network listener, for remote access to route to; undefined without a listener. */
export function target() {
  const first = current[0]
  return first ? new URL(first).host : undefined
}

// Expand wildcard bindings into the concrete addresses a client can use.
export function connectionURLs(value: string) {
  const url = new URL(value)
  const family =
    url.hostname === "0.0.0.0" ? "IPv4" : url.hostname === "::" || url.hostname === "[::]" ? "IPv6" : undefined
  if (family === undefined) return [value]

  const loopback = new URL(value)
  loopback.hostname = family === "IPv6" ? "[::1]" : "127.0.0.1"
  return [
    ...new Set([
      loopback.toString().replace(/\/$/, ""),
      ...Object.values(networkInterfaces())
        .flatMap((entries) => entries ?? [])
        .filter((entry) => !entry.internal && entry.family === family)
        .map((entry) => {
          const result = new URL(value)
          result.hostname = family === "IPv6" ? `[${entry.address}]` : entry.address
          return result.toString().replace(/\/$/, "")
        }),
    ]),
  ]
}
