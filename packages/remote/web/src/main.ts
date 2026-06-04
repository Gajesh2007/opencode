import { TunnelTransport, type ConnectionState, type HostState } from "./tunnel.js"
import {
  createApi,
  type Api,
  type FileNode,
  type MessageInfo,
  type Part,
  type ProjectInfo,
  type ServerEvent,
  type SessionInfo,
  type SessionStatus,
} from "./api.js"
import { ChatView } from "./chat.js"
import { formatTime } from "./format.js"

// ── DOM ──────────────────────────────────────────────────────────────────────

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const el = {
  screens: { connect: byId("screen-connect"), sessions: byId("screen-sessions"), chat: byId("screen-chat") },
  back: byId<HTMLButtonElement>("btn-back"),
  heading: byId("bar-heading"),
  barFolder: byId<HTMLButtonElement>("bar-folder"),
  badgeConn: byId("badge-conn"),
  badgeHost: byId("badge-host"),
  banner: byId("offline-banner"),
  inRelay: byId<HTMLInputElement>("in-relay"),
  inRoom: byId<HTMLInputElement>("in-room"),
  inToken: byId<HTMLInputElement>("in-token"),
  inDir: byId<HTMLInputElement>("in-directory"),
  btnConnect: byId<HTMLButtonElement>("btn-connect"),
  btnPaste: byId<HTMLButtonElement>("btn-paste"),
  folderChip: byId<HTMLButtonElement>("btn-folder"),
  folderLabel: byId("folder-label"),
  btnNew: byId<HTMLButtonElement>("btn-new"),
  sessionsList: byId("sessions-list"),
  chatHost: byId("chat-host"),
  composer: byId<HTMLFormElement>("composer"),
  prompt: byId<HTMLTextAreaElement>("prompt"),
  btnSend: byId<HTMLButtonElement>("btn-send"),
  modal: byId("folder-modal"),
  folderClose: byId<HTMLButtonElement>("folder-close"),
  pathInput: byId<HTMLInputElement>("folder-path-input"),
  pathGo: byId<HTMLButtonElement>("folder-path-go"),
  browserUp: byId<HTMLButtonElement>("browser-up"),
  browserCwd: byId("browser-cwd"),
  browserList: byId("browser-list"),
  browserUse: byId<HTMLButtonElement>("browser-use"),
  projectsList: byId("projects-list"),
  toast: byId("toast"),
}

// ── State ────────────────────────────────────────────────────────────────────

interface Panel {
  sessionID: string
  title: string
  view: ChatView
  cursor?: string
}

let tunnel: TunnelTransport | null = null
let api: Api | null = null
let connectionState: ConnectionState = "disconnected"
let hostState: HostState = "offline"
let currentDirectory = ""
let projectRoot = ""
let browsePath = ""
let sessions: SessionInfo[] = []
let statusMap: Record<string, SessionStatus> = {}
let view: "connect" | "sessions" | "chat" = "connect"
let chatStack: Panel[] = []
let sse: AbortController | null = null
let sessionsReloadTimer: ReturnType<typeof setTimeout> | null = null
let sessionsRenderTimer: ReturnType<typeof setTimeout> | null = null

// ── Boot ─────────────────────────────────────────────────────────────────────

el.inRelay.value = localStorage.getItem("oc_relay") ?? ""
el.inRoom.value = localStorage.getItem("oc_room") ?? ""
el.inToken.value = localStorage.getItem("oc_token") ?? ""
el.inDir.value = localStorage.getItem("oc_dir") ?? ""
currentDirectory = el.inDir.value.trim()

updateConnBadge()
updateHostBadge()
updateTopbar()
wireEvents()

// ── Helpers ──────────────────────────────────────────────────────────────────

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const props = <T>(e: ServerEvent): T => e.properties as unknown as T
const panelFor = (sessionID: string) => chatStack.find((p) => p.sessionID === sessionID)
const statusOf = (sessionID: string): SessionStatus => statusMap[sessionID] ?? { type: "idle" }

function shortDir(dir: string): string {
  if (!dir) return "default folder"
  const norm = dir.replace(/\/+$/, "")
  const base = norm.slice(norm.lastIndexOf("/") + 1)
  return base || norm || "/"
}

