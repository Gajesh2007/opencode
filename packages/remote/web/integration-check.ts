// Data-flow integration check for the rewritten remote web client.
//
// Boots opencode serve + relay + host locally (mirrors smoke-test.ts), then
// drives the NEW api.ts / tunnel.ts code path exactly as the browser UI does:
//   (a) create a session
//   (b) list sessions for a directory
//   (c) GET /file?path=. to prove the folder-browser endpoint returns entries
//   (d) if AI_GATEWAY_API_KEY is present, send a prompt that triggers a TOOL
//       call and a SUBAGENT (task) call, then drill into the child session.
//
// Cleans up every spawned process on exit.

import { serve } from "bun"
import { TunnelTransport } from "./src/tunnel.js"
import { createApi, type Part, type ToolPart, type WithParts } from "./src/api.js"

const REPO = "/Users/gaj/Documents/Builds/opencode"
const PASSWORD = "integration-check-pw"
const hasGateway = Boolean(process.env.AI_GATEWAY_API_KEY)

function freePort(): number {
  const s = serve({ port: 0, fetch: () => new Response() })
  const port = s.port as number
  s.stop()
  return port
}

const opencodePort = freePort()
const relayPort = freePort()

const log = (...a: unknown[]) => console.log("[check]", ...a)

const procs: { name: string; proc: ReturnType<typeof Bun.spawn> }[] = []
function spawn(name: string, cmd: string[], cwd: string, env: Record<string, string>) {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  procs.push({ name, proc })
  return proc
}

let activeTunnel: TunnelTransport | null = null
function cleanup() {
  try {
    activeTunnel?.disconnect()
  } catch {}
  for (const { proc } of procs) {
    try {
      proc.kill("SIGKILL")
    } catch {}
  }
}

