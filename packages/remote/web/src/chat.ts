// ChatView renders a single session timeline and applies incremental SSE updates
// in place. One instance per session; subagent (task) sessions get their own
// ChatView pushed onto a panel stack by the app controller.

import type { Part, ReasoningPart, TextPart, ToolPart, WithParts } from "./api.js"
import {
  childSessionId,
  escapeHtml,
  renderMarkdown,
  toolDetail,
  toolIcon,
  toolStatusLabel,
  toolSummary,
} from "./format.js"

export interface ChatViewOptions {
  sessionID: string
  onOpenSubagent: (childSessionID: string, title: string) => void
}

export class ChatView {
  readonly sessionID: string
  readonly element: HTMLElement
  private readonly list: HTMLElement
  private readonly onOpenSubagent: (childSessionID: string, title: string) => void

  private order: string[] = []
  private byId = new Map<string, WithParts>()
  private els = new Map<string, HTMLElement>()
  private partOwner = new Map<string, string>()
  private expandedTools = new Set<string>()
  private expandedReasoning = new Set<string>()
  private localIds = new Set<string>()
  private busy = false

  constructor(opts: ChatViewOptions) {
    this.sessionID = opts.sessionID
    this.onOpenSubagent = opts.onOpenSubagent

    this.element = document.createElement("div")
    this.element.className = "chat-view"

    this.list = document.createElement("div")
    this.list.className = "messages-list"
    this.element.appendChild(this.list)

    this.list.addEventListener("click", (e) => this.onClick(e))
    this.renderEmpty()
  }

  // ── Bulk load ──────────────────────────────────────────────────────────────

  setMessages(items: WithParts[]) {
    this.order = []
    this.byId.clear()
    this.els.clear()
    this.partOwner.clear()
    this.list.innerHTML = ""
    for (const item of items) this.insert(item)
    if (this.order.length === 0) this.renderEmpty()
    this.scrollToBottom(true)
  }

  prepend(items: WithParts[]) {
    const before = this.list.scrollHeight
    const prevTop = this.list.scrollTop
    // Insert oldest-first at the top; insert() keeps DOM order sorted.
    for (const item of items) if (!this.byId.has(item.info.id)) this.insert(item)
    const after = this.list.scrollHeight
    this.list.scrollTop = prevTop + (after - before)
  }

  hasMessages() {
    return this.order.length > 0
  }

  // ── Incremental updates ──────────────────────────────────────────────────────

  upsertMessage(info: WithParts["info"]) {
    if (info.role === "user") this.dropLocalPlaceholders()
    const existing = this.byId.get(info.id)
    if (existing) {
      existing.info = info
      this.renderMessage(info.id)
      return
    }
    this.insert({ info, parts: [] })
    this.scrollIfNear()
  }

  upsertPart(part: Part) {
    const msg = this.byId.get(part.messageID)
    if (!msg) return
    const idx = msg.parts.findIndex((p) => p.id === part.id)
    if (idx === -1) msg.parts.push(part)
    else msg.parts[idx] = part
    this.renderMessage(part.messageID)
    this.scrollIfNear()
  }

  applyDelta(messageID: string, partID: string, field: string, delta: string) {
    const msg = this.byId.get(messageID)
    if (!msg) return
    const isReasoning = field === "reasoning" || field === "reasoning_content"
    let part = msg.parts.find((p) => p.id === partID)
    if (!part) {
      part = isReasoning
        ? ({ id: partID, sessionID: this.sessionID, messageID, type: "reasoning", text: "" } satisfies ReasoningPart)
        : ({ id: partID, sessionID: this.sessionID, messageID, type: "text", text: "" } satisfies TextPart)
      msg.parts.push(part)
    }
    if ((part.type === "text" || part.type === "reasoning") && (field === "text" || isReasoning)) {
      part.text += delta
    }
    this.renderMessage(messageID)
    this.scrollIfNear()
  }

  removeMessage(messageID: string) {
    const el = this.els.get(messageID)
    if (el) el.remove()
    this.els.delete(messageID)
    this.byId.delete(messageID)
    this.order = this.order.filter((id) => id !== messageID)
    if (this.order.length === 0) this.renderEmpty()
  }

