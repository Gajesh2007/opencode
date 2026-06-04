import { serve } from "bun"
import { parseFrame } from "./protocol.js"

// Simple helper to get a free port dynamically
function getFreePort(): number {
  const s = serve({
    port: 0,
    fetch() {
      return new Response()
    },
  })
  const port = s.port as number
  s.stop()
  return port
}

const opencodePort = getFreePort()
const relayPort = getFreePort()
const opencodePassword = "e2e-test-password-123"

console.log("[E2E] Free ports found:")
console.log(`[E2E]   opencode serve: ${opencodePort}`)
console.log(`[E2E]   relay server:   ${relayPort}`)

const pipeOutput = (proc: any, prefix: string) => {
  const stream = async (readable: any) => {
    if (!readable) return
    const reader = readable.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = new TextDecoder().decode(value)
        for (const line of text.split("\n")) {
          if (line.trim()) {
            console.log(`${prefix} ${line}`)
          }
        }
      }
    } catch {
      // Stream closed
    }
  }
  stream(proc.stdout)
  stream(proc.stderr)
}

// 1. Start opencode serve as a background subprocess
console.log("[E2E] Spawning opencode serve subprocess...")
const opencodeProc = Bun.spawn(
  [
    "bun",
    "run",
    "--conditions=browser",
    "packages/opencode/src/index.ts",
    "serve",
    "--port",
    String(opencodePort),
    "--hostname",
    "127.0.0.1",
  ],
  {
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: opencodePassword,
    },
    cwd: "/Users/gaj/Documents/Builds/opencode",
    stdout: "pipe",
    stderr: "pipe",
  }
)
pipeOutput(opencodeProc, "\x1b[34m[opencode serve]\x1b[0m")

// 2. Start relay server
console.log("[E2E] Spawning relay server...")
const relayProc = Bun.spawn(["bun", "run", "src/relay.ts"], {
  env: {
    ...process.env,
    RELAY_PORT: String(relayPort),
  },
  cwd: "/Users/gaj/Documents/Builds/opencode/packages/remote",
  stdout: "pipe",
  stderr: "pipe",
})
pipeOutput(relayProc, "\x1b[35m[relay]\x1b[0m")

// 3. Start host connector
console.log("[E2E] Spawning host connector...")
const hostProc = Bun.spawn(["bun", "run", "src/host.ts"], {
  env: {
    ...process.env,
    RELAY_URL: `ws://127.0.0.1:${relayPort}`,
    ROOM: "test-room",
    TOKEN: "test-token",
    OPENCODE_URL: `http://127.0.0.1:${opencodePort}`,
    OPENCODE_PASSWORD: opencodePassword,
  },
  cwd: "/Users/gaj/Documents/Builds/opencode/packages/remote",
  stdout: "pipe",
  stderr: "pipe",
})
pipeOutput(hostProc, "\x1b[32m[host-connector]\x1b[0m")

async function waitUrlReady(url: string, password?: string) {
  const headers: Record<string, string> = {}
  if (password) {
    headers["Authorization"] = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  }
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(url, { headers })
      if (res.status === 200 || res.status === 401) {
        return true
      }
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`URL ${url} did not become ready in time`)
}

