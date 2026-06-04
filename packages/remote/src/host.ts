import { parseFrame } from "./protocol.js"
import { startCaffeination, stopCaffeination } from "./caffeinate.js"

const envOrArg = (envName: string, argName: string, defaultValue: string = ""): string => {
  const argIndex = process.argv.indexOf(argName)
  if (argIndex !== -1 && argIndex + 1 < process.argv.length) {
    return process.argv[argIndex + 1]
  }
  return process.env[envName] || defaultValue
}

const relayUrl = envOrArg("RELAY_URL", "--relay-url", "ws://localhost:8787")
const room = envOrArg("ROOM", "--room", "test-room")
const token = envOrArg("TOKEN", "--token", "test-token")
const opencodeUrl = envOrArg("OPENCODE_URL", "--opencode-url", "http://127.0.0.1:4096")
const opencodePassword = envOrArg("OPENCODE_PASSWORD", "--opencode-password", "")

const activeRequests = new Map<string, { abortController: AbortController }>()
let ws: WebSocket | null = null
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null
let backoffMs = 1000
const maxBackoffMs = 10000

function connect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout)
    reconnectTimeout = null
  }

  let wsUrl = relayUrl.replace(/^http/, "ws")
  if (!wsUrl.includes("://")) {
    wsUrl = "ws://" + wsUrl
  }

  const connectionUrl = `${wsUrl}/host?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`
  console.log(`[Host] Connecting to relay at ${wsUrl} (room: ${room})...`)

  const socket = new WebSocket(connectionUrl)
  ws = socket

  socket.onopen = () => {
    console.log(`[Host] Successfully connected and registered host in room ${room}`)
    backoffMs = 1000 // Reset backoff on successful connection
  }

  socket.onmessage = async (event) => {
    if (typeof event.data !== "string") {
      return
    }

    // Handle ping-pong
    if (event.data === '{"t":"ping"}') {
      socket.send('{"t":"pong"}')
      return
    }
    if (event.data === '{"t":"pong"}') {
      return
    }

    try {
      const frame = parseFrame(event.data)
      if (frame.t === "req") {
        handleRequest(frame, socket)
      } else if (frame.t === "abort") {
        handleAbort(frame)
      }
    } catch (e) {
      console.error(`[Host] Error parsing incoming frame:`, e)
    }
  }

  socket.onclose = (event) => {
    console.log(`[Host] Connection closed: code=${event.code}, reason=${event.reason}`)
    ws = null
    cleanupActiveRequests()
    scheduleReconnect()
  }

  socket.onerror = (err) => {
    console.error(`[Host] WebSocket error:`, err)
    // socket.onclose will be called automatically
  }
}

function scheduleReconnect() {
  if (reconnectTimeout) return
  console.log(`[Host] Attempting reconnect in ${backoffMs}ms...`)
  reconnectTimeout = setTimeout(() => {
    connect()
  }, backoffMs)
  backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
}

function cleanupActiveRequests() {
  for (const [id, req] of activeRequests.entries()) {
    req.abortController.abort()
    activeRequests.delete(id)
  }
}

async function handleRequest(frame: Extract<ReturnType<typeof parseFrame>, { t: "req" }>, socket: WebSocket) {
  console.log(`[Host] Received request: id=${frame.id}, method=${frame.method}, path=${frame.path}`)

  const abortController = new AbortController()
  activeRequests.set(frame.id, { abortController })

  // Copy and prepare headers
  const headers: Record<string, string> = { ...frame.headers }
  delete headers["host"] // Allow fetch to populate the host header correctly

  // Construct target local URL
  const parsedTarget = new URL(frame.path, opencodeUrl)
  if (!parsedTarget.searchParams.get("directory") && !headers["x-opencode-directory"]) {
    const defaultDir = process.env.OPENCODE_DIRECTORY || process.cwd()
    parsedTarget.searchParams.set("directory", defaultDir)
  }
  const targetUrl = parsedTarget.toString()

  if (opencodePassword) {
    const auth = Buffer.from(`opencode:${opencodePassword}`).toString("base64")
    headers["Authorization"] = `Basic ${auth}`
  }

  const bodyBytes = frame.body ? Buffer.from(frame.body, "base64") : undefined

  try {
    const response = await fetch(targetUrl, {
      method: frame.method,
      headers,
      body: bodyBytes,
      signal: abortController.signal,
    })

    // Prepare response headers to send back.
    // Bun's fetch transparently decompresses the body, so the upstream
    // content-encoding / content-length no longer describe the bytes we stream
    // back. The body is re-framed via res-chunk/res-end, so drop these (and
    // hop-by-hop transfer-encoding) to avoid a browser client trying to gunzip
    // already-plain bytes or truncating to a stale length.
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (lower === "content-encoding" || lower === "content-length" || lower === "transfer-encoding") return
      responseHeaders[key] = value
    })

    // Send res-head
    socket.send(
      JSON.stringify({
        t: "res-head",
        id: frame.id,
        status: response.status,
        headers: responseHeaders,
      })
    )

    const bodyStream = response.body
    if (!bodyStream) {
      socket.send(JSON.stringify({ t: "res-end", id: frame.id }))
      activeRequests.delete(frame.id)
      return
    }

    const reader = bodyStream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        if (value) {
          const b64 = Buffer.from(value).toString("base64")
          socket.send(
            JSON.stringify({
              t: "res-chunk",
              id: frame.id,
              data: b64,
            })
          )
        }
      }
      socket.send(JSON.stringify({ t: "res-end", id: frame.id }))
    } finally {
      reader.releaseLock()
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.log(`[Host] Request ${frame.id} fetch/stream aborted`)
    } else {
      console.error(`[Host] Fetch failed for request ${frame.id}:`, error)
      try {
        socket.send(
          JSON.stringify({
            t: "err",
            id: frame.id,
            message: error instanceof Error ? error.message : String(error),
          })
        )
      } catch {
        // Socket might be closed/dead
      }
    }
  } finally {
    activeRequests.delete(frame.id)
  }
}

function handleAbort(frame: Extract<ReturnType<typeof parseFrame>, { t: "abort" }>) {
  console.log(`[Host] Received abort signal for request id=${frame.id}`)
  const req = activeRequests.get(frame.id)
  if (req) {
    req.abortController.abort()
    activeRequests.delete(frame.id)
  }
}

let isShuttingDown = false
function shutdown() {
  if (isShuttingDown) return
  isShuttingDown = true
  stopCaffeination()
  cleanupActiveRequests()
  if (ws) {
    try {
      ws.close()
    } catch {
      // Ignore
    }
  }
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
process.on("exit", stopCaffeination)

// Start connection
startCaffeination()
connect()