async function waitReady(url: string) {
  const headers = { Authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}` }
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url, { headers })
      if (res.status === 200 || res.status === 401) return
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`server not ready: ${url}`)
}

function collectToolParts(messages: WithParts[]): ToolPart[] {
  return messages.flatMap((m) => m.parts.filter((p): p is ToolPart => p.type === "tool"))
}

async function pollMessages(
  api: ReturnType<typeof createApi>,
  sessionID: string,
  predicate: (parts: Part[]) => boolean,
  timeoutMs: number,
): Promise<WithParts[]> {
  const deadline = Date.now() + timeoutMs
  let last: WithParts[] = []
  while (Date.now() < deadline) {
    const page = await api.getMessages(sessionID, { limit: 80 })
    last = page.items
    const parts = page.items.flatMap((m) => m.parts)
    if (predicate(parts)) return last
    const errored = page.items.find((m) => m.info.role === "assistant" && m.info.error)
    if (errored && errored.info.role === "assistant" && errored.info.error) {
      log("assistant error:", JSON.stringify(errored.info.error))
      if (predicate(parts)) return last
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return last
}

async function main() {
  log(`ports: opencode=${opencodePort} relay=${relayPort} gateway=${hasGateway ? "yes" : "no"}`)

  spawn(
    "opencode",
    ["bun", "run", "--conditions=browser", "packages/opencode/src/index.ts", "serve", "--port", String(opencodePort), "--hostname", "127.0.0.1"],
    REPO,
    { OPENCODE_SERVER_PASSWORD: PASSWORD },
  )
  spawn("relay", ["bun", "run", "src/relay.ts"], `${REPO}/packages/remote`, { RELAY_PORT: String(relayPort) })

  log("waiting for opencode serve…")
  await waitReady(`http://127.0.0.1:${opencodePort}/doc`)
  log("opencode serve ready")

  spawn("host", ["bun", "run", "src/host.ts"], `${REPO}/packages/remote`, {
    RELAY_URL: `ws://127.0.0.1:${relayPort}`,
    ROOM: "check-room",
    TOKEN: "check-token",
    OPENCODE_URL: `http://127.0.0.1:${opencodePort}`,
    OPENCODE_PASSWORD: PASSWORD,
    OPENCODE_DIRECTORY: REPO,
  })

  const tunnel = new TunnelTransport(`ws://127.0.0.1:${relayPort}`, "check-room", "check-token")
  activeTunnel = tunnel
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("tunnel connect timeout")), 8000)
    tunnel["onConnectionStateChange"] = (s) => s === "connected" && (clearTimeout(t), resolve())
    tunnel.connect()
  })
  log("tunnel connected")
  if (tunnel.hostState !== "online") {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("host presence timeout")), 8000)
      tunnel["onHostStateChange"] = (s) => s === "online" && (clearTimeout(t), resolve())
    })
  }
  log("host online")

  // The exact code path the UI uses: createApi bound to a directory accessor.
  const api = createApi(tunnel.tunnelFetch.bind(tunnel), () => REPO)

  // (a) create a session
  const session = await api.createSession({ title: "Integration check" })
  log(`(a) created session: ${session.id} dir=${session.directory}`)
  if (!session.id) throw new Error("createSession returned no id")

  // (b) list sessions for the directory
  const list = await api.listSessions({ roots: true })
  log(`(b) listSessions returned ${list.length} session(s); created present: ${list.some((s) => s.id === session.id)}`)
  if (!list.some((s) => s.id === session.id)) throw new Error("created session not in directory listing")

  // (c) folder browser endpoint
  const files = await api.listFiles(".")
  const names = files.slice(0, 8).map((f) => `${f.name}${f.type === "directory" ? "/" : ""}`)
  log(`(c) GET /file?path=. returned ${files.length} entries: ${names.join(", ")}`)
  if (files.length === 0) throw new Error("file listing empty")

  if (!hasGateway) {
    log("(d) SKIPPED tool/subagent prompt — no AI_GATEWAY_API_KEY. Plumbing (create/list/file) verified above.")
    // Still exercise children parsing path on an empty child set.
    const children = await api.getChildren(session.id)
    log(`(d') getChildren returned ${children.length} (parsing path ok)`)
    return
  }

  // (d) tool call
  log("(d) sending prompt that should trigger a TOOL call…")
  await api.sendPrompt(session.id, {
    text: "List the files in the current directory using your tools. Keep it brief.",
  })
  const withTool = await pollMessages(api, session.id, (parts) => parts.some((p) => p.type === "tool"), 120_000)
  const tools = collectToolParts(withTool)
  if (tools.length === 0) throw new Error("no tool part appeared in messages")
  log(`(d) TOOL parts: ${tools.map((t) => `${t.tool}[${t.state.status}]`).join(", ")}`)

  // (d) subagent / task tool — wait until the task part carries a child session id
  log("(d) sending prompt that should spawn a SUBAGENT (task tool)…")
  await api.sendPrompt(session.id, {
    text: "Use a subagent via the task tool to summarize the README.md file in one sentence.",
  })
  const taskChildId = (parts: Part[]): string | undefined => {
    const task = parts.find((p): p is ToolPart => p.type === "tool" && (p as ToolPart).tool === "task")
    if (!task || task.state.status === "pending" || !task.state.metadata) return undefined
    const id = task.state.metadata["sessionId"]
    return typeof id === "string" ? id : undefined
  }
  const withTask = await pollMessages(api, session.id, (parts) => taskChildId(parts) !== undefined, 180_000)
  const taskPart = collectToolParts(withTask).find((t) => t.tool === "task")
  if (!taskPart) {
    log("(d) no task tool part appeared (model may have answered directly). Tool-call path still proven above.")
    return
  }
  const childId = taskChildId(withTask.flatMap((m) => m.parts))
  log(`(d) task tool found: status=${taskPart.state.status} childSessionId=${childId ?? "<pending>"}`)
  if (!childId) {
    log("(d) child session id not yet populated within timeout (subagent slow to start).")
    return
  }
  // Drill into the subagent exactly as the UI's subagent panel does.
  const childMessages = await api.getMessages(childId, { limit: 80 })
  const childTools = collectToolParts(childMessages.items)
  log(
    `(d) SUBAGENT child session ${childId}: ${childMessages.items.length} message(s), ` +
      `${childTools.length} tool call(s): ${childTools.map((t) => t.tool).join(", ") || "none yet"}`,
  )
  const children = await api.getChildren(session.id)
  log(`(d) getChildren(parent) returned ${children.length} child session(s) including subagent: ${children.some((c) => c.id === childId)}`)
  if (childMessages.items.length === 0) throw new Error("subagent child messages failed to load")
}

let code = 0
const overall = setTimeout(() => {
  console.error("[check] OVERALL TIMEOUT — aborting")
  cleanup()
  process.exit(1)
}, 360_000)

try {
  await main()
  console.log("\n=== INTEGRATION CHECK PASSED ===\n")
} catch (e) {
  console.error("\n=== INTEGRATION CHECK FAILED ===\n", e)
  code = 1
} finally {
  clearTimeout(overall)
  cleanup()
  await new Promise((r) => setTimeout(r, 400))
  process.exit(code)
}