function parentOf(dir: string): string {
  const norm = dir.replace(/\/+$/, "")
  const idx = norm.lastIndexOf("/")
  if (idx <= 0) return "/"
  return norm.slice(0, idx)
}

function toast(message: string, isError = false) {
  el.toast.textContent = message
  el.toast.className = `toast show${isError ? " error" : ""}`
  setTimeout(() => el.toast.classList.remove("show"), 3200)
}

function setView(next: typeof view) {
  view = next
  el.screens.connect.classList.toggle("hidden", next !== "connect")
  el.screens.sessions.classList.toggle("hidden", next !== "sessions")
  el.screens.chat.classList.toggle("hidden", next !== "chat")
  updateComposerVisibility()
  updateTopbar()
}

function updateComposerVisibility() {
  el.composer.classList.toggle("hidden", !(view === "chat" && chatStack.length === 1))
}

function updateTopbar() {
  el.back.classList.toggle("hidden", view !== "chat")
  if (view === "connect") {
    el.heading.textContent = "opencode"
    el.barFolder.classList.add("hidden")
    return
  }
  el.heading.textContent = view === "sessions" ? "Sessions" : (chatStack[chatStack.length - 1]?.title ?? "Chat")
  el.barFolder.classList.remove("hidden")
  el.barFolder.textContent = shortDir(currentDirectory)
}

function updateFolderLabels() {
  el.folderLabel.textContent = currentDirectory || "default folder"
  if (view !== "connect") el.barFolder.textContent = shortDir(currentDirectory)
}

// ── Connection ─────────────────────────────────────────────────────────────--

function connect() {
  const relay = el.inRelay.value.trim()
  const room = el.inRoom.value.trim()
  const token = el.inToken.value.trim()
  const dir = el.inDir.value.trim()
  if (!relay || !room || !token) {
    toast("Relay, room and token are required", true)
    return
  }
  localStorage.setItem("oc_relay", relay)
  localStorage.setItem("oc_room", room)
  localStorage.setItem("oc_token", token)
  localStorage.setItem("oc_dir", dir)
  currentDirectory = dir

  el.btnConnect.disabled = true
  el.btnConnect.textContent = "Connecting…"

  tunnel = new TunnelTransport(relay, room, token, onConnectionState, onHostState)
  api = createApi(tunnel.tunnelFetch.bind(tunnel), () => currentDirectory)
  tunnel.connect()
}

function onConnectionState(state: ConnectionState) {
  connectionState = state
  updateConnBadge()
  updateBanner()
  if (state === "connected") {
    el.btnConnect.disabled = false
    el.btnConnect.textContent = "Connect"
    startSSE()
    void afterConnected()
    return
  }
  if (state === "disconnected") {
    el.btnConnect.disabled = false
    el.btnConnect.textContent = "Connect"
    if (sse) {
      sse.abort()
      sse = null
    }
  }
}

function onHostState(state: HostState) {
  hostState = state
  updateHostBadge()
  updateBanner()
  if (state === "online" && connectionState === "connected") void loadSessions()
}

async function afterConnected() {
  if (!api) return
  try {
    if (!currentDirectory) {
      const project = await api.currentProject()
      if (project?.worktree) currentDirectory = project.worktree
    }
  } catch {
    // host may still be coming online; sessions load will retry visibility
  }
  if (!projectRoot) projectRoot = currentDirectory || "/"
  updateFolderLabels()
  if (view === "connect") setView("sessions")
  await loadSessions()
}

function startSSE() {
  if (!api) return
  if (sse) sse.abort()
  sse = new AbortController()
  const signal = sse.signal
  api.events(handleEvent, signal).catch((err) => {
    if (signal.aborted) return
    console.error("[sse]", err)
    setTimeout(() => {
      if (connectionState === "connected" && !signal.aborted) startSSE()
    }, 2000)
  })
}

// ── SSE routing ──────────────────────────────────────────────────────────────

