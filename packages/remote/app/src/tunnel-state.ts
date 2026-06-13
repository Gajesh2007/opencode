import { TunnelTransport } from "./tunnel"

// The relay tunnel is a process-wide singleton: the connect gate creates it once
// the user supplies relay/room/token, and the embedded opencode UI reaches it
// exclusively through `tunnelFetch` (installed as `platform.fetch`). Keeping it
// module-global means the platform object created at mount time always talks to
// the live connection without prop drilling.
let active: TunnelTransport | null = null

export function setActiveTunnel(tunnel: TunnelTransport | null) {
  active = tunnel
}

export function getActiveTunnel() {
  return active
}

// `typeof fetch` shaped adapter. The opencode SDK drives every REST + SSE call
// through `platform.fetch`, handing us a `Request` against the dummy
// `http://tunnel` base URL. We strip the base, forward the path + query, method,
// headers and body across the relay, and hand back the streaming `Response` the
// tunnel produces (so SSE on `/event` streams through unchanged).
export const tunnelFetch: typeof fetch = async (input, init) => {
  const tunnel = active
  if (!tunnel) throw new Error("Tunnel is not connected")

  if (input instanceof Request) {
    const url = new URL(input.url)
    const method = input.method || "GET"
    const hasBody = method !== "GET" && method !== "HEAD"
    const body = hasBody ? new Uint8Array(await input.arrayBuffer()) : undefined
    return tunnel.tunnelFetch(url.pathname + url.search, {
      method,
      headers: input.headers,
      body: body && body.byteLength > 0 ? body : undefined,
      signal: input.signal,
    })
  }

  const url = input instanceof URL ? input : new URL(String(input), "http://tunnel")
  return tunnel.tunnelFetch(url.pathname + url.search, init)
}
