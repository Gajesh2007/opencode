export * as RemoteAccess from "./remote"

import * as Log from "@opencode-ai/core/util/log"
import type * as TunnelModule from "@opencode-ai/tunnel"
import { PairingState } from "./pairing-state"
import { ServerInfo } from "./server-info"

const log = Log.create({ service: "remote-access" })

// "provisioning": this device has no tunnel yet; issuing its certificate can take a minute.
export type State = "off" | "provisioning" | "connecting" | "connected" | "error"

export type Status = {
  enabled: boolean
  state: State
  /** Public HTTPS URL of the route while connected. */
  url?: string
  error?: string
}

/** What remote access drives of `@opencode-ai/tunnel`. */
export type Tunnel = Pick<typeof TunnelModule, "hostname" | "run">

// Loaded lazily: it carries its own Effect runtime and is only needed once remote access is on.
const realTunnel = (): Promise<Tunnel> => import("@opencode-ai/tunnel")

// One tunnel route per process, attached to its network listener (like ServerInfo and pairing codes).
let current: Status = { enabled: false, state: "off" }
let active: { controller: AbortController; target: string } | undefined
let loadTunnel = realTunnel
const listeners = new Set<(status: Status) => void>()

export function status() {
  return current
}

export function subscribe(listener: (status: Status) => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/**
 * Routes this machine's remote-access route to `target` ("host:port"), until disabled. Returns at once; the
 * tunnel attaches in the background and `status` follows it. Enabling again with the same target is a no-op,
 * unless the tunnel stopped for good with an error: then it starts over.
 */
export function enable(input: { target: string }) {
  if (active?.target === input.target && current.state !== "error") return current
  if (active) disable()
  const controller = new AbortController()
  active = { controller, target: input.target }
  set({ enabled: true, state: "connecting" })
  void start(input.target, controller.signal).catch((error: unknown) => {
    if (controller.signal.aborted) return
    log.error("remote access failed", { error: message(error) })
    set({ enabled: true, state: "error", error: message(error) })
  })
  return current
}

export function disable() {
  active?.controller.abort()
  active = undefined
  ServerInfo.setRemoteURLs([])
  set({ enabled: false, state: "off" })
  return current
}

/**
 * Replaces the tunnel, for tests: they must never load the real one, which would expose the machine to the
 * internet. Returns a function that restores the previous tunnel.
 */
export function setTunnel(tunnel: Tunnel) {
  const previous = loadTunnel
  loadTunnel = () => Promise.resolve(tunnel)
  return () => {
    loadTunnel = previous
  }
}

async function start(target: string, signal: AbortSignal) {
  // Inside the async start so that failing to save a new route surfaces as an error status.
  const route = PairingState.route()
  const tunnel = await loadTunnel()
  if (signal.aborted) return
  const hostname = await tunnel.hostname(route)
  // Disabled meanwhile: a late "provisioning" would overwrite the status of whatever came next.
  if (signal.aborted) return
  if (hostname === undefined) set({ enabled: true, state: "provisioning" })
  await tunnel.run({
    route,
    target,
    signal,
    onEvent: (event) => {
      if (signal.aborted) return
      if (event.type === "connected") {
        ServerInfo.setRemoteURLs([event.url])
        log.info("remote access connected", { url: event.url })
        return set({ enabled: true, state: "connected", url: event.url })
      }
      ServerInfo.setRemoteURLs([])
      if (event.type === "connecting")
        return set({ enabled: true, state: current.state === "provisioning" ? "provisioning" : "connecting" })
      if (event.type === "retrying") {
        log.warn("remote access unavailable; retrying", { error: event.error, delay: event.delay })
        return set({ enabled: true, state: "connecting", error: event.error })
      }
      log.error("remote access stopped", { error: event.error })
      set({ enabled: true, state: "error", error: event.error ?? "Remote access stopped" })
    },
  })
}

function set(next: Status) {
  current = next
  for (const listener of listeners) listener(next)
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