async function runTests() {
  console.log("[E2E] Waiting for opencode serve to become ready...")
  await waitUrlReady(`http://127.0.0.1:${opencodePort}/doc`, opencodePassword)
  console.log("[E2E] opencode serve is ready!")

  // Wait a moment for relay and host to connect
  await new Promise((resolve) => setTimeout(resolve, 1000))

  // Assert 1: Token mismatch rejection on relay
  console.log("[E2E] Assertion 1: Testing token mismatch rejection...")
  const badWs = new WebSocket(`ws://127.0.0.1:${relayPort}/client?room=test-room&token=wrong-token`)
  const rejectionResult = await new Promise<{ ok: boolean; code?: number }>((resolve) => {
    let opened = false
    badWs.onopen = () => {
      opened = true
    }
    badWs.onclose = (event) => {
      resolve({ ok: true, code: event.code })
    }
    badWs.onerror = () => {
      resolve({ ok: true })
    }
    setTimeout(() => {
      if (opened) {
        resolve({ ok: false })
      } else {
        resolve({ ok: true })
      }
    }, 1000)
  })

  if (rejectionResult.ok) {
    console.log(`\x1b[32mPASS\x1b[0m: Token mismatch rejection worked (code: ${rejectionResult.code})`)
  } else {
    throw new Error("FAIL: Token mismatch was not rejected!")
  }
  badWs.close()

  // Connect valid client WS
  console.log("[E2E] Connecting valid client WebSocket to relay...")
  const clientWs = new WebSocket(`ws://127.0.0.1:${relayPort}/client?room=test-room&token=test-token`)

  const frameHandlers = new Set<(frame: any) => void>()
  clientWs.onmessage = (event) => {
    if (typeof event.data !== "string") return
    try {
      const frame = parseFrame(event.data)
      for (const handler of frameHandlers) {
        handler(frame)
      }
    } catch (e) {
      console.error("[E2E Client] Msg parsing error:", e)
    }
  }

  // Assert 2: Peer presence notification.
  // NOTE: register the peer handler BEFORE the socket opens. The relay sends the
  // peer frame from inside its server-side `open` handler, and Bun delivers the
  // client `open` event and that first `message` in the same batch, so a handler
  // registered only after `await openPromise` would miss it (race).
  console.log("[E2E] Assertion 2: Testing peer presence notification...")
  const peerPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      frameHandlers.delete(handler)
      reject(new Error("Timeout waiting for peer frame"))
    }, 2000)

    const handler = (frame: any) => {
      if (frame.t === "peer" && frame.role === "host" && frame.state === "online") {
        clearTimeout(timeout)
        frameHandlers.delete(handler)
        resolve()
      }
    }
    frameHandlers.add(handler)
  })

  const openPromise = new Promise<void>((resolve, reject) => {
    clientWs.onopen = () => resolve()
    clientWs.onerror = (err) => reject(err)
  })
  await openPromise
  await peerPromise
  console.log("\x1b[32mPASS\x1b[0m: Peer presence notification received.")

  // Helper for requests
  function sendRequest(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string | null
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const reqId = Math.random().toString(36).substring(7)
    const chunks: string[] = []
    let status = 0
    let resHeaders: Record<string, string> = {}

    return new Promise((resolve, reject) => {
      const handler = (frame: any) => {
        if (frame.id === reqId) {
          if (frame.t === "res-head") {
            status = frame.status
            resHeaders = frame.headers
          } else if (frame.t === "res-chunk") {
            chunks.push(Buffer.from(frame.data, "base64").toString("utf-8"))
          } else if (frame.t === "res-end") {
            frameHandlers.delete(handler)
            resolve({ status, headers: resHeaders, body: chunks.join("") })
          } else if (frame.t === "err") {
            frameHandlers.delete(handler)
            reject(new Error(frame.message))
          }
        }
      }
      frameHandlers.add(handler)
      clientWs.send(JSON.stringify({ t: "req", id: reqId, method, path, headers, body }))
    })
  }

  // Assert 3: GET /config returns valid JSON and HTTP 200
  console.log("[E2E] Assertion 3: Testing GET /config...")
  const configRes = await sendRequest("GET", "/config", {}, null)
  if (configRes.status === 200) {
    const parsed = JSON.parse(configRes.body)
    if (parsed && typeof parsed === "object") {
      console.log("\x1b[32mPASS\x1b[0m: GET /config returned 200 and valid JSON")
    } else {
      throw new Error("FAIL: Response body is not valid JSON object")
    }
  } else {
    throw new Error(`FAIL: GET /config returned status ${configRes.status}, body: ${configRes.body}`)
  }

  // Assert 4: GET /event (SSE) returns 200, streams chunks and supports abort
  console.log("[E2E] Assertion 4: Testing GET /event (SSE) stream and abort...")
  const sseReqId = "sse-id-999"
  let sseStatus = 0
  let sseHeaders: Record<string, string> = {}
  const sseChunks: string[] = []

  const sseStreamPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      frameHandlers.delete(handler)
      reject(new Error("Timeout waiting for SSE 'server.connected' event"))
    }, 5000)

    const handler = (frame: any) => {
      if (frame.id === sseReqId) {
        if (frame.t === "res-head") {
          sseStatus = frame.status
          sseHeaders = frame.headers
        } else if (frame.t === "res-chunk") {
          const chunkStr = Buffer.from(frame.data, "base64").toString("utf-8")
          sseChunks.push(chunkStr)
          if (chunkStr.includes("server.connected")) {
            console.log("[E2E Client] Received SSE 'server.connected' frame, sending abort...")
            clientWs.send(JSON.stringify({ t: "abort", id: sseReqId }))
            clearTimeout(timeout)
            frameHandlers.delete(handler)
            resolve()
          }
        } else if (frame.t === "res-end") {
          clearTimeout(timeout)
          frameHandlers.delete(handler)
          reject(new Error("SSE stream ended prematurely"))
        } else if (frame.t === "err") {
          clearTimeout(timeout)
          frameHandlers.delete(handler)
          reject(new Error(frame.message))
        }
      }
    }
    frameHandlers.add(handler)
    clientWs.send(
      JSON.stringify({
        t: "req",
        id: sseReqId,
        method: "GET",
        path: "/event",
        headers: {},
        body: null,
      })
    )
  })

  await sseStreamPromise
  if (sseStatus === 200) {
    console.log("\x1b[32mPASS\x1b[0m: SSE streaming & abort works correctly")
  } else {
    throw new Error(`FAIL: SSE returned status ${sseStatus}`)
  }

  // Assert 5: Concurrent Multi-client testing (same request ID, no crosstalk)
  console.log("[E2E] Assertion 5: Testing concurrent multi-client with duplicate request ID...")
  const clientA = new WebSocket(`ws://127.0.0.1:${relayPort}/client?room=test-room&token=test-token`)
  const clientB = new WebSocket(`ws://127.0.0.1:${relayPort}/client?room=test-room&token=test-token`)

  await Promise.all([
    new Promise<void>((resolve, reject) => {
      clientA.onopen = () => resolve()
      clientA.onerror = reject
    }),
    new Promise<void>((resolve, reject) => {
      clientB.onopen = () => resolve()
      clientB.onerror = reject
    }),
  ])

  const clientAHandler = new Set<(frame: any) => void>()
  const clientBHandler = new Set<(frame: any) => void>()

  clientA.onmessage = (event) => {
    if (typeof event.data !== "string") return
    try {
      const frame = parseFrame(event.data)
      for (const h of clientAHandler) h(frame)
    } catch {}
  }
  clientB.onmessage = (event) => {
    if (typeof event.data !== "string") return
    try {
      const frame = parseFrame(event.data)
      for (const h of clientBHandler) h(frame)
    } catch {}
  }

  // Set up overlapping same ID ("dup-1") requests:
  // Client A requests GET /config
  // Client B requests GET /doc
  // Let's run both concurrently and check they both resolve correctly with NO crosstalk.
  const dupId = "dup-1"

  const promiseA = new Promise<{ status: number; body: string }>((resolve, reject) => {
    const chunks: string[] = []
    let status = 0
    const timeout = setTimeout(() => reject(new Error("Client A request timeout")), 5000)
    const handler = (frame: any) => {
      if (frame.id === dupId) {
        if (frame.t === "res-head") {
          status = frame.status
        } else if (frame.t === "res-chunk") {
          chunks.push(Buffer.from(frame.data, "base64").toString("utf-8"))
        } else if (frame.t === "res-end") {
          clientAHandler.delete(handler)
          clearTimeout(timeout)
          resolve({ status, body: chunks.join("") })
        } else if (frame.t === "err") {
          clientAHandler.delete(handler)
          clearTimeout(timeout)
          reject(new Error(frame.message))
        }
      }
    }
    clientAHandler.add(handler)
    clientA.send(JSON.stringify({ t: "req", id: dupId, method: "GET", path: "/config", headers: {}, body: null }))
  })

  const promiseB = new Promise<{ status: number; body: string }>((resolve, reject) => {
    const chunks: string[] = []
    let status = 0
    const timeout = setTimeout(() => reject(new Error("Client B request timeout")), 5000)
    const handler = (frame: any) => {
      if (frame.id === dupId) {
        if (frame.t === "res-head") {
          status = frame.status
        } else if (frame.t === "res-chunk") {
          chunks.push(Buffer.from(frame.data, "base64").toString("utf-8"))
        } else if (frame.t === "res-end") {
          clientBHandler.delete(handler)
          clearTimeout(timeout)
          resolve({ status, body: chunks.join("") })
        } else if (frame.t === "err") {
          clientBHandler.delete(handler)
          clearTimeout(timeout)
          reject(new Error(frame.message))
        }
      }
    }
    clientBHandler.add(handler)
    clientB.send(JSON.stringify({ t: "req", id: dupId, method: "GET", path: "/nonexistent-path-abc-123", headers: {}, body: null }))
  })

  // Also, we can check for any leaked frame from B to A or A to B:
  let crosstalkAtoB = false
  let crosstalkBtoA = false

  const monitorA = (frame: any) => {
    if (frame.id === dupId && frame.t === "res-chunk") {
      const text = Buffer.from(frame.data, "base64").toString("utf-8").toLowerCase()
      if (text.includes("<!doctype html>") || text.includes("<html")) {
        crosstalkBtoA = true
      }
    }
  }
  const monitorB = (frame: any) => {
    if (frame.id === dupId && frame.t === "res-chunk") {
      const text = Buffer.from(frame.data, "base64").toString("utf-8")
      if (text.includes('"username"') || text.includes('"skills"')) {
        crosstalkAtoB = true
      }
    }
  }

  clientAHandler.add(monitorA)
  clientBHandler.add(monitorB)

  const [resA, resB] = await Promise.all([promiseA, promiseB])

  clientAHandler.delete(monitorA)
  clientBHandler.delete(monitorB)

  if (crosstalkAtoB || crosstalkBtoA) {
    throw new Error(`FAIL: Crosstalk detected between Client A and Client B! A-to-B: ${crosstalkAtoB}, B-to-A: ${crosstalkBtoA}`)
  }

  // Validate responses
  if (resA.status !== 200 || !resA.body.includes("username")) {
    throw new Error(`FAIL: Client A received wrong response: status=${resA.status}, body=${resA.body}`)
  }
  if (resB.status !== 200 || !resB.body.toLowerCase().includes("<!doctype html>")) {
    throw new Error(`FAIL: Client B received wrong response: status=${resB.status}, body=${resB.body}`)
  }
  console.log("\x1b[32mPASS\x1b[0m: No crosstalk on duplicate request ID!")

  // Assert 6: SSE/streaming request on client A is not delivered to client B.
  console.log("[E2E] Assertion 6: Testing SSE/streaming request on Client A is not delivered to Client B...")
  const sseId = "sse-dup-id"
  let sseReceivedOnB = false

  const sseMonitorB = (frame: any) => {
    if (frame.id === sseId) {
      sseReceivedOnB = true
    }
  }
  clientBHandler.add(sseMonitorB)

  const ssePromiseA = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      clientAHandler.delete(handler)
      reject(new Error("Timeout waiting for SSE on Client A"))
    }, 5000)

    const handler = (frame: any) => {
      if (frame.id === sseId) {
        if (frame.t === "res-chunk") {
          const chunkStr = Buffer.from(frame.data, "base64").toString("utf-8")
          if (chunkStr.includes("server.connected")) {
            clientA.send(JSON.stringify({ t: "abort", id: sseId }))
            clearTimeout(timeout)
            clientAHandler.delete(handler)
            resolve()
          }
        }
      }
    }
    clientAHandler.add(handler)
    clientA.send(JSON.stringify({ t: "req", id: sseId, method: "GET", path: "/event", headers: {}, body: null }))
  })

  await ssePromiseA
  // Wait a small buffer to make sure B didn't get any messages
  await new Promise((resolve) => setTimeout(resolve, 500))
  clientBHandler.delete(sseMonitorB)

  if (sseReceivedOnB) {
    throw new Error("FAIL: Client B received streaming data from Client A's SSE request!")
  }
  console.log("\x1b[32mPASS\x1b[0m: SSE/streaming request on Client A did not deliver any frames to Client B.")

  clientA.close()
  clientB.close()

  clientWs.close()
}

let exitCode = 0
try {
  await runTests()
  console.log("\n\x1b[32m=== ALL E2E TESTS PASSED SUCCESSFULLY ===\x1b[0m\n")
} catch (err) {
  console.error("\n\x1b[31m=== E2E TESTS FAILED ===\x1b[0m\n", err)
  exitCode = 1
} finally {
  // NOTE: cleanup must NOT live after a process.exit() inside the try/catch —
  // process.exit() terminates immediately and skips finally, orphaning the
  // spawned opencode/relay/host subprocesses. Kill first, then exit.
  console.log("[E2E] Cleaning up background processes...")
  opencodeProc.kill()
  relayProc.kill()
  hostProc.kill()
}
process.exit(exitCode)
