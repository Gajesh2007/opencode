// opencode REST + SSE client, tunneled through TunnelTransport.
//
// Every request is scoped to a working directory via `?directory=<abs>` (the
// opencode server routes to the matching workspace/instance). The `createApi`
// factory captures a `getDirectory()` accessor so callers never have to remember
// to pass it. Wire shapes mirror `packages/opencode/src/session/message-v2.ts`,
// `session/session.ts`, and `file/index.ts`.

export type TunnelFetch = (path: string, init?: RequestInit) => Promise<Response>

// ── Wire shapes ──────────────────────────────────────────────────────────────

export interface SessionTime {
  created: number
  updated: number
  archived?: number
}

export interface ModelRef {
  providerID: string
  modelID: string
  variant?: string
}

export interface SessionInfo {
  id: string
  slug: string
  projectID: string
  directory: string
  parentID?: string
  title: string
  agent?: string
  model?: ModelRef
  version: string
  time: SessionTime
}

export interface Tokens {
  input: number
  output: number
  reasoning: number
  total?: number
  cache: { read: number; write: number }
}

export interface UserMessage {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  agent: string
  model: ModelRef
}

export interface AssistantMessage {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }
  parentID: string
  modelID: string
  providerID: string
  agent: string
  cost: number
  tokens?: Tokens
  error?: { name: string; data?: { message?: string } }
}

export type MessageInfo = UserMessage | AssistantMessage

export type ToolState =
  | { status: "pending"; input: Record<string, unknown>; raw?: string }
  | {
      status: "running"
      input: Record<string, unknown>
      title?: string
      metadata?: Record<string, unknown>
      time: { start: number }
    }
  | {
      status: "completed"
      input: Record<string, unknown>
      output: string
      title: string
      metadata: Record<string, unknown>
      time: { start: number; end: number }
      attachments?: unknown[]
    }
  | {
      status: "error"
      input: Record<string, unknown>
      error: string
      metadata?: Record<string, unknown>
      time: { start: number; end: number }
    }

export interface TextPart {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
  synthetic?: boolean
  time?: { start: number; end?: number }
}

export interface ReasoningPart {
  id: string
  sessionID: string
  messageID: string
  type: "reasoning"
  text: string
  metadata?: Record<string, unknown>
  time?: { start: number; end?: number }
}

export interface ToolPart {
  id: string
  sessionID: string
  messageID: string
  type: "tool"
  callID: string
  tool: string
  state: ToolState
  metadata?: Record<string, unknown>
}

export interface StepFinishPart {
  id: string
  sessionID: string
  messageID: string
  type: "step-finish"
  cost: number
  tokens?: Tokens
}

export interface GenericPart {
  id: string
  sessionID: string
  messageID: string
  type: "step-start" | "file" | "patch" | "snapshot" | "agent" | "subtask" | "retry" | "compaction"
  [key: string]: unknown
}

export type Part = TextPart | ReasoningPart | ToolPart | StepFinishPart | GenericPart

export interface WithParts {
  info: MessageInfo
  parts: Part[]
}

export interface FileNode {
  name: string
  path: string
  absolute: string
  type: "file" | "directory"
  ignored: boolean
}

export interface FileContent {
  type: "text" | "binary"
  content: string
  diff?: string
  encoding?: "base64"
  mimeType?: string
}

export interface ProjectInfo {
  id: string
  name?: string
  worktree: string
}

export interface AgentInfo {
  name: string
  description?: string
  mode?: string
}

export type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next?: number }

export interface ServerEvent {
  id: string
  type: string
  properties: Record<string, unknown>
}

export interface MessagePage {
  items: WithParts[]
  cursor?: string
}

// ── API surface ──────────────────────────────────────────────────────────────

export interface Api {
  listSessions(opts?: { roots?: boolean; search?: string; limit?: number }): Promise<SessionInfo[]>
  getSession(sessionID: string): Promise<SessionInfo>
  getChildren(sessionID: string): Promise<SessionInfo[]>
  getMessages(sessionID: string, opts?: { limit?: number; before?: string }): Promise<MessagePage>
  createSession(opts?: { title?: string; agent?: string }): Promise<SessionInfo>
  sendPrompt(sessionID: string, opts: { text: string; agent?: string; model?: ModelRef }): Promise<void>
  abortSession(sessionID: string): Promise<void>
  getStatus(): Promise<Record<string, SessionStatus>>
  listFiles(path: string): Promise<FileNode[]>
  readFile(path: string): Promise<FileContent>
  findFile(query: string): Promise<string[]>
  listProjects(): Promise<ProjectInfo[]>
  currentProject(): Promise<ProjectInfo | null>
  listAgents(): Promise<AgentInfo[]>
  getConfig(): Promise<unknown>
  events(onEvent: (event: ServerEvent) => void, signal: AbortSignal): Promise<void>
}

