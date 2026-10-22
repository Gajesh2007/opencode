import { Global } from "@opencode-ai/core/global"
import { Database as SQLite } from "bun:sqlite"
import { Option, Schema } from "effect"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { SessionTranscript, type Candidate, type Entry, type Resolution } from "./session-transcript"

export type { Resolution } from "./session-transcript"

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))
const safeID = /^[a-z0-9][a-z0-9_-]{0,127}$/i

export async function resolve(query: string, options?: { home?: string; cache?: string }): Promise<Resolution> {
  if (!query.trim())
    return { type: "missing", message: "Provide a Codex session title or full session ID.", candidates: [] }
  const home = path.resolve(options?.home ?? (process.env.CODEX_HOME || path.join(Global.Path.home, ".codex")))
  try {
    const root = await fs.realpath(home)
    const latest = new Map<string, Candidate>()
    const index = await readSource(path.join(root, "session_index.jsonl"), root).catch((error: unknown) => {
      if (missing(error)) return ""
      throw error
    })
    records(index).forEach((row) => {
      if (typeof row.id !== "string" || !safeID.test(row.id)) return
      if (typeof row.thread_name !== "string" || !row.thread_name.trim()) return
      const updatedAt = typeof row.updated_at === "string" ? row.updated_at : undefined
      const previous = latest.get(row.id.toLowerCase())
      if (previous?.updatedAt && updatedAt && Date.parse(previous.updatedAt) > Date.parse(updatedAt)) return
      latest.set(row.id.toLowerCase(), {
        id: row.id,
        title: row.thread_name.trim(),
        ...(updatedAt ? { updatedAt } : {}),
      })
    })
    const id = query
      .trim()
      .match(/^([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})(?=$|[\s,.:;!?()[\]{}])/i)?.[1]
      .toLowerCase()
    if (id && !latest.has(id)) latest.set(id, { id, title: id })
    const matched = SessionTranscript.match(query, [...latest.values()])
    if (matched.type !== "found") return { ...matched, message: `Codex: ${matched.message}` }
    return await load(root, matched.candidate, options?.cache)
  } catch (error) {
    return {
      type: missing(error) ? "missing" : "error",
      message: `Unable to read or cache the local Codex session from ${home}: ${error instanceof Error ? error.message : String(error)}. Check CODEX_HOME, the session_index.jsonl file, and cache permissions.`,
      candidates: [],
    }
  }
}

async function load(home: string, candidate: Candidate, cache?: string): Promise<Resolution> {
  const files = (
    await Promise.all(
      ["sessions", "archived_sessions"].map(async (name) => {
        const directory = path.join(home, name)
        const stat = await fs.lstat(directory).catch((error: unknown) => {
          if (missing(error)) return undefined
          throw error
        })
        if (!stat?.isDirectory() || stat.isSymbolicLink()) return []
        const files = await Array.fromAsync(
          new Bun.Glob("**/*.jsonl").scan({ cwd: directory, absolute: true, onlyFiles: true, followSymlinks: false }),
        )
        return files
          .filter((file) => {
            const basename = path.basename(file).toLowerCase()
            const id = candidate.id.toLowerCase()
            return (
              basename === `${id}.jsonl` || new RegExp(`^rollout-.+-${id}(?:_[a-z0-9_-]+)?\\.jsonl$`).test(basename)
            )
          })
          .map((file) => ({ file, directory }))
      }),
    )
  ).flat()
  const current = await currentRollout(home, candidate.id)
  const selected = current ? files.filter((entry) => entry.file === path.resolve(home, current)) : files
  if (selected.length !== 1) {
    return {
      type: selected.length ? "ambiguous" : "missing",
      message: selected.length
        ? `More than one rollout file was found for Codex session ${candidate.id}, and current thread metadata is unavailable. Resume the session in Codex and retry once its state is checkpointed; no potentially stale rollout was selected.`
        : current
          ? `The current rollout for Codex session ${candidate.id} is missing or outside the allowed session directories. Restore its rollout JSONL file or resume the session in Codex; older rollouts are not used as a fallback.`
          : `The transcript for Codex session ${candidate.id} was not found under ${home}/sessions or archived_sessions. Restore its rollout JSONL file or resume the session in Codex. Symlinked session directories are not followed.`,
      candidates: [candidate],
    }
  }
  const rows = records(await readSource(selected[0].file, selected[0].directory))
  const metadata = rows.find((row) => row.type === "session_meta" && object(row.payload))?.payload
  if (object(metadata) && typeof metadata.id === "string" && metadata.id.toLowerCase() !== candidate.id.toLowerCase()) {
    return {
      type: "error",
      message: `The rollout metadata does not match Codex session ${candidate.id}. Check the session index and rollout filename.`,
      candidates: [candidate],
    }
  }
  const events = rows.flatMap(eventMessage)
  const seen = new Set<string>()
  const messages = (events.length ? events : rows.flatMap(responseMessage)).filter((entry) => {
    const duplicate = entry.ids.some((id) => seen.has(`${entry.role}:${id}`))
    entry.ids.forEach((id) => seen.add(`${entry.role}:${id}`))
    return !duplicate
  })
  if (!messages.length) {
    return {
      type: "missing",
      message: `Codex session ${candidate.id} contains no visible user or assistant messages. Resume it in Codex and retry; reasoning, tools, and injected context are not imported.`,
      candidates: [candidate],
    }
  }
  const directory = await physicalPath(path.resolve(cache ?? path.join(Global.Path.cache, "codex-sessions")))
  if (within(home, directory)) {
    return {
      type: "error",
      message:
        "The transcript cache must be outside CODEX_HOME to keep the Codex source read-only. Choose a separate cache directory.",
      candidates: [candidate],
    }
  }
  const info = {
    source: "codex" as const,
    ...candidate,
    ...(object(metadata) && typeof metadata.cwd === "string" ? { cwd: metadata.cwd } : {}),
  }
  return { type: "found", ...info, ...(await SessionTranscript.writeTranscript(info, messages, directory)) }
}

