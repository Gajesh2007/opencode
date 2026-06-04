import { serve } from "bun"
import { TunnelTransport } from "./src/tunnel.js"
import { createSession, consumeEventStream, getConfig, promptSession } from "./src/api.js"

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
const opencodePassword = "smoke-test-password-456"

console.log("[Smoke] Free ports found:")
console.log(`[Smoke]   opencode serve: ${opencodePort}`)
console.log(`[Smoke]   relay server:   ${relayPort}`)

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
console.log("[Smoke] Spawning opencode serve subprocess...")
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
console.log("[Smoke] Spawning relay server...")
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
console.log("[Smoke] Spawning host connector...")
const hostProc = Bun.spawn(["bun", "run", "src/host.ts"], {
  env: {
    ...process.env,
    RELAY_URL: `ws://127.0.0.1:${relayPort}`,
    ROOM: "smoke-room",
    TOKEN: "smoke-token",
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

async function runSmokeTests() {
  console.log("[Smoke] Waiting for opencode serve to become ready...")
  await waitUrlReady(`http://127.0.0.1:${opencodePort}/doc`, opencodePassword)
  console.log("[Smoke] opencode serve is ready!")

  // Wait a moment for relay and host to connect
  await new Promise((resolve) => setTimeout(resolve, 1500))

  console.log("[Smoke] Creating and connecting TunnelTransport client...")
  const tunnel = new TunnelTransport(
    `ws://127.0.0.1:${relayPort}`,
    "smoke-room",
    "smoke-token"
  )

  // Use a promise to wait until connected
  const connectPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Tunnel connection timed out")), 5000)
    
    // Wire up events
    tunnel["onConnectionStateChange"] = (state) => {
      if (state === "connected") {
        clearTimeout(timeout)
        resolve()
      }
    }
  })

  tunnel.connect()
  await connectPromise
  console.log("[Smoke] Tunnel connected!")

  // Let's also wait for host presence
  if (tunnel.hostState !== "online") {
    console.log("[Smoke] Waiting for host presence to be online...")
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Host presence timed out")), 5000)
      tunnel["onHostStateChange"] = (state) => {
        if (state === "online") {
          clearTimeout(timeout)
          resolve()
        }
      }
    })
  }
  console.log("[Smoke] Host is online!")

  const tunnelFetch = tunnel.tunnelFetch.bind(tunnel)

  // (a) GET /config returns 200 JSON
  console.log("[Smoke] Assertion (a): Testing GET /config...")
  const config = await getConfig(tunnelFetch)
  console.log("[Smoke] GET /config returned successfully:", JSON.stringify(config, null, 2))

  // (b) creating a session works
  console.log("[Smoke] Assertion (b): Creating a session...")
  const session = await createSession(tunnelFetch, "", "Smoke Test Session")
  console.log("[Smoke] Created session:", JSON.stringify(session, null, 2))

  // (c) the /event SSE stream yields the initial 'server.connected' event
  console.log("[Smoke] Assertion (c): Testing /event SSE stream...")
  const abortCtrl = new AbortController()
  const ssePromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      abortCtrl.abort()
      reject(new Error("Timeout waiting for server.connected event on SSE stream"))
    }, 5000)

    consumeEventStream(
      tunnelFetch,
      "",
      (event) => {
        console.log("[Smoke] Received SSE Event:", JSON.stringify(event, null, 2))
        if (event.type === "server.connected") {
          console.log("[Smoke] SUCCESS: Received server.connected! Aborting stream...")
          clearTimeout(timeout)
          abortCtrl.abort()
          resolve()
        }
      },
      abortCtrl.signal
    ).catch((err) => {
      if (err instanceof DOMException && err.name === "AbortError") {
        // safe ignore
      } else {
        reject(err)
      }
    })
  })

  await ssePromise

  // (d) prompt POST is accepted by the server
  console.log("[Smoke] Assertion (d): Sending a prompt POST (prompt_async)...")
  await promptSession(tunnelFetch, session.id, "", "Hello opencode!")
  console.log("[Smoke] SUCCESS: Prompt accepted!")

  tunnel.disconnect()
}

let exitCode = 0
try {
  await runSmokeTests()
  console.log("\n\x1b[32m=== ALL SMOKE TESTS PASSED SUCCESSFULLY ===\x1b[0m\n")
} catch (err) {
  console.error("\n\x1b[31m=== SMOKE TESTS FAILED ===\x1b[0m\n", err)
  exitCode = 1
} finally {
  console.log("[Smoke] Cleaning up background processes...")
  opencodeProc.kill()
  relayProc.kill()
  hostProc.kill()
  
  // Wait a small moment for processes to be fully killed
  await new Promise((resolve) => setTimeout(resolve, 500))
  
  console.log("[Smoke] Done!")
  process.exit(exitCode)
}
