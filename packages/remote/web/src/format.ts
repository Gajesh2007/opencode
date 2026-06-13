// Pure rendering helpers: HTML escaping, light markdown, tool-call summaries and
// detail bodies, diffs, and time formatting. No DOM dependencies beyond strings.

import type { Part, ToolPart, ToolState } from "./api.js"

export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }
  return text.replace(/[&<>"']/g, (c) => map[c])
}

// Minimal, safe markdown: fenced code, inline code, bold/italic, headings,
// unordered lists, and paragraphs with line breaks. Everything is escaped first.
export function renderMarkdown(text: string): string {
  if (!text) return ""
  const placeholders: string[] = []
  // Pull fenced code blocks out first so their contents are not mangled.
  let work = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang: string, code: string) => {
    const idx = placeholders.length
    const langClass = lang ? ` data-lang="${escapeHtml(lang)}"` : ""
    placeholders.push(`<pre class="code-block"${langClass}><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`)
    return `\u0000CODE${idx}\u0000`
  })

  work = escapeHtml(work)
  work = work.replace(/`([^`\n]+)`/g, "<code>$1</code>")
  work = work.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
  work = work.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")

  const blocks = work.split(/\n{2,}/).map((block) => {
    const trimmed = block.trim()
    if (!trimmed) return ""
    if (trimmed.startsWith("\u0000CODE")) return trimmed
    const lines = trimmed.split("\n")
    if (lines.every((l) => /^\s*[-*+]\s+/.test(l))) {
      const items = lines.map((l) => `<li>${l.replace(/^\s*[-*+]\s+/, "")}</li>`).join("")
      return `<ul>${items}</ul>`
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length + 2
      return `<h${level}>${heading[2]}</h${level}>`
    }
    return `<p>${lines.join("<br/>")}</p>`
  })

  let html = blocks.join("")
  placeholders.forEach((code, idx) => {
    html = html.replace(`\u0000CODE${idx}\u0000`, code)
  })
  return html
}

const TOOL_ICONS: Record<string, string> = {
  read: "📄",
  write: "✏️",
  edit: "✏️",
  bash: "❯",
  grep: "🔍",
  glob: "🔍",
  list: "📁",
  webfetch: "🌐",
  websearch: "🌐",
  task: "🤖",
  todowrite: "✓",
  todoread: "✓",
}

export function toolIcon(tool: string): string {
  return TOOL_ICONS[tool] ?? "⚙"
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

// One-line human summary of a tool call (collapsed card title).
export function toolSummary(part: ToolPart): string {
  const input = part.state.input ?? {}
  const tool = part.tool
  switch (tool) {
    case "read": {
      const fp = str(input.filePath)
      return fp ? basename(fp) : "read file"
    }
    case "write":
    case "edit": {
      const fp = str(input.filePath)
      return fp ? basename(fp) : tool
    }
    case "bash": {
      return str(input.command) ?? str(input.description) ?? "shell command"
    }
    case "grep":
    case "glob": {
      return str(input.pattern) ?? tool
    }
    case "list": {
      return str(input.path) ?? "list files"
    }
    case "webfetch":
    case "websearch": {
      return str(input.url) ?? str(input.query) ?? tool
    }
    case "task": {
      const agent = str(input.subagent_type)
      const desc = str(input.description)
      if (agent && desc) return `@${agent}: ${desc}`
      return desc ?? agent ?? "subagent task"
    }
    default: {
      // Prefer the server-provided human title when present.
      const title = "title" in part.state ? str((part.state as { title?: string }).title) : undefined
      return title ?? tool
    }
  }
}

export function toolStatusLabel(state: ToolState): string {
  switch (state.status) {
    case "pending":
      return "queued"
    case "running":
      return "running…"
    case "completed":
      return "done"
    case "error":
      return "error"
  }
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

// Render a unified-diff string into colored +/- lines.
export function renderDiff(diff: string): string {
  const rows = diff.split("\n").map((line) => {
    let cls = "diff-ctx"
    if (line.startsWith("+++") || line.startsWith("---")) cls = "diff-meta"
    else if (line.startsWith("@@")) cls = "diff-hunk"
    else if (line.startsWith("+")) cls = "diff-add"
    else if (line.startsWith("-")) cls = "diff-del"
    return `<div class="${cls}">${escapeHtml(line || " ")}</div>`
  })
  return `<div class="diff">${rows.join("")}</div>`
}

// Expanded detail body for a tool card. Returns HTML.
export function toolDetail(part: ToolPart): string {
  const state = part.state
  const sections: string[] = []
  const input = state.input ?? {}

  if (part.tool === "bash") {
    const command = str(input.command)
    if (command) sections.push(block("Command", `<pre class="code-block"><code>${escapeHtml(command)}</code></pre>`))
  } else if (part.tool === "edit" || part.tool === "write") {
    const metaDiff =
      state.status === "completed" || state.status === "error" || state.status === "running"
        ? str((state.metadata ?? {})["diff"])
        : undefined
    if (metaDiff) {
      sections.push(block("Diff", renderDiff(metaDiff)))
    } else if (str(input.oldString) || str(input.newString)) {
      const synthetic = [
        ...(str(input.oldString) ?? "")
          .split("\n")
          .map((l) => "-" + l),
        ...(str(input.newString) ?? "")
          .split("\n")
          .map((l) => "+" + l),
      ].join("\n")
      sections.push(block("Diff", renderDiff(synthetic)))
    } else if (str(input.content)) {
      sections.push(block("Content", `<pre class="code-block"><code>${escapeHtml(str(input.content)!)}</code></pre>`))
    }
  }

  // Always show the raw input for transparency (skip the big ones already shown).
  const shownKeys =
    part.tool === "bash" ? ["command"] : part.tool === "edit" || part.tool === "write" ? ["content"] : []
  const restInput = Object.fromEntries(Object.entries(input).filter(([k]) => !shownKeys.includes(k)))
  if (Object.keys(restInput).length > 0) {
    sections.push(block("Input", `<pre class="code-block"><code>${escapeHtml(prettyJson(restInput))}</code></pre>`))
  }

  if (state.status === "completed" && state.output) {
    sections.push(block("Output", `<pre class="code-block"><code>${escapeHtml(state.output)}</code></pre>`))
  }
  if (state.status === "error") {
    sections.push(block("Error", `<pre class="code-block tool-error-text"><code>${escapeHtml(state.error)}</code></pre>`))
  }

  return sections.join("") || `<div class="tool-empty">No details available.</div>`
}

function block(label: string, body: string): string {
  return `<div class="tool-section"><div class="tool-section-label">${label}</div>${body}</div>`
}

// The child session id of a `task` (subagent) tool call, if present.
export function childSessionId(part: ToolPart): string | undefined {
  const state = part.state
  if (state.status === "pending") return undefined
  const meta = state.metadata
  const value = meta ? meta["sessionId"] : undefined
  return typeof value === "string" ? value : undefined
}

export function partText(part: Part): string {
  if (part.type === "text" || part.type === "reasoning") return part.text ?? ""
  return ""
}

export function formatTime(ms: number): string {
  if (!ms) return ""
  const date = new Date(ms)
  const now = Date.now()
  const diff = now - ms
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  const sameDay = new Date(now).toDateString() === date.toDateString()
  if (sameDay) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return date.toLocaleDateString([], { month: "short", day: "numeric" })
}