async function currentRollout(home: string, id: string) {
  const files = await Array.fromAsync(
    new Bun.Glob("state_*.sqlite").scan({ cwd: home, absolute: true, onlyFiles: true, followSymlinks: false }),
  )
  const file = files
    .filter((file) => /^state_\d+\.sqlite$/.test(path.basename(file)))
    .sort((a, b) => Number(path.basename(b).slice(6, -7)) - Number(path.basename(a).slice(6, -7)))[0]
  if (!file) return
  try {
    if (!within(home, await fs.realpath(file))) return
    const before = await fs.lstat(file)
    if (!before.isFile() || before.isSymbolicLink()) return
    if (await pendingJournal(file)) return
    // Ordinary read-only SQLite still writes WAL read marks. Immutable reads avoid
    // source mutations, but are authoritative only without pending WAL/journal data.
    using db = new SQLite(`${pathToFileURL(file).href}?mode=ro&immutable=1`, { readonly: true })
    const row = db.query("select rollout_path from threads where id = ?").get(id)
    const after = await fs.stat(file)
    if (
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size ||
      (await pendingJournal(file))
    )
      return
    if (object(row) && typeof row.rollout_path === "string" && row.rollout_path) return row.rollout_path
  } catch {
    // The state database is optional; competing rollouts remain ambiguous.
  }
}

async function pendingJournal(file: string) {
  return (
    await Promise.all(
      ["-wal", "-journal"].map((suffix) =>
        fs.lstat(file + suffix).then(
          (stat) => stat.size > 0 || stat.isSymbolicLink(),
          (error: unknown) => {
            if (missing(error)) return false
            throw error
          },
        ),
      ),
    )
  ).some(Boolean)
}

function records(text: string) {
  return text.split(/\r?\n/).flatMap((line) => {
    const parsed = decode(line)
    return Option.isSome(parsed) ? [parsed.value] : []
  })
}

function eventMessage(row: Record<string, unknown>) {
  if (row.type !== "event_msg" || !object(row.payload) || analysis(row)) return []
  const payload = row.payload
  if (analysis(payload)) return []
  if (payload.type === "user_message" || payload.type === "agent_message") {
    if (typeof payload.message !== "string") return []
    return visible(
      payload.type === "user_message" ? "user" : "assistant",
      payload.message,
      payload.id,
      payload.client_id,
    )
  }
  if (payload.type !== "item_completed" || !object(payload.item) || analysis(payload.item)) return []
  const item = payload.item
  if (item.type !== "UserMessage" && item.type !== "AgentMessage") return []
  const role = item.type === "UserMessage" ? "user" : "assistant"
  return visible(role, textContent(item.content, ["Text", "text"], role), item.id, item.client_id, payload.client_id)
}

function responseMessage(row: Record<string, unknown>) {
  if (row.type !== "response_item" || !object(row.payload) || analysis(row)) return []
  const payload = row.payload
  if (payload.type !== "message" || (payload.role !== "user" && payload.role !== "assistant") || analysis(payload)) {
    return []
  }
  return visible(
    payload.role,
    textContent(payload.content, ["input_text", "output_text"], payload.role),
    payload.id,
    payload.client_id,
  )
}

function textContent(content: unknown, types: string[], role: Entry["role"]) {
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((part: unknown) =>
      object(part) &&
      typeof part.type === "string" &&
      types.includes(part.type) &&
      typeof part.text === "string" &&
      !analysis(part) &&
      !(role === "user" && injected(part.text))
        ? [part.text]
        : [],
    )
    .join("\n")
}

function visible(role: Entry["role"], text: string, ...ids: unknown[]) {
  if (!text.trim()) return []
  if (role === "user" && injected(text)) return []
  return [{ role, text, ids: ids.filter((id): id is string => typeof id === "string" && !!id) }]
}

function injected(text: string) {
  return /^\s*(?:#\s*AGENTS\.md\s+instructions\b|<environment_context\b)/i.test(text)
}

function analysis(value: Record<string, unknown>) {
  return [value.phase, value.channel].some((item) => typeof item === "string" && item.toLowerCase() === "analysis")
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function within(directory: string, file: string) {
  const relative = path.relative(directory, file)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function readSource(file: string, directory: string) {
  const resolved = await fs.realpath(file)
  if (!within(directory, resolved))
    throw new Error(`Refusing to read a symlink outside the Codex session directory: ${file}`)
  const handle = await fs.open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`The Codex source is not a regular file: ${file}`)
    return await Bun.file(handle.fd).text()
  } finally {
    await handle.close()
  }
}

async function physicalPath(file: string): Promise<string> {
  return fs.realpath(file).catch(async (error: unknown) => {
    if (!missing(error) || path.dirname(file) === file) throw error
    return path.join(await physicalPath(path.dirname(file)), path.basename(file))
  })
}

export * as CodexSession from "./codex-session"
