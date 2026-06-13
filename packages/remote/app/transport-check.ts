// End-to-end proof that the embedded opencode UI's transport works over the relay
// tunnel. It boots opencode serve + relay + host on ephemeral ports (mirrors
// packages/remote/web/integration-check.ts) and then drives the EXACT adapter the
// app installs as `platform.fetch` — `tunnelFetch` from src/tunnel-state.ts — using
// `Request` objects against the dummy `http://tunnel` base URL, which is precisely
// how the opencode SDK calls platform.fetch. It exercises:
//   /config/providers (models + variants), /agent, POST /session,
//   POST /session/:id/prompt_async, and the /event SSE stream.
// Every spawned process is killed on exit.

import { serve } from "bun"
import { TunnelTransport } from "./src/tunnel"
import { setActiveTunnel, tunnelFetch } from "./src/tunnel-state"

const REPO = "/Users/gaj/Documents/Builds/opencode"
const PASSWORD = "transport-check-pw"
const BASE = "http://tunnel"
const hasGateway = Boolean(process.env.AI_GATEWAY_API_KEY)

const log = (...a: unknown[]) => console.log("[transport]", ...a)

function freePort(): number {
  const s = serve({ port: 0, fetch: () => new Response() })
  const port = s.port as number
  s.stop()
  return port
}

const opencodePort = freePort()
const relayPort = freePort()

const procs: ReturnType<typeof Bun.spawn>[] = []
function spawn(cmd: string[], cwd: string, env: Record<string, string>) {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  procs.push(proc)
  return proc
}

let tunnel: TunnelTransport | null = null
function cleanup() {
  try {
    tunnel?.disconnect()
  } catch {}
  setActiveTunnel(null)
  for (const proc of procs) {
    try {
      proc.kill("SIGKILL")
    } catch {}
  }
}

