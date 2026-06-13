import { type Platform, ServerConnection } from "@opencode-ai/app"
import { tunnelFetch } from "./tunnel-state"

// The dummy base URL every SDK request is built against. It is intentionally a
// non-loopback `http://` host so packages/app routes the SSE event stream through
// `platform.fetch` too (see context/global-sdk.tsx), and so `server.isLocal()`
// stays false (the host injects opencode Basic auth, and the manual directory
// dialog is used instead of a native picker).
export const TUNNEL_URL = "http://tunnel"

const notify: Platform["notify"] = async (title, description) => {
  if (!("Notification" in window)) return
  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission
  if (permission !== "granted") return
  if (document.visibilityState === "visible" && document.hasFocus()) return
  new Notification(title, { body: description ?? "" })
}

export const platform: Platform = {
  platform: "web",
  openLink: (url) => {
    window.open(url, "_blank")
  },
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  restart: async () => {
    window.location.reload()
  },
  notify,
  // The single injection point: every REST + SSE call the embedded opencode UI
  // makes flows through the relay tunnel instead of the network.
  fetch: tunnelFetch,
  getDefaultServer: async () => ServerConnection.Key.make(TUNNEL_URL),
  setDefaultServer: () => {},
}

export const tunnelServer: ServerConnection.Http = {
  type: "http",
  http: { url: TUNNEL_URL },
}

export const tunnelServerKey = ServerConnection.Key.make(TUNNEL_URL)
