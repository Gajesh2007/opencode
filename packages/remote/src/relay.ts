import type { Server, ServerWebSocket } from "bun"
import { parseFrame } from "./protocol.js"

type WSData = {
  role: "host" | "client"
  room: string
  token: string
  clientId?: string
}

type RoomState = {
  host: ServerWebSocket<WSData> | null
  clients: Set<ServerWebSocket<WSData>>
  token: string
  clientsMap: Map<string, ServerWebSocket<WSData>>
  activeRequests: Set<string>
}

const rooms = new Map<string, RoomState>()
const port = parseInt(process.env.RELAY_PORT || "8787", 10)
// Bind localhost so a TLS-terminating proxy (Caddy) is the only public entry; set RELAY_HOST=0.0.0.0 only if you intentionally want direct exposure.
const host = process.env.RELAY_HOST || "127.0.0.1"
let clientCounter = 0

const server = Bun.serve<WSData>({
  hostname: host,
  port,
  fetch(req: Request, server: Server<WSData>) {
    const url = new URL(req.url)
    const pathname = url.pathname

    if (pathname !== "/host" && pathname !== "/client") {
      return new Response("Not Found", { status: 404 })
    }

    const room = url.searchParams.get("room")
    const token = url.searchParams.get("token")

    if (!room || !token) {
      return new Response("Missing room or token parameter", { status: 400 })
    }

    const role = pathname === "/host" ? "host" : "client"

    const upgraded = server.upgrade(req, {
      data: {
        role,
        room,
        token,
      },
    })

    if (upgraded) {
      return undefined
    }

    return new Response("WebSocket upgrade failed", { status: 500 })
  },
  websocket: {
    open(ws: ServerWebSocket<WSData>) {
      const { role, room, token } = ws.data
      console.log(`[Relay] Connection opened: role=${role}, room=${room}`)

      if (role === "host") {
        const existing = rooms.get(room)
        if (existing) {
          if (existing.token !== token) {
            console.log(`[Relay] Host connection rejected: token mismatch in room ${room}`)
            ws.close(4003, "Token mismatch")
            return
          }
          console.log(`[Relay] Displacing existing host in room ${room}`)
          existing.host?.close(4002, "Duplicate host connected")
          existing.host = ws
        } else {
          rooms.set(room, {
            host: ws,
            clients: new Set(),
            token,
            clientsMap: new Map(),
            activeRequests: new Set(),
          })
        }
      } else {
        // role === "client"
        const existing = rooms.get(room)
        if (!existing || !existing.host) {
          console.log(`[Relay] Client connection rejected: no host present in room ${room}`)
          ws.close(4001, "No host present")
          return
        }
        if (existing.token !== token) {
          console.log(`[Relay] Client connection rejected: token mismatch in room ${room}`)
          ws.close(4003, "Token mismatch")
          return
        }

        const clientId = `c${++clientCounter}`
        ws.data.clientId = clientId
        existing.clients.add(ws)
        existing.clientsMap.set(clientId, ws)

        // Notify host that client is online
        existing.host.send(
          JSON.stringify({
            t: "peer",
            role: "client",
            state: "online",
          })
        )
        // Notify client that host is online
        ws.send(
          JSON.stringify({
            t: "peer",
            role: "host",
            state: "online",
          })
        )
      }
    },

    message(ws: ServerWebSocket<WSData>, message: string | Buffer) {
      if (typeof message !== "string") {
        return
      }

      const { role, room } = ws.data
      const roomState = rooms.get(room)
      if (!roomState) {
        return
      }

      // Handle ping-pong
      if (message === '{"t":"ping"}') {
        ws.send('{"t":"pong"}')
        return
      }
      if (message === '{"t":"pong"}') {
        return
      }

      if (role === "client") {
        try {
          const frame = parseFrame(message)
          const clientId = ws.data.clientId
          if (!clientId) {
            return
          }
          if ("id" in frame && frame.id) {
            const originalId = frame.id
            const namespacedId = `${clientId}::${originalId}`
            frame.id = namespacedId

            if (frame.t === "req") {
              roomState.activeRequests.add(namespacedId)
              if (roomState.host) {
                roomState.host.send(JSON.stringify(frame))
              } else {
                ws.send(
                  JSON.stringify({
                    t: "err",
                    id: originalId,
                    message: "Host not online",
                  })
                )
              }
            } else if (frame.t === "abort") {
              roomState.activeRequests.delete(namespacedId)
              if (roomState.host) {
                roomState.host.send(JSON.stringify(frame))
              }
            }
          }
        } catch (e) {
          console.error(`[Relay] Error parsing client frame from room ${room}:`, e)
        }
      } else {
        // role === "host"
        try {
          const frame = parseFrame(message)
          if ("id" in frame && frame.id) {
            const namespacedId = frame.id
            const separatorIndex = namespacedId.indexOf("::")
            if (separatorIndex !== -1) {
              const clientId = namespacedId.slice(0, separatorIndex)
              const originalId = namespacedId.slice(separatorIndex + 2)

              // Strip the prefix to restore the original id
              frame.id = originalId

              const targetClient = roomState.clientsMap.get(clientId)
              if (targetClient) {
                targetClient.send(JSON.stringify(frame))
                if (frame.t === "res-end" || frame.t === "err") {
                  roomState.activeRequests.delete(namespacedId)
                }
              } else {
                // Target client disconnected. Drop frame.
                // Tell host to abort to stop work/cleanup
                if (roomState.activeRequests.has(namespacedId)) {
                  roomState.activeRequests.delete(namespacedId)
                  if (roomState.host) {
                    roomState.host.send(
                      JSON.stringify({
                        t: "abort",
                        id: namespacedId,
                      })
                    )
                  }
                }
              }
            } else {
              // Legacy fallback: broadcast to all room clients if no namespace delimiter is found
              for (const client of roomState.clients) {
                client.send(message)
              }
            }
          } else {
            // Non-request frames (e.g. peer presence) - broadcast
            for (const client of roomState.clients) {
              client.send(message)
            }
          }
        } catch (e) {
          console.error(`[Relay] Error parsing host frame from room ${room}:`, e)
        }
      }
    },

    close(ws: ServerWebSocket<WSData>, code: number, reason: string) {
      const { role, room } = ws.data
      console.log(`[Relay] Connection closed: role=${role}, room=${room}, code=${code}, reason=${reason}`)

      const roomState = rooms.get(room)
      if (!roomState) {
        return
      }

      if (role === "host") {
        if (roomState.host === ws) {
          roomState.host = null
          // Notify clients that host is offline
          for (const client of roomState.clients) {
            client.send(
              JSON.stringify({
                t: "peer",
                role: "host",
                state: "offline",
              })
            )
            client.close(4001, "Host disconnected")
          }
          rooms.delete(room)
        }
      } else {
        // role === "client"
        const clientId = ws.data.clientId
        if (clientId) {
          roomState.clientsMap.delete(clientId)
        }
        roomState.clients.delete(ws)
        if (roomState.host) {
          roomState.host.send(
            JSON.stringify({
              t: "peer",
              role: "client",
              state: "offline",
            })
          )

          // Clean up pending requests for this client and tell host to abort
          if (clientId) {
            const toAbort: string[] = []
            for (const namespacedId of roomState.activeRequests) {
              if (namespacedId.startsWith(`${clientId}::`)) {
                toAbort.push(namespacedId)
              }
            }
            for (const namespacedId of toAbort) {
              roomState.activeRequests.delete(namespacedId)
              roomState.host.send(
                JSON.stringify({
                  t: "abort",
                  id: namespacedId,
                })
              )
            }
          }
        }
        // Delete room if both host and clients are gone
        if (!roomState.host && roomState.clients.size === 0) {
          rooms.delete(room)
        }
      }
    },
  },
})

console.log(`[Relay] Server running on ws://localhost:${port}`)
export default server
