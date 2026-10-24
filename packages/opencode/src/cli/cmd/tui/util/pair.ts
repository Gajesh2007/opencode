import type { RemoteStatus } from "@opencode-ai/sdk/v2"
import { isRecord } from "@/util/record"

/** The address and credentials of the server's network listener, or why it has none. */
export type Listener = { url: string; username: string; password: string } | { error: string }

/** The OpenCode app reads a pairing payload; a phone's camera app only opens plain links. */
export type QRMode = "app" | "browser"

/** Loopback addresses only reach the machine the server runs on. */
export function isLoopback(hostname: string) {
  return (
    hostname === "localhost" || hostname.endsWith(".localhost") || hostname.startsWith("127.") || hostname === "[::1]"
  )
}

/** Whether a client that reaches the server at `url` runs on the server's machine. */
export function isLocal(url: string) {
  const hostname = new URL(url).hostname
  return isLoopback(hostname) || hostname === "0.0.0.0" || hostname === "[::]"
}

export function link(url: string, code: string) {
  return new URL(`/auth/connect/${code}`, url).href
}

/** The server's usable URLs, with the remote access URL first while it is connected. */
export function order(urls: readonly string[], remote: RemoteStatus | undefined) {
  const first = remote?.state === "connected" && remote.url ? [remote.url] : []
  return [...new Set([...first, ...urls])].filter((url) => URL.canParse(url))
}

/** URLs that other devices may reach. */
export function reachable(urls: readonly string[]) {
  return urls.filter((url) => !isLoopback(new URL(url).hostname))
}

/** A link for a browser on the server's machine, through its first loopback URL. */
export function localLink(urls: readonly string[], code: string) {
  const loopback = urls.find((url) => isLoopback(new URL(url).hostname))
  if (!loopback) return
  const url = new URL(loopback)
  url.hostname = "localhost"
  return link(url.href, code)
}

/**
 * The QR code's content, or nothing when no URL is reachable from another device. The app gets every reachable
 * URL so it can use whichever answers; a browser gets a link through the best one.
 */
export function qrContent(mode: QRMode, code: string, urls: readonly string[]) {
  const targets = reachable(urls)
  if (targets.length === 0) return
  if (mode === "browser") return link(targets[0], code)
  return JSON.stringify({ code, urls: targets })
}

export function secondsLeft(expires: number, now: number) {
  return Math.max(0, Math.ceil((expires - now) / 1000))
}

export function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

/** Remote access keeps changing on its own until it is off, connected, or stopped by an error. */
export function settled(status: RemoteStatus) {
  return status.state === "off" || status.state === "connected" || status.state === "error"
}

export function remoteSummary(status: RemoteStatus) {
  if (status.state === "connected") return { tone: "success", text: "On", busy: false } as const
  if (status.state === "provisioning")
    return { tone: "warning", text: "Setting up, this can take a minute…", busy: true } as const
  if (status.state === "connecting")
    return {
      tone: "warning",
      text: status.error ? `Connecting… (${status.error})` : "Connecting…",
      busy: true,
    } as const
  if (status.state === "error") return { tone: "error", text: status.error || "Remote access stopped", busy: false } as const
  return { tone: "muted", text: "Off", busy: false } as const
}

/** A readable reason for a failed SDK request. */
export function failure(result: { error?: unknown; response?: Response }, feature = "pairing") {
  const status = result.response?.status
  if (status === 401) return "The server rejected this client's credentials."
  if (status === 404) return `The server does not support ${feature}; upgrade opencode on the machine running it.`
  const message = errorText(result.error)
  if (message) return message
  if (status) return `The server responded with HTTP ${status}.`
  return "Could not reach the server."
}

// Only explicit messages: error bodies may be empty objects or a proxy's HTML page.
function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  if (!isRecord(error)) return
  if (typeof error.message === "string") return error.message
  if (isRecord(error.data) && typeof error.data.message === "string") return error.data.message
}

export * as Pair from "./pair"