export function createApi(fetch: TunnelFetch, getDirectory: () => string): Api {
  const buildUrl = (path: string, params?: Record<string, string | number | boolean | undefined>) => {
    const search = new URLSearchParams()
    const dir = getDirectory()
    if (dir) search.set("directory", dir)
    if (params)
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) search.set(key, String(value))
      }
    const qs = search.toString()
    return qs ? `${path}?${qs}` : path
  }

  const getJson = async <T>(path: string, params?: Record<string, string | number | boolean | undefined>) => {
    const res = await fetch(buildUrl(path, params))
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await safeText(res)}`)
    return (await res.json()) as T
  }

  const postJson = async (path: string, body: unknown, params?: Record<string, string | number | boolean>) => {
    const res = await fetch(buildUrl(path, params), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await safeText(res)}`)
    return res
  }

  return {
    listSessions: (opts) =>
      getJson<SessionInfo[]>("/session", {
        roots: opts?.roots ?? true,
        search: opts?.search,
        limit: opts?.limit,
      }),
    getSession: (sessionID) => getJson<SessionInfo>(`/session/${encodeURIComponent(sessionID)}`),
    getChildren: (sessionID) => getJson<SessionInfo[]>(`/session/${encodeURIComponent(sessionID)}/children`),
    getMessages: async (sessionID, opts) => {
      const res = await fetch(
        buildUrl(`/session/${encodeURIComponent(sessionID)}/message`, {
          limit: opts?.limit,
          before: opts?.before,
        }),
      )
      if (!res.ok) throw new Error(`GET messages failed: ${res.status} ${await safeText(res)}`)
      const items = (await res.json()) as WithParts[]
      const cursor = res.headers.get("X-Next-Cursor") ?? undefined
      return { items, cursor }
    },
    createSession: async (opts) => {
      const res = await postJson("/session", opts?.title || opts?.agent ? { title: opts?.title, agent: opts?.agent } : {})
      return (await res.json()) as SessionInfo
    },
    sendPrompt: async (sessionID, opts) => {
      await postJson(`/session/${encodeURIComponent(sessionID)}/prompt_async`, {
        parts: [{ type: "text", text: opts.text }],
        ...(opts.agent ? { agent: opts.agent } : {}),
        ...(opts.model ? { model: opts.model } : {}),
      })
    },
    abortSession: async (sessionID) => {
      await postJson(`/session/${encodeURIComponent(sessionID)}/abort`, {})
    },
    getStatus: () => getJson<Record<string, SessionStatus>>("/session/status"),
    listFiles: (path) => getJson<FileNode[]>("/file", { path }),
    readFile: (path) => getJson<FileContent>("/file/content", { path }),
    findFile: (query) => getJson<string[]>("/find/file", { query }),
    listProjects: () => getJson<ProjectInfo[]>("/project"),
    currentProject: async () => {
      try {
        return await getJson<ProjectInfo>("/project/current")
      } catch {
        return null
      }
    },
    listAgents: () => getJson<AgentInfo[]>("/agent"),
    getConfig: () => getJson<unknown>("/config"),
    events: (onEvent, signal) => consumeEvents(fetch, buildUrl("/event"), onEvent, signal),
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ""
  }
}

// ── SSE parsing ──────────────────────────────────────────────────────────────
//
// `currentEvent` MUST persist across reader.read() calls: a single SSE event
// (including its terminating blank line) can be split across chunk boundaries.

async function consumeEvents(
  fetch: TunnelFetch,
  url: string,
  onEvent: (event: ServerEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(url, { signal })
  if (!res.body) throw new Error("No body on event stream response")

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let current: { event?: string; data: string } = { data: "" }

  const flush = () => {
    if (!current.data) {
      current = { data: "" }
      return
    }
    try {
      onEvent(JSON.parse(current.data) as ServerEvent)
    } catch (err) {
      console.error("[api] failed to parse SSE event:", err, current.data)
    }
    current = { data: "" }
  }

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const raw of lines) {
        const line = raw.replace(/\r$/, "")
        if (line === "") {
          flush()
          continue
        }
        if (line.startsWith(":")) continue
        const colon = line.indexOf(":")
        if (colon === -1) continue
        const key = line.slice(0, colon)
        const val = line.slice(colon + 1).replace(/^ /, "")
        if (key === "event") current.event = val
        else if (key === "data") current.data += val
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ── Backwards-compatible standalone helpers (used by smoke-test.ts) ───────────

export async function createSession(fetch: TunnelFetch, directory: string, title?: string): Promise<SessionInfo> {
  return createApi(fetch, () => directory).createSession({ title })
}

export async function promptSession(
  fetch: TunnelFetch,
  sessionID: string,
  directory: string,
  text: string,
): Promise<void> {
  return createApi(fetch, () => directory).sendPrompt(sessionID, { text })
}

export async function getConfig(fetch: TunnelFetch): Promise<unknown> {
  return createApi(fetch, () => "").getConfig()
}

export async function consumeEventStream(
  fetch: TunnelFetch,
  directory: string,
  onEvent: (event: ServerEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  return createApi(fetch, () => directory).events(onEvent, signal)
}
