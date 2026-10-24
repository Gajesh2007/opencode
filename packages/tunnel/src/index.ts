// Remote access through OpenTunnel. The SDK runs on a stable Effect release, so this package keeps its own copy
// and exposes only promises: no Effect value crosses into opencode's runtime.
//
// OpenTunnel keeps one tunnel per device in its default profile, shared by the opentunnel CLI and every app using
// the SDK; each claims its own routes. opencode claims a random subdomain (its route) rather than the tunnel
// hostname: tunnel hostnames appear in public certificate logs, but the certificate covers subdomains with a
// wildcard, so a random route keeps the server's address unguessable. TLS terminates inside this process, so the
// relay only forwards ciphertext.

import {
  create,
  isValidRouteName,
  OpenTunnelAttachError,
  OpenTunnelClientError,
  OpenTunnelStorage,
  type OpenTunnelProvisionStage,
} from "@opentunnel/client"

export type Stage = OpenTunnelProvisionStage

export type Connection = {
  /** Public URL of the route. */
  readonly url: string
  /** Settles when the tunnel stops, after a fatal error or `close`. */
  readonly closed: Promise<void>
  readonly close: () => Promise<void>
}

export type RunEvent =
  | { readonly type: "connecting" }
  | { readonly type: "connected"; readonly url: string }
  | { readonly type: "retrying"; readonly error: string; readonly delay: number }
  | { readonly type: "stopped"; readonly error?: string }

export type Connect = (input: { route: string; target: string; signal?: AbortSignal }) => Promise<Connection>

const MAX_DELAY = 30_000

export const validRoute = (route: string) => isValidRouteName(route)

/** Creates this device's tunnel when it has none (issuing its certificate can take a minute), else returns it. */
export function ensure(input?: { onProgress?: (stage: Stage) => void }) {
  const client = create()
  return client.tunnel
    .ensure({ onProgress: input?.onProgress })
    .then((identity) => ({ hostname: identity.hostname }))
    .finally(() => client.dispose())
}

/** Routes `route` to `target` ("host:port"). Resolves once the bridge first attaches; reconnects until closed. */
export const connect: Connect = (input) => {
  const client = create()
  return client.tunnel.connect({ routes: { [input.route]: input.target }, signal: input.signal }).then(
    (connection) => ({
      url: `https://${input.route}.${connection.tunnel.hostname}`,
      closed: connection.closed.finally(() => client.dispose()),
      close: () => connection.close(),
    }),
    (error: unknown) => client.dispose().then(() => Promise.reject(error)),
  )
}

/** The route's public hostname once this device has a tunnel. Reads local storage only. */
export function hostname(route: string) {
  return OpenTunnelStorage.xdg()
    .load("default")
    .then((identity) => (identity ? `${route}.${identity.hostname}` : undefined))
}

/** Setup failures that retrying cannot fix: a rejected token, a failed certificate, or an unusable proxy. */
export function fatal(error: unknown) {
  return (
    error instanceof OpenTunnelClientError &&
    (error.cause instanceof OpenTunnelAttachError ||
      error.message.startsWith("Certificate issuance failed") ||
      /unsupported proxy scheme|not a valid proxy URL/.test(error.message))
  )
}

/**
 * Keeps `route` attached to `target` until `signal` aborts. The SDK reconnects through network failures itself,
 * so only setup failures and unexpected closes reach the retry here, with exponential backoff capped at 30
 * seconds. A fatal failure stops for good.
 */
export async function run(input: {
  route: string
  target: string
  signal: AbortSignal
  onEvent: (event: RunEvent) => void
  /** Overrides the transport, for tests. */
  connect?: Connect
}) {
  const open = input.connect ?? connect
  let delay = 1_000
  while (!input.signal.aborted) {
    input.onEvent({ type: "connecting" })
    const failure = await open({ route: input.route, target: input.target, signal: input.signal }).then(
      (connection) => hold(connection, input),
      (error: unknown) => error,
    )
    if (input.signal.aborted) break
    if (fatal(failure)) return input.onEvent({ type: "stopped", error: message(failure) })
    // A connection that came up and later closed starts the backoff over.
    if (failure === undefined) delay = 1_000
    input.onEvent({ type: "retrying", error: failure === undefined ? "Tunnel closed" : message(failure), delay })
    await sleep(delay, input.signal)
    delay = Math.min(delay * 2, MAX_DELAY)
  }
  input.onEvent({ type: "stopped" })
}

// Holds an attached connection until it closes or the caller aborts; resolves with the closing error, if any.
async function hold(connection: Connection, input: { signal: AbortSignal; onEvent: (event: RunEvent) => void }) {
  // Listen before announcing the URL: a listener may abort as soon as it hears about it.
  const stop = () => void connection.close()
  input.signal.addEventListener("abort", stop, { once: true })
  input.onEvent({ type: "connected", url: connection.url })
  if (input.signal.aborted) stop()
  const failure = await connection.closed.then(
    () => undefined,
    (error: unknown) => error,
  )
  input.signal.removeEventListener("abort", stop)
  return failure
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    // An already-aborted signal never fires "abort"; listeners can abort from inside the "retrying" event.
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
  })
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