  removePart(messageID: string, partID: string) {
    const msg = this.byId.get(messageID)
    if (!msg) return
    msg.parts = msg.parts.filter((p) => p.id !== partID)
    this.renderMessage(messageID)
  }

  addOptimisticUser(text: string) {
    const id = "local-" + Math.random().toString(36).slice(2)
    this.localIds.add(id)
    this.insert({
      info: { id, sessionID: this.sessionID, role: "user", time: { created: Date.now() }, agent: "", model: { providerID: "", modelID: "" } },
      parts: [{ id: id + "-p", sessionID: this.sessionID, messageID: id, type: "text", text }],
    })
    this.scrollToBottom(true)
  }

  setBusy(busy: boolean) {
    if (this.busy === busy) return
    this.busy = busy
    this.renderBusy()
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private dropLocalPlaceholders() {
    for (const id of this.localIds) this.removeMessage(id)
    this.localIds.clear()
  }

  private insert(item: WithParts) {
    const empty = this.list.querySelector(".chat-empty")
    if (empty) empty.remove()

    this.byId.set(item.info.id, item)
    const created = item.info.time.created
    let idx = this.order.length
    for (let i = 0; i < this.order.length; i++) {
      const other = this.byId.get(this.order[i])
      if (!other) continue
      if (other.info.time.created > created || (other.info.time.created === created && other.info.id > item.info.id)) {
        idx = i
        break
      }
    }
    this.order.splice(idx, 0, item.info.id)

    const el = document.createElement("div")
    el.className = "msg-wrap"
    this.els.set(item.info.id, el)
    const nextId = this.order[idx + 1]
    const anchor = (nextId ? this.els.get(nextId) : null) ?? this.busyEl()
    // insertBefore throws NotFoundError when the anchor is not a current child
    // of the list. On a brand-new session the busy node gets detached when
    // renderEmpty() resets innerHTML (after the optimistic placeholder is
    // dropped), leaving a stale reference. Fall back to appendChild whenever the
    // anchor is missing or no longer parented by the list.
    if (anchor && anchor.parentNode === this.list) this.list.insertBefore(el, anchor)
    else this.list.appendChild(el)
    this.renderMessage(item.info.id)
    // Re-show the busy indicator at the bottom if a renderEmpty() detached it.
    if (this.busy && !this.busyNode) this.renderBusy()
  }

  private renderMessage(id: string) {
    const msg = this.byId.get(id)
    const el = this.els.get(id)
    if (!msg || !el) return
    for (const part of msg.parts) this.partOwner.set(part.id, id)

    if (msg.info.role === "user") {
      const text = msg.parts
        .filter((p): p is TextPart => p.type === "text" && !p.synthetic)
        .map((p) => p.text)
        .join("\n\n")
      el.className = "msg-wrap msg-user"
      el.innerHTML = `<div class="bubble">${escapeHtml(text).replace(/\n/g, "<br/>")}</div>`
      return
    }

    el.className = "msg-wrap msg-assistant"
    const body = msg.parts.map((part) => this.renderPart(part)).filter(Boolean).join("")
    const agent = msg.info.role === "assistant" && msg.info.agent ? ` · ${escapeHtml(msg.info.agent)}` : ""
    const error =
      msg.info.role === "assistant" && msg.info.error
        ? `<div class="msg-error">${escapeHtml(msg.info.error.data?.message ?? msg.info.error.name ?? "Error")}</div>`
        : ""
    const placeholder = !body && !error ? `<div class="bubble streaming">…</div>` : ""
    el.innerHTML = `<div class="msg-role">opencode${agent}</div>${body}${placeholder}${error}`
  }

  private renderPart(part: Part): string {
    if (part.type === "text") {
      if (!part.text) return ""
      return `<div class="bubble">${renderMarkdown(part.text)}</div>`
    }
    if (part.type === "reasoning") return this.renderReasoning(part)
    if (part.type === "tool") return this.renderTool(part)
    if (part.type === "step-finish") {
      const tokens = part.tokens
      if (!tokens) return ""
      const total = tokens.total ?? tokens.input + tokens.output
      return `<div class="step-finish">${total.toLocaleString()} tokens · $${part.cost.toFixed(4)}</div>`
    }
    return ""
  }

  private renderReasoning(part: ReasoningPart): string {
    if (!part.text) return ""
    const open = this.expandedReasoning.has(part.id)
    const head = `<button class="reasoning-head" data-action="toggle-reasoning" data-part="${part.id}"><span>💭 Thinking</span><span class="chevron">${open ? "▾" : "▸"}</span></button>`
    const bodyOrPreview = open
      ? `<div class="reasoning-body">${escapeHtml(part.text).replace(/\n/g, "<br/>")}</div>`
      : `<div class="reasoning-preview">${escapeHtml(part.text.replace(/\s+/g, " ").slice(0, 90))}…</div>`
    return `<div class="reasoning">${head}${bodyOrPreview}</div>`
  }

  private renderTool(part: ToolPart): string {
    const open = this.expandedTools.has(part.id)
    const child = part.tool === "task" ? childSessionId(part) : undefined
    const head =
      `<button class="tool-head" data-action="toggle-tool" data-part="${part.id}">` +
      `<span class="tool-icon">${toolIcon(part.tool)}</span>` +
      `<span class="tool-name">${escapeHtml(part.tool)}</span>` +
      `<span class="tool-summary">${escapeHtml(toolSummary(part))}</span>` +
      `<span class="tool-status status-${part.state.status}">${toolStatusLabel(part.state)}</span>` +
      `<span class="chevron">${open ? "▾" : "▸"}</span>` +
      `</button>`
    const body = open ? `<div class="tool-body">${toolDetail(part)}</div>` : ""
    const subagent = child
      ? `<button class="subagent-open" data-action="open-subagent" data-child="${escapeHtml(child)}" data-title="${escapeHtml(toolSummary(part))}">View subagent activity →</button>`
      : ""
    return `<div class="tool-card status-${part.state.status}" data-part="${part.id}">${head}${body}${subagent}</div>`
  }

  private onClick(e: MouseEvent) {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-action]")
    if (!target) return
    const action = target.dataset.action
    if (action === "toggle-tool") {
      const partID = target.dataset.part
      if (!partID) return
      this.toggle(this.expandedTools, partID)
      const owner = this.partOwner.get(partID)
      if (owner) this.renderMessage(owner)
      return
    }
    if (action === "toggle-reasoning") {
      const partID = target.dataset.part
      if (!partID) return
      this.toggle(this.expandedReasoning, partID)
      const owner = this.partOwner.get(partID)
      if (owner) this.renderMessage(owner)
      return
    }
    if (action === "open-subagent") {
      const child = target.dataset.child
      if (child) this.onOpenSubagent(child, target.dataset.title ?? "Subagent")
    }
  }

