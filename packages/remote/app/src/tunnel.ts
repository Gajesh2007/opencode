export type ConnectionState = "connecting" | "connected" | "disconnected"
export type HostState = "online" | "offline"

export class TunnelTransport {
  private ws: WebSocket | null = null
  private activeRequests = new Map<
    string,
    {
      resolveHeaders: (head: { status: number; headers: Record<string, string> }) => void
      reject: (err: Error) => void
      controller?: ReadableStreamDefaultController<Uint8Array>
      aborted?: boolean
    }
  >()
  private reconnectTimeout: any = null
  private pingInterval: any = null
  private backoffMs = 1000

  public connectionState: ConnectionState = "disconnected"
  public hostState: HostState = "offline"

  constructor(
    private relayUrl: string,
    private room: string,
    private token: string,
    private onConnectionStateChange?: (state: ConnectionState) => void,
    private onHostStateChange?: (state: HostState) => void
  ) {}

  public connect() {
    this.disconnect()

    this.setConnectionState("connecting")

    let wsUrl = this.relayUrl.replace(/^http/, "ws")
    if (!wsUrl.includes("://")) {
      wsUrl = "ws://" + wsUrl
    }

    const connectionUrl = `${wsUrl}/client?room=${encodeURIComponent(this.room)}&token=${encodeURIComponent(this.token)}`
    console.log(`[Tunnel] Connecting to ${wsUrl} in room: ${this.room}...`)

    try {
      const socket = new WebSocket(connectionUrl)
      this.ws = socket

      socket.onopen = () => {
        console.log(`[Tunnel] WebSocket connected successfully to room ${this.room}`)
        this.setConnectionState("connected")
        this.backoffMs = 1000

        this.pingInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ t: "ping" }))
          }
        }, 10000)
      }

      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return

        if (event.data === '{"t":"ping"}') {
          socket.send('{"t":"pong"}')
          return
        }
        if (event.data === '{"t":"pong"}') {
          return
        }

        try {
          const frame = JSON.parse(event.data)
          this.handleFrame(frame)
        } catch (err) {
          console.error("[Tunnel] Error parsing frame:", err)
        }
      }

      socket.onclose = (event) => {
        console.log(`[Tunnel] Connection closed: code=${event.code}, reason=${event.reason}`)
        this.handleDisconnect()
      }

      socket.onerror = (err) => {
        console.error("[Tunnel] WebSocket error:", err)
      }
    } catch (err) {
      console.error("[Tunnel] Error initiating WebSocket:", err)
      this.handleDisconnect()
    }
  }

  public disconnect() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    if (this.ws) {
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.onmessage = null
      this.ws.close()
      this.ws = null
    }
    this.setConnectionState("disconnected")
    this.setHostState("offline")
    this.cleanupActiveRequests(new Error("Tunnel disconnected"))
  }

  private handleDisconnect() {
    this.ws = null
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
    this.setConnectionState("disconnected")
    this.setHostState("offline")
    this.cleanupActiveRequests(new Error("Tunnel connection closed"))

    if (!this.reconnectTimeout) {
      console.log(`[Tunnel] Reconnecting in ${this.backoffMs}ms...`)
      this.reconnectTimeout = setTimeout(() => {
        this.reconnectTimeout = null
        this.connect()
      }, this.backoffMs)
      this.backoffMs = Math.min(this.backoffMs * 2, 10000)
    }
  }

  private cleanupActiveRequests(err: Error) {
    for (const [id, req] of this.activeRequests.entries()) {
      try {
        req.controller?.error(err)
      } catch {}
      req.reject(err)
      this.activeRequests.delete(id)
    }
  }

  private handleFrame(frame: any) {
    if (frame.t === "peer") {
      if (frame.role === "host") {
        this.setHostState(frame.state)
      }
      return
    }

    const req = this.activeRequests.get(frame.id)
    if (!req) return

    if (frame.t === "res-head") {
      req.resolveHeaders({
        status: frame.status,
        headers: frame.headers,
      })
    } else if (frame.t === "res-chunk") {
      if (req.controller) {
        try {
          const bytes = this.base64ToBytes(frame.data)
          req.controller.enqueue(bytes)
        } catch (err) {
          console.error(`[Tunnel] Failed to decode chunk for request ${frame.id}:`, err)
        }
      }
    } else if (frame.t === "res-end") {
      if (req.controller) {
        try {
          req.controller.close()
        } catch {}
      }
      this.activeRequests.delete(frame.id)
    } else if (frame.t === "err") {
      const err = new Error(frame.message)
      if (req.controller) {
        try {
          req.controller.error(err)
        } catch {}
      }
      req.reject(err)
      this.activeRequests.delete(frame.id)
    }
  }

  public async tunnelFetch(path: string, init?: RequestInit): Promise<Response> {
    if (!this.ws || this.connectionState !== "connected") {
      throw new Error("Tunnel is not connected")
    }

    const reqId = Math.random().toString(36).substring(2, 15)
    let bodyBase64: string | null = null

    if (init?.body) {
      if (typeof init.body === "string") {
        bodyBase64 = this.stringToBase64(init.body)
      } else if (init.body instanceof Uint8Array) {
        bodyBase64 = this.bytesToBase64(init.body)
      } else if (init.body instanceof ArrayBuffer) {
        bodyBase64 = this.bytesToBase64(new Uint8Array(init.body))
      } else {
        const text = String(init.body)
        bodyBase64 = this.stringToBase64(text)
      }
    }

    const headers: Record<string, string> = {}
    if (init?.headers) {
      const h = new Headers(init.headers)
      h.forEach((value, key) => {
        headers[key] = value
      })
    }

    const method = init?.method || "GET"

    const reqPromise = new Promise<{ status: number; headers: Record<string, string> }>((resolve, reject) => {
      this.activeRequests.set(reqId, {
        resolveHeaders: resolve,
        reject,
      })
    })

    // Setup abort listener
    if (init?.signal) {
      if (init.signal.aborted) {
        this.sendAbort(reqId)
        this.activeRequests.delete(reqId)
        throw new DOMException("The user aborted a request.", "AbortError")
      }
      init.signal.addEventListener("abort", () => {
        this.sendAbort(reqId)
        const reqState = this.activeRequests.get(reqId)
        if (reqState) {
          reqState.aborted = true
          try {
            reqState.controller?.error(new DOMException("The user aborted a request.", "AbortError"))
          } catch {}
          reqState.reject(new DOMException("The user aborted a request.", "AbortError"))
          this.activeRequests.delete(reqId)
        }
      })
    }

    // Send the request frame
    const reqFrame = {
      t: "req",
      id: reqId,
      method,
      path,
      headers,
      body: bodyBase64,
    }

    this.ws.send(JSON.stringify(reqFrame))

    // Wait for the res-head frame
    const resHead = await reqPromise

    // Null-body statuses (101, 204, 205, 304) must not carry a body: the
    // Response constructor throws "Response with null body status cannot have
    // body" if a stream is provided. The host sends res-end (no chunks) for
    // these, so no stream is needed. Drop the pending request now so the entry
    // doesn't linger waiting for body frames that never come; a late res-end is
    // ignored harmlessly once the id is gone.
    const nullBody =
      resHead.status === 101 || resHead.status === 204 || resHead.status === 205 || resHead.status === 304
    if (nullBody) {
      this.activeRequests.delete(reqId)
      return new Response(null, {
        status: resHead.status,
        headers: new Headers(resHead.headers),
      })
    }

    // Construct readable stream for body chunks
    const self = this
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const state = self.activeRequests.get(reqId)
        if (state) {
          state.controller = controller
        }
      },
      cancel() {
        self.sendAbort(reqId)
        self.activeRequests.delete(reqId)
      },
    })

    return new Response(stream, {
      status: resHead.status,
      headers: new Headers(resHead.headers),
    })
  }

  private sendAbort(id: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: "abort", id }))
    }
  }

  private setConnectionState(state: ConnectionState) {
    if (this.connectionState !== state) {
      this.connectionState = state
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(state)
      }
    }
  }

  private setHostState(state: HostState) {
    if (this.hostState !== state) {
      this.hostState = state
      if (this.onHostStateChange) {
        this.onHostStateChange(state)
      }
    }
  }

  private stringToBase64(str: string): string {
    return btoa(unescape(encodeURIComponent(str)))
  }

  private bytesToBase64(bytes: Uint8Array): string {
    let bin = ""
    for (let i = 0; i < bytes.byteLength; i++) {
      bin += String.fromCharCode(bytes[i])
    }
    return btoa(bin)
  }

  private base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i)
    }
    return bytes
  }
}