async function waitReady(url: string) {
  const headers = { Authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}` }
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(url, { headers })
      if (res.status === 200 || res.status === 401) return
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`server not ready: ${url}`)
}

// Build a Request exactly like the opencode SDK does, then push it through the
// app's platform.fetch adapter.
function request(path: string, init?: RequestInit) {
  const url = new URL(path, BASE)
  if (!url.searchParams.has("directory")) url.searchParams.set("directory", REPO)
  return tunnelFetch(new Request(url, init))
}

async function getJson<T>(path: string): Promise<T> {
  const res = await request(path)
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`)
  return (await res.json()) as T
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${await res.text().catch(() => "")}`)
  return (await res.json()) as T
}

async function main() {
  log(`ports: opencode=${opencodePort} relay=${relayPort} gateway=${hasGateway ? "yes" : "no"}`)

  spawn(
    ["bun", "run", "--conditions=browser", "packages/opencode/src/index.ts", "serve", "--port", String(opencodePort), "--hostname", "127.0.0.1"],
    REPO,
    { OPENCODE_SERVER_PASSWORD: PASSWORD },
  )
  spawn(["bun", "run", "src/relay.ts"], `${REPO}/packages/remote`, { RELAY_PORT: String(relayPort) })

  log("waiting for opencode serve…")
  await waitReady(`http://127.0.0.1:${opencodePort}/doc`)
  log("opencode serve ready")

  spawn(["bun", "run", "src/host.ts"], `${REPO}/packages/remote`, {
    RELAY_URL: `ws://127.0.0.1:${relayPort}`,
    ROOM: "transport-room",
    TOKEN: "transport-token",
    OPENCODE_URL: `http://127.0.0.1:${opencodePort}`,
    OPENCODE_PASSWORD: PASSWORD,
    OPENCODE_DIRECTORY: REPO,
  })

  // The relay opens the client socket then closes it (4001) if the host has not
  // registered yet — a pure startup race. So wait until the tunnel is BOTH
  // connected AND reports the host online (its own auto-reconnect rides out the
  // race); only then is the connection stable.
  tunnel = new TunnelTransport(`ws://127.0.0.1:${relayPort}`, "transport-room", "transport-token")
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("host-online timeout")), 25000)
    const check = () => {
      if (tunnel!.connectionState === "connected" && tunnel!.hostState === "online") {
        clearTimeout(t)
        resolve()
      }
    }
    tunnel!["onConnectionStateChange"] = check
    tunnel!["onHostStateChange"] = check
    tunnel!.connect()
  })
  log("tunnel connected + host online")
  setActiveTunnel(tunnel)

  // (1) /config/providers — model list incl. variants
  const providers = await getJson<{ providers: Array<{ id: string; models: Record<string, { id: string; variants?: Record<string, unknown> }> }> }>(
    "/config/providers",
  )
  const allModels = providers.providers.flatMap((p) => Object.values(p.models).map((m) => ({ provider: p.id, ...m })))
  const withVariants = allModels.filter((m) => m.variants && Object.keys(m.variants).length > 0)
  log(`(1) /config/providers: ${providers.providers.length} provider(s), ${allModels.length} model(s)`)
  if (allModels.length === 0) throw new Error("no models returned through tunnel")
  const sample = withVariants[0]
  if (sample) {
    log(`    variants present, e.g. ${sample.provider}/${sample.id}: [${Object.keys(sample.variants!).join(", ")}]`)
  } else {
    log("    (no model exposed variants in this config — variant picker would simply be empty)")
  }

  // (2) /agent — agent list (powers the @agent picker)
  const agents = await getJson<Array<{ name: string }>>("/agent")
  log(`(2) /agent: ${agents.length} agent(s): ${agents.map((a) => a.name).slice(0, 8).join(", ")}`)
  if (agents.length === 0) throw new Error("no agents returned through tunnel")

  // (3) Subscribe to /event SSE BEFORE mutating, so we can observe live events.
  const sseAbort = new AbortController()
  const seen: string[] = []
  const sseDone = (async () => {
    const res = await request("/event", { signal: sseAbort.signal })
    if (!res.body) throw new Error("/event returned no body")
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (!sseAbort.signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const raw of lines) {
          const line = raw.replace(/\r$/, "")
          if (!line.startsWith("data:")) continue
          try {
            const evt = JSON.parse(line.slice(5).trim()) as { type?: string }
            if (evt.type) seen.push(evt.type)
          } catch {}
        }
      }
    } catch (err) {
      if (!sseAbort.signal.aborted) throw err
    } finally {
      reader.releaseLock()
    }
  })()
  // give the stream a moment to establish
  await new Promise((r) => setTimeout(r, 500))
  log("(3) /event SSE stream open")

  // (4) POST /session — create a session (emits events)
  const session = await postJson<{ id: string; directory: string }>("/session", {})
  log(`(4) POST /session: created ${session.id} (dir=${session.directory})`)
  if (!session.id) throw new Error("session create returned no id")

  // (5) POST /session/:id/prompt_async — send a message
  try {
    await request(`/session/${encodeURIComponent(session.id)}/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "hello over the tunnel" }] }),
    }).then(async (res) => {
      log(`(5) POST /session/:id/prompt_async -> ${res.status}${hasGateway ? "" : " (no gateway: model may error, but the send path + events still exercise SSE)"}`)
    })
  } catch (err) {
    log(`(5) prompt_async send errored (expected without a configured model): ${(err as Error).message}`)
  }

  // Wait until SSE has yielded events from the activity above (or time out).
  const deadline = Date.now() + 12000
  while (seen.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
  }
  sseAbort.abort()
  await sseDone.catch(() => {})

  const unique = [...new Set(seen)]
  log(`(6) /event SSE yielded ${seen.length} event(s); types: ${unique.slice(0, 12).join(", ") || "<none>"}`)
  if (seen.length === 0) throw new Error("no SSE events received through tunnel")

  log("ALL TRANSPORT CHECKS PASSED — providers/agents/session/prompt/SSE all flowed through tunnelFetch")
}

let code = 0
const overall = setTimeout(() => {
  console.error("[transport] OVERALL TIMEOUT")
  cleanup()
  process.exit(1)
}, 180000)

try {
  await main()
  console.log("\n=== TRANSPORT CHECK PASSED ===\n")
} catch (e) {
  console.error("\n=== TRANSPORT CHECK FAILED ===\n", e)
  code = 1
} finally {
  clearTimeout(overall)
  cleanup()
  await new Promise((r) => setTimeout(r, 400))
  process.exit(code)
}