  private toggle(set: Set<string>, key: string) {
    if (set.has(key)) set.delete(key)
    else set.add(key)
  }

  private renderEmpty() {
    // innerHTML reset detaches the busy node; drop the now-stale reference so it
    // can be re-mounted instead of being used as a dangling insertBefore anchor.
    this.busyNode = null
    this.list.innerHTML = `<div class="chat-empty"><div class="chat-empty-icon">✨</div><p>No messages yet.</p><p class="muted">Send a message below to start.</p></div>`
  }

  private busyNode: HTMLElement | null = null
  private busyEl(): HTMLElement | null {
    // Only treat the busy node as a valid anchor while it is mounted in the list.
    if (this.busyNode && this.busyNode.parentNode === this.list) return this.busyNode
    return null
  }

  private renderBusy() {
    if (this.busy && !this.busyNode) {
      const node = document.createElement("div")
      node.className = "busy-indicator"
      node.innerHTML = `<span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="busy-label">working…</span>`
      this.busyNode = node
      this.list.appendChild(node)
      this.scrollIfNear()
      return
    }
    if (!this.busy && this.busyNode) {
      this.busyNode.remove()
      this.busyNode = null
    }
  }

  isNearBottom() {
    return this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 140
  }

  scrollToBottom(force = false) {
    requestAnimationFrame(() => {
      if (force || this.isNearBottom()) this.list.scrollTop = this.list.scrollHeight
    })
  }

  private scrollIfNear() {
    if (this.isNearBottom()) this.scrollToBottom(true)
  }
}