function handleEvent(event: ServerEvent) {
  switch (event.type) {
    case "server.connected":
    case "server.heartbeat":
      return
    case "session.status": {
      const p = props<{ sessionID: string; status: SessionStatus }>(event)
      statusMap[p.sessionID] = p.status
      panelFor(p.sessionID)?.view.setBusy(p.status.type !== "idle")
      scheduleSessionsRender()
      return
    }
    case "session.idle": {
      const p = props<{ sessionID: string }>(event)
      statusMap[p.sessionID] = { type: "idle" }
      panelFor(p.sessionID)?.view.setBusy(false)
      scheduleSessionsRender()
      return
    }
    case "message.updated": {
      const p = props<{ info: MessageInfo }>(event)
      panelFor(p.info.sessionID)?.view.upsertMessage(p.info)
      return
    }
    case "message.part.updated": {
      const p = props<{ part: Part }>(event)
      panelFor(p.part.sessionID)?.view.upsertPart(p.part)
      return
    }
    case "message.part.delta": {
      const p = props<{ sessionID: string; messageID: string; partID: string; field: string; delta: string }>(event)
      panelFor(p.sessionID)?.view.applyDelta(p.messageID, p.partID, p.field, p.delta)
      return
    }
    case "message.part.removed": {
      const p = props<{ sessionID: string; messageID: string; partID: string }>(event)
      panelFor(p.sessionID)?.view.removePart(p.messageID, p.partID)
      return
    }
    case "message.removed": {
      const p = props<{ sessionID: string; messageID: string }>(event)
      panelFor(p.sessionID)?.view.removeMessage(p.messageID)
      return
    }
    case "session.created":
    case "session.updated":
    case "session.deleted":
      scheduleSessionsReload()
      return
  }
}

// ── Sessions ─────────────────────────────────────────────────────────────────

async function loadSessions() {
  if (!api) return
  try {
    sessions = await api.listSessions({ roots: true })
    try {
      statusMap = await api.getStatus()
    } catch {
      // status is best-effort
    }
    renderSessions()
  } catch (e) {
    toast("Failed to load sessions: " + errMsg(e), true)
  }
}

function scheduleSessionsReload() {
  if (sessionsReloadTimer) return
  sessionsReloadTimer = setTimeout(() => {
    sessionsReloadTimer = null
    void loadSessions()
  }, 400)
}

function scheduleSessionsRender() {
  if (sessionsRenderTimer) return
  sessionsRenderTimer = setTimeout(() => {
    sessionsRenderTimer = null
    if (view === "sessions") renderSessions()
  }, 250)
}

function renderSessions() {
  const sorted = [...sessions].sort((a, b) => b.time.updated - a.time.updated)
  if (sorted.length === 0) {
    el.sessionsList.innerHTML = `<div class="empty-state"><div class="big">💬</div><p>No sessions in this folder.</p><p class="muted">Tap “+ New” to start one.</p></div>`
    return
  }
  el.sessionsList.innerHTML = ""
  for (const s of sorted) {
    const busy = statusOf(s.id).type !== "idle"
    const item = document.createElement("div")
    item.className = "session-item"
    item.innerHTML =
      `<div class="session-row"><div class="session-title">${escape(s.title || "Untitled session")}</div>` +
      `<div class="session-time">${formatTime(s.time.updated)}</div></div>` +
      `<div class="session-sub">${busy ? `<span class="session-busy">working</span>` : ""}` +
      `${s.agent ? `<span class="session-agent">@${escape(s.agent)}</span>` : ""}</div>`
    item.addEventListener("click", () => void openSession(s.id, s.title || "Session"))
    el.sessionsList.appendChild(item)
  }
}

async function newSession() {
  if (!api) return
  try {
    const created = await api.createSession({})
    sessions.unshift(created)
    renderSessions()
    await openSession(created.id, created.title || "New session")
  } catch (e) {
    toast("Failed to create session: " + errMsg(e), true)
  }
}

// ── Chat panels ──────────────────────────────────────────────────────────────

async function openSession(sessionID: string, title: string) {
  clearStack()
  const panel = makePanel(sessionID, title)
  chatStack = [panel]
  el.chatHost.appendChild(panel.view.element)
  setView("chat")
  await loadPanel(panel)
  panel.view.setBusy(statusOf(sessionID).type !== "idle")
}

