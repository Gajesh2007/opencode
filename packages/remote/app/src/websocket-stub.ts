// The opencode PTY terminal is the only part of packages/app that opens a raw
// WebSocket (components/terminal.tsx → `new WebSocket(ws://tunnel/pty/.../connect)`),
// bypassing platform.fetch. The relay tunnel only carries framed HTTP, so a PTY
// socket to the dummy `tunnel` host can never succeed. Rather than patch
// packages/app, we install a global guard: any WebSocket aimed at the `tunnel`
// host is replaced with a stub that stays in CONNECTING forever — it never opens,
// errors, or closes, so the terminal simply shows an idle pane and never enters a
// reconnect/clone loop. The real relay socket (a different host) is untouched.

class StubWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  readyState = 0
  binaryType: BinaryType = "blob"
  bufferedAmount = 0
  extensions = ""
  protocol = ""
  url: string

  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null

  constructor(url: string | URL) {
    super()
    this.url = String(url)
  }

  send() {}

  close() {
    this.readyState = this.CLOSED
  }
}

export function installTunnelWebSocketGuard(tunnelHost = "tunnel") {
  if (typeof window === "undefined") return
  const Native = window.WebSocket
  if (!Native || (Native as unknown as { __tunnelGuarded?: boolean }).__tunnelGuarded) return

  const Guarded = new Proxy(Native, {
    construct(target, args: [string | URL, (string | string[])?]) {
      const host = (() => {
        try {
          return new URL(String(args[0])).host
        } catch {
          return ""
        }
      })()
      if (host === tunnelHost) return new StubWebSocket(args[0]) as unknown as WebSocket
      return Reflect.construct(target, args)
    },
  })
  ;(Guarded as unknown as { __tunnelGuarded?: boolean }).__tunnelGuarded = true
  window.WebSocket = Guarded as unknown as typeof WebSocket
}