function makePanel(sessionID: string, title: string): Panel {
  return { sessionID, title, view: new ChatView({ sessionID, onOpenSubagent }) }
}

function onOpenSubagent(childSessionID: string, title: string) {
  void pushSubagent(childSessionID, title)
}

async function pushSubagent(childSessionID: string, title: string) {
  if (panelFor(childSessionID)) return
  chatStack[chatStack.length - 1]?.view.element.classList.add("hidden")
  const panel = makePanel(childSessionID, title)
  chatStack.push(panel)
  el.chatHost.appendChild(panel.view.element)
  updateComposerVisibility()
  updateTopbar()
  await loadPanel(panel)
  panel.view.setBusy(statusOf(childSessionID).type !== "idle")
}

async function loadPanel(panel: Panel) {
  if (!api) return
  try {
    const page = await api.getMessages(panel.sessionID, { limit: 80 })
    panel.view.setMessages(page.items)
    panel.cursor = page.cursor
  } catch (e) {
    toast("Failed to load messages: " + errMsg(e), true)
  }
}

function clearStack() {
  for (const panel of chatStack) panel.view.element.remove()
  chatStack = []
  el.chatHost.innerHTML = ""
}

function goBack() {
  if (view !== "chat") return
  if (chatStack.length > 1) {
    const panel = chatStack.pop()
    panel?.view.element.remove()
    chatStack[chatStack.length - 1]?.view.element.classList.remove("hidden")
    updateComposerVisibility()
    updateTopbar()
    return
  }
  clearStack()
  setView("sessions")
  void loadSessions()
}

async function send() {
  const text = el.prompt.value.trim()
  if (!text) return
  const panel = chatStack[0]
  if (!panel || !api) return
  if (connectionState !== "connected") {
    toast("Not connected to relay", true)
    return
  }
  el.prompt.value = ""
  autoGrow()
  updateSendEnabled()
  panel.view.addOptimisticUser(text)
  panel.view.setBusy(true)
  try {
    await api.sendPrompt(panel.sessionID, { text })
  } catch (e) {
    panel.view.setBusy(false)
    toast("Failed to send: " + errMsg(e), true)
  }
}

// ── Folder switching / browsing ──────────────────────────────────────────────

function openFolderModal() {
  el.modal.classList.remove("hidden")
  el.pathInput.value = currentDirectory
  browsePath = currentDirectory || projectRoot || "/"
  void renderBrowser()
  void renderProjects()
}

function closeFolderModal() {
  el.modal.classList.add("hidden")
}

async function browseList(dir: string): Promise<FileNode[]> {
  if (!tunnel) throw new Error("not connected")
  const res = await tunnel.tunnelFetch(`/file?path=.&directory=${encodeURIComponent(dir)}`)
  if (!res.ok) throw new Error(`status ${res.status}`)
  return (await res.json()) as FileNode[]
}

async function renderBrowser() {
  el.browserCwd.textContent = browsePath
  el.browserList.innerHTML = `<div class="browser-empty">Loading…</div>`
  try {
    const nodes = await browseList(browsePath)
    const dirs = nodes.filter((n) => n.type === "directory").sort((a, b) => a.name.localeCompare(b.name))
    const files = nodes.filter((n) => n.type === "file").sort((a, b) => a.name.localeCompare(b.name))
    if (dirs.length === 0 && files.length === 0) {
      el.browserList.innerHTML = `<div class="browser-empty">Empty folder</div>`
      return
    }
    el.browserList.innerHTML = ""
    for (const node of [...dirs, ...files]) {
      const row = document.createElement("div")
      row.className = `browser-row${node.type === "file" ? " is-file" : ""}`
      row.innerHTML = `<span class="b-icon">${node.type === "directory" ? "📁" : "📄"}</span><span class="b-name">${escape(node.name)}</span>`
      if (node.type === "directory")
        row.addEventListener("click", () => {
          browsePath = node.absolute
          void renderBrowser()
        })
      el.browserList.appendChild(row)
    }
  } catch (e) {
    el.browserList.innerHTML = `<div class="browser-empty">Cannot list: ${escape(errMsg(e))}</div>`
  }
}

async function renderProjects() {
  if (!api) return
  try {
    const projects = await api.listProjects()
    el.projectsList.innerHTML = ""
    if (projects.length === 0) {
      el.projectsList.innerHTML = `<div class="browser-empty">No projects</div>`
      return
    }
    for (const project of projects) {
      const row = document.createElement("div")
      row.className = "project-row"
      row.innerHTML = `<div class="project-name">${escape(projectName(project))}</div><div class="project-path">${escape(project.worktree)}</div>`
      row.addEventListener("click", () => setDirectory(project.worktree))
      el.projectsList.appendChild(row)
    }
  } catch {
    el.projectsList.innerHTML = `<div class="browser-empty">Projects unavailable</div>`
  }
}

function projectName(project: ProjectInfo): string {
  return project.name || shortDir(project.worktree)
}

function setDirectory(dir: string) {
  const trimmed = dir.trim()
  if (!trimmed) return
  currentDirectory = trimmed
  localStorage.setItem("oc_dir", trimmed)
  projectRoot = trimmed
  updateFolderLabels()
  closeFolderModal()
  clearStack()
  setView("sessions")
  void loadSessions()
  toast("Switched to " + shortDir(trimmed))
}

// ── Badges / banner ──────────────────────────────────────────────────────────

function updateConnBadge() {
  const map: Record<ConnectionState, [string, string]> = {
    connected: ["badge badge-connected", "online"],
    connecting: ["badge badge-connecting", "connecting"],
    disconnected: ["badge badge-disconnected", "offline"],
  }
  const [cls, label] = map[connectionState]
  el.badgeConn.className = cls
  el.badgeConn.textContent = label
}

function updateHostBadge() {
  const online = hostState === "online"
  el.badgeHost.className = `badge ${online ? "badge-host-online" : "badge-host-offline"}`
  el.badgeHost.textContent = online ? "host" : "no host"
}

function updateBanner() {
  const show = connectionState === "connected" && hostState === "offline"
  el.banner.classList.toggle("hidden", !show)
}

// ── Input handling ───────────────────────────────────────────────────────────

function autoGrow() {
  el.prompt.style.height = "auto"
  el.prompt.style.height = Math.min(el.prompt.scrollHeight, 132) + "px"
}

function updateSendEnabled() {
  el.btnSend.disabled = el.prompt.value.trim().length === 0
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c]!)
}

function pasteConnectionString() {
  const raw = window.prompt("Paste connection string (relay=…;room=…;token=…;dir=…)")
  if (!raw) return
  for (const segment of raw.split(/[;\n]/)) {
    const idx = segment.indexOf("=")
    if (idx === -1) continue
    const key = segment.slice(0, idx).trim().toLowerCase()
    const value = segment.slice(idx + 1).trim()
    if (key === "relay") el.inRelay.value = value
    else if (key === "room") el.inRoom.value = value
    else if (key === "token") el.inToken.value = value
    else if (key === "dir" || key === "directory") el.inDir.value = value
  }
  toast("Parsed connection string")
}

// ── Wiring ───────────────────────────────────────────────────────────────────

function wireEvents() {
  el.btnConnect.addEventListener("click", connect)
  el.btnPaste.addEventListener("click", pasteConnectionString)
  el.back.addEventListener("click", goBack)
  el.btnNew.addEventListener("click", () => void newSession())
  el.folderChip.addEventListener("click", openFolderModal)
  el.barFolder.addEventListener("click", openFolderModal)
  el.folderClose.addEventListener("click", closeFolderModal)
  el.modal.addEventListener("click", (e) => {
    if (e.target === el.modal) closeFolderModal()
  })
  el.browserUp.addEventListener("click", () => {
    browsePath = parentOf(browsePath)
    void renderBrowser()
  })
  el.browserUse.addEventListener("click", () => setDirectory(browsePath))
  el.pathGo.addEventListener("click", () => setDirectory(el.pathInput.value))
  el.pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault()
      setDirectory(el.pathInput.value)
    }
  })

  el.composer.addEventListener("submit", (e) => {
    e.preventDefault()
    void send()
  })
  el.prompt.addEventListener("input", () => {
    autoGrow()
    updateSendEnabled()
  })
  el.prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  })
}
