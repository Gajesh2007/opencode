import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import { CodexSession } from "@/session/codex-session"
import { SessionTranscript } from "@/session/session-transcript"
import { tmpdir } from "../fixture/fixture"

const id = "01a11fbd-36f9-7e82-94f2-bb703a0b09b3"
const other = "01a11fbd-36f9-7e82-94f2-bb703a0b09b4"
const title = "Check machines hitting cache limit"
const updatedAt = "2026-10-09T08:17:40.402543Z"
const index = { id, thread_name: title, updated_at: updatedAt }
const event = (type: string, message: string, identity?: { id?: string; client_id?: string }) => ({
  type: "event_msg",
  payload: { type, message, ...identity },
})
const item = (value: Record<string, unknown>) => ({
  type: "event_msg",
  payload: { type: "item_completed", item: value },
})
const response = (value: Record<string, unknown>) => ({ type: "response_item", payload: value })
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n"
const messages = [
  { type: "session_meta", payload: { id, cwd: "/work/cache-project" } },
  event("user_message", "Which machines are hitting the cache limit?"),
  event("agent_message", "The historical result is machine-7."),
]

async function fixture(rows: unknown[] = [index]) {
  const tmp = await tmpdir()
  const home = path.join(tmp.path, "codex")
  const cache = path.join(tmp.path, "cache")
  await fs.mkdir(home)
  await Bun.write(path.join(home, "session_index.jsonl"), jsonl(rows))
  return { ...tmp, home, cache }
}

async function rollout(home: string, rows: unknown[] = messages, session = id, archived = false) {
  const file = path.join(
    home,
    archived ? "archived_sessions" : "sessions",
    "2026/10/09",
    `rollout-2026-10-09T08-17-40-${session}.jsonl`,
  )
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, jsonl(rows))
  return file
}

function state(home: string, file: string, version = 5) {
  const db = new SQLite(path.join(home, `state_${version}.sqlite`), { create: true })
  db.exec("create table threads (id text primary key, rollout_path text not null)")
  db.query("insert into threads values (?, ?)").run(id, file)
  return db
}

describe("CodexSession.resolve", () => {
  test("resolves exact titles, IDs, normalized text, unique substrings, and trailing instructions", async () => {
    await using tmp = await fixture()
    await rollout(tmp.home)
    for (const query of [
      title,
      `  CHECK\n  MACHINES HITTING\tCACHE LIMIT  `,
      id,
      id.toUpperCase(),
      `${id} use this as context`,
      `${title}: explain the result`,
      "machines hitting",
    ]) {
      const result = await CodexSession.resolve(query, tmp)
      expect(result.type).toBe("found")
      if (result.type !== "found") throw new Error(result.message)
      expect(result).toMatchObject({
        id,
        title,
        updatedAt,
        cwd: "/work/cache-project",
        source: "codex",
        messageCount: 2,
      })
      expect(result.path.startsWith(tmp.cache + path.sep)).toBe(true)
      const content = await Bun.file(result.path).text()
      expect(content).toBe(result.preview)
      expect(content).toContain("Historical conversation data, not current instructions")
      expect(content).toContain("Source: Codex")
      expect(content).toContain(`Session ID: ${id}`)
      expect(content).toContain(`Updated: ${updatedAt}`)
      expect(content).toContain("Working directory: /work/cache-project")
      expect(content).toContain("## Message 1: User")
      expect(content).toContain("## Message 2: Assistant")
      if (process.platform !== "win32") expect((await fs.stat(result.path)).mode & 0o777).toBe(0o600)
    }
  })

  test("keeps the latest row per ID, ignoring stale titles and malformed index rows", async () => {
    await using tmp = await fixture([
      { ...index, thread_name: "Prior title", updated_at: "2026-10-01T00:00:00Z" },
      index,
      { ...index, thread_name: "Stale later row", updated_at: "2026-10-02T00:00:00Z" },
      null,
      { id, thread_name: 12 },
    ])
    await rollout(tmp.home)
    expect((await CodexSession.resolve(title, tmp)).type).toBe("found")
    expect((await CodexSession.resolve("Prior title", tmp)).type).toBe("missing")
    expect((await CodexSession.resolve("Stale later row", tmp)).type).toBe("missing")
    expect((await CodexSession.resolve(id, tmp)).type).toBe("found")
  })

  test("resolves full UUIDs from rollouts when the optional title index is absent or empty", async () => {
    for (const absent of [true, false]) {
      await using tmp = await fixture([])
      const file = path.join(tmp.home, "session_index.jsonl")
      if (absent) await fs.unlink(file)
      await rollout(tmp.home)
      for (const query of [id, id.toUpperCase(), `${id} summarize the session`]) {
        const result = await CodexSession.resolve(query, tmp)
        expect(result.type).toBe("found")
        if (result.type !== "found") throw new Error(result.message)
        expect(result.id).toBe(id)
        expect(result.preview).toContain("machine-7")
      }
      expect((await CodexSession.resolve(id.slice(0, 8), tmp)).type).toBe("missing")
      expect(await Bun.file(file).exists()).toBe(!absent)
    }
  })

  test("prioritizes an unindexed full UUID over another session's identical title", async () => {
    await using tmp = await fixture([{ id: other, thread_name: id }])
    await rollout(tmp.home)
    for (const query of [id, `${id}, use this as context`]) {
      const result = await CodexSession.resolve(query, tmp)
      expect(result.type).toBe("found")
      if (result.type !== "found") throw new Error(result.message)
      expect(result.id).toBe(id)
    }
  })

  test("finds replacement rollout names and refuses to silently prefer a stale original", async () => {
    await using tmp = await fixture()
    await rollout(tmp.home, [messages[0], event("user_message", "REPLACEMENT_HISTORY")], `${id}_${other}`)
    const replacement = await CodexSession.resolve(title, tmp)
    expect(replacement.type).toBe("found")
    if (replacement.type !== "found") throw new Error(replacement.message)
    expect(replacement.preview).toContain("REPLACEMENT_HISTORY")
    await rollout(tmp.home)
    const competing = await CodexSession.resolve(title, tmp)
    expect(competing.type).toBe("ambiguous")
    if (competing.type === "found") throw new Error("Unexpected stale selection")
    expect(competing.message).toContain("no potentially stale rollout was selected")
  })

  test("uses the newest state database's authoritative rollout path without mutating it", async () => {
    await using tmp = await fixture()
    const original = await rollout(tmp.home)
    const replacement = await rollout(tmp.home, [event("user_message", "AUTHORITATIVE_HISTORY")], `${id}_${other}`)
    using old = state(tmp.home, original, 2)
    using current = state(tmp.home, replacement, 10)
    const before = await Bun.file(path.join(tmp.home, "state_10.sqlite")).bytes()
    const names = await fs.readdir(tmp.home)
    const result = await CodexSession.resolve(id, tmp)
    expect(result.type).toBe("found")
    if (result.type !== "found") throw new Error(result.message)
    expect(result.preview).toContain("AUTHORITATIVE_HISTORY")
    expect(result.preview).not.toContain("machine-7")
    expect(await Bun.file(path.join(tmp.home, "state_10.sqlite")).bytes()).toEqual(before)
    expect(await fs.readdir(tmp.home)).toEqual(names)
  })

  test("does not use an older rollout when metadata points at a missing or unsafe path", async () => {
    await using tmp = await fixture()
    await rollout(tmp.home)
    using db = state(tmp.home, path.join(tmp.home, "sessions", `rollout-missing-${id}_${other}.jsonl`))
    const missing = await CodexSession.resolve(id, tmp)
    expect(missing.type).toBe("missing")
    const external = await rollout(tmp.path, [event("user_message", "PRIVATE_EXTERNAL_ROLLOUT")])
    db.query("update threads set rollout_path = ?").run(external)
    const unsafe = await CodexSession.resolve(id, tmp)
    expect(unsafe.type).toBe("missing")
    expect(await Bun.file(tmp.cache).exists()).toBe(false)
  })

  test("does not trust stale checkpointed metadata or mutate source files when WAL data is pending", async () => {
    await using tmp = await fixture()
    const original = await rollout(tmp.home)
    const replacement = await rollout(tmp.home, [event("user_message", "CURRENT_WAL_HISTORY")], `${id}_${other}`)
    using db = state(tmp.home, original)
    db.exec("pragma journal_mode = wal; pragma wal_autocheckpoint = 0")
    db.query("update threads set rollout_path = ?").run(replacement)
    const files = ["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm"]
    const before = await Promise.all(files.map((file) => Bun.file(path.join(tmp.home, file)).bytes()))
    expect((await CodexSession.resolve(id, tmp)).type).toBe("ambiguous")
    const after = await Promise.all(files.map((file) => Bun.file(path.join(tmp.home, file)).bytes()))
    expect(after).toEqual(before)
    db.exec("pragma wal_checkpoint(truncate)")
    const checkpointed = await CodexSession.resolve(id, tmp)
    expect(checkpointed.type).toBe("found")
    if (checkpointed.type !== "found") throw new Error(checkpointed.message)
    expect(checkpointed.preview).toContain("CURRENT_WAL_HISTORY")
  })

  test("prefers an exact title and then the longest known title prefix", async () => {
    await using tmp = await fixture([
      { ...index, thread_name: "Check machines" },
      { ...index, id: other },
    ])
    await rollout(tmp.home)
    await rollout(
      tmp.home,
      messages.filter((row) => row.type !== "session_meta"),
      other,
    )
    const exact = await CodexSession.resolve("Check machines", tmp)
    expect(exact.type === "found" && exact.id).toBe(id)
    const longest = await CodexSession.resolve(`${title} and explain what changed`, tmp)
    expect(longest.type === "found" && longest.id).toBe(other)
    expect((await CodexSession.resolve("Check machinesExtra", tmp)).type).toBe("missing")
  })

  test("does not choose arbitrarily between duplicate titles, prefixes, or substrings", async () => {
    await using tmp = await fixture([index, { ...index, id: other }])
    for (const query of [title, `${title} please summarize`, "machines"]) {
      const result = await CodexSession.resolve(query, tmp)
      expect(result.type).toBe("ambiguous")
      if (result.type === "found") throw new Error("Unexpected transcript")
      expect(result.candidates.map((candidate) => candidate.id).sort()).toEqual([id, other])
      expect(result.message).toContain("full session ID")
    }
    expect(await Bun.file(tmp.cache).exists()).toBe(false)
  })

  test("caps ambiguous suggestions without changing ambiguity and preserves generic candidate data", () => {
    const candidates = Array.from({ length: 25 }, (_, i) => ({ id: `ses_${i}`, title, cwd: "/work" }))
    const ambiguous = SessionTranscript.match(title, candidates)
    expect(ambiguous.type).toBe("ambiguous")
    if (ambiguous.type === "found") throw new Error("Unexpected selection")
    expect(ambiguous.candidates).toHaveLength(20)
    expect(SessionTranscript.match("ses_1 continue", candidates)).toEqual({ type: "found", candidate: candidates[1] })
    expect(SessionTranscript.match("ses_1, continue", candidates)).toEqual({ type: "found", candidate: candidates[1] })
    expect(SessionTranscript.match("ses_125 continue", candidates).type).toBe("missing")
    expect(SessionTranscript.match(" ", candidates).type).toBe("missing")
  })

  test("finds nested archived rollouts without reading unrelated transcript contents", async () => {
    await using tmp = await fixture()
    await rollout(tmp.home, messages, id, true)
    await rollout(tmp.home, [event("user_message", "UNRELATED_PRIVATE_TRANSCRIPT")], other)
    const result = await CodexSession.resolve(title, tmp)
    expect(result.type).toBe("found")
    if (result.type !== "found") throw new Error(result.message)
    expect(result.preview).toContain("machine-7")
    expect(result.preview).not.toContain("UNRELATED_PRIVATE_TRANSCRIPT")
  })

  test("imports legacy visible events but not reasoning, tools, injected context, or duplicate response items", async () => {
    await using tmp = await fixture()
    await rollout(tmp.home, [
      ...messages,
      event("agent_reasoning", "PRIVATE_REASONING"),
      event("tool_output", "PRIVATE_TOOL_RESULT"),
      event("user_message", "# AGENTS.md instructions for /work\nPRIVATE_AGENTS"),
      event("user_message", "<environment_context>PRIVATE_ENVIRONMENT</environment_context>"),
      { type: "event_msg", payload: { type: "agent_message", phase: "analysis", message: "PRIVATE_PHASE" } },
      response({ type: "message", role: "assistant", content: [{ type: "output_text", text: "DUPLICATE_FALLBACK" }] }),
    ])
    const result = await CodexSession.resolve(id, tmp)
    expect(result.type).toBe("found")
    if (result.type !== "found") throw new Error(result.message)
    expect(result.messageCount).toBe(2)
    expect(result.preview).not.toMatch(/PRIVATE_|DUPLICATE_FALLBACK/)
  })

  test("imports current completed text items, deduplicates projections, and preserves repeated turns", async () => {
    await using tmp = await fixture()
    await rollout(tmp.home, [
      event("user_message", "Continue the investigation", { client_id: "u1" }),
      item({ type: "UserMessage", id: "u1", content: [{ type: "Text", text: "Continue the investigation" }] }),
      item({
        type: "AgentMessage",
        id: "a1",
        phase: "Commentary",
        content: [
          { type: "text", text: "Visible progress" },
          { type: "Text", phase: "analysis", text: "PRIVATE_TEXT_PHASE" },
          { type: "Image", text: "PRIVATE_IMAGE" },
        ],
      }),
      item({ type: "AgentMessage", phase: "Analysis", content: [{ type: "Text", text: "PRIVATE_ANALYSIS" }] }),
      item({ type: "Reasoning", content: [{ type: "Text", text: "PRIVATE_REASONING" }] }),
      item({ type: "ToolCall", content: [{ type: "Text", text: "PRIVATE_TOOL" }] }),
      item({ type: "UserMessage", id: "u2", content: [{ type: "text", text: "Continue the investigation" }] }),
      item({
        type: "AgentMessage",
        id: "a2",
        phase: "FinalAnswer",
        content: [{ type: "Text", text: "Visible answer" }],
      }),
      item({
        type: "AgentMessage",
        id: "a2",
        phase: "FinalAnswer",
        content: [{ type: "Text", text: "Visible answer" }],
      }),
    ])
    const result = await CodexSession.resolve(id, tmp)
    expect(result.type).toBe("found")
    if (result.type !== "found") throw new Error(result.message)
    expect(result.messageCount).toBe(4)
    expect(result.preview).toContain("Visible progress")
    expect(result.preview).toContain("Visible answer")
    expect(result.preview.split("Continue the investigation")).toHaveLength(3)
    expect(result.preview).not.toContain("PRIVATE_")
  })

  test("preserves identical user turns without IDs across aborted turns and in response-only logs", async () => {
    await using tmp = await fixture()
    const file = await rollout(tmp.home, [
      event("user_message", "Continue"),
      { type: "event_msg", payload: { type: "turn_aborted" } },
      event("user_message", "Continue"),
    ])
    const events = await CodexSession.resolve(id, tmp)
    expect(events.type === "found" && events.messageCount).toBe(2)
    await Bun.write(
      file,
      jsonl([
        response({ type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] }),
        response({ type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] }),
      ]),
    )
    const fallback = await CodexSession.resolve(id, tmp)
    expect(fallback.type === "found" && fallback.messageCount).toBe(2)
  })

  test("deduplicates stable IDs and client IDs, not equal text from distinct turns", async () => {
    await using tmp = await fixture()
    await rollout(tmp.home, [
      event("user_message", "Continue", { client_id: "first" }),
      event("user_message", "Continue", { client_id: "first" }),
      event("user_message", "Continue", { client_id: "second" }),
      item({ type: "UserMessage", id: "u2", client_id: "second", content: [{ type: "Text", text: "Continue" }] }),
      item({ type: "UserMessage", id: "u2", content: [{ type: "Text", text: "Continue" }] }),
      event("agent_message", "Same answer", { id: "a1" }),
      event("agent_message", "Same answer", { id: "a2" }),
    ])
    const result = await CodexSession.resolve(id, tmp)
    expect(result.type === "found" && result.messageCount).toBe(4)
  })

  test("falls back to response messages and strictly filters private roles, phases, and content types", async () => {
    await using tmp = await fixture()
    await rollout(tmp.home, [
      event("agent_reasoning", "PRIVATE_REASONING_EVENT"),
      response({ type: "message", role: "system", content: [{ type: "output_text", text: "PRIVATE_SYSTEM" }] }),
      response({ type: "message", role: "developer", content: [{ type: "input_text", text: "PRIVATE_DEVELOPER" }] }),
      response({ type: "message", role: "tool", content: [{ type: "output_text", text: "PRIVATE_TOOL_ROLE" }] }),
      response({ type: "function_call", arguments: "PRIVATE_TOOL_INPUT" }),
      response({ type: "function_call_output", output: "PRIVATE_TOOL_OUTPUT" }),
      response({ type: "reasoning", summary: [{ type: "summary_text", text: "PRIVATE_REASONING" }] }),
      response({
        type: "message",
        role: "assistant",
        channel: "analysis",
        content: [{ type: "output_text", text: "PRIVATE_CHANNEL" }],
      }),
      response({
        type: "message",
        role: "assistant",
        phase: "Analysis",
        content: [{ type: "output_text", text: "PRIVATE_PHASE" }],
      }),
      response({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "# AGENTS.md instructions for /work\nPRIVATE_AGENTS" }],
      }),
      response({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>PRIVATE_ENV</environment_context>" }],
      }),
      response({
        type: "message",
        role: "user",
        id: "u1",
        content: [
          { type: "input_text", text: "<environment_context>PRIVATE_MIXED_ENV</environment_context>" },
          { type: "input_text", text: "Visible question" },
          { type: "input_image", text: "PRIVATE_IMAGE" },
        ],
      }),
      response({
        type: "message",
        role: "assistant",
        id: "a1",
        content: [{ type: "output_text", text: "Visible answer" }],
      }),
      response({
        type: "message",
        role: "assistant",
        id: "a1",
        content: [{ type: "output_text", text: "Visible answer" }],
      }),
      response({
        type: "message",
        role: "user",
        id: "u2",
        content: [{ type: "input_text", text: "Visible question" }],
      }),
    ])
    const result = await CodexSession.resolve(id, tmp)
    expect(result.type).toBe("found")
    if (result.type !== "found") throw new Error(result.message)
    expect(result.messageCount).toBe(3)
    expect(result.preview).toContain("Visible question")
    expect(result.preview).toContain("Visible answer")
    expect(await Bun.file(result.path).text()).not.toContain("PRIVATE_")
  })

  test("skips malformed lines, values, and partial tails in both JSONL files", async () => {
    await using tmp = await fixture()
    const file = await rollout(tmp.home, [
      null,
      [],
      1,
      { type: "event_msg", payload: null },
      { type: "event_msg", payload: { type: "user_message", message: 4 } },
      item({ type: "UserMessage", content: null }),
      ...messages,
    ])
    await fs.appendFile(path.join(tmp.home, "session_index.jsonl"), '{not JSON}\n{"id":')
    await fs.appendFile(file, '{bad JSON}\n{"type":"event_msg","payload":')
    const result = await CodexSession.resolve(title, tmp)
    expect(result.type).toBe("found")
    expect(result.type === "found" && result.messageCount).toBe(2)
  })

  test("bounds previews while retaining beginning, recent end, and the full filtered cache", async () => {
    await using tmp = await fixture()
    const first = `BEGINNING_VISIBLE\n${"first context ".repeat(2000)}`
    const middle = `MIDDLE_ONLY\n${"middle context ".repeat(2000)}`
    const last = `${"recent context ".repeat(2000)}\nRECENT_END_VISIBLE`
    await rollout(tmp.home, [event("user_message", first), event("agent_message", middle), event("user_message", last)])
    const result = await CodexSession.resolve(id, tmp)
    expect(result.type).toBe("found")
    if (result.type !== "found") throw new Error(result.message)
    expect(result.messageCount).toBe(3)
    expect(result.preview.length).toBeLessThanOrEqual(16_000)
    expect(result.preview).toContain("BEGINNING_VISIBLE")
    expect(result.preview).toContain("RECENT_END_VISIBLE")
    expect(result.preview).toContain("Preview truncated")
    expect(result.preview).toContain(result.path)
    const full = await Bun.file(result.path).text()
    expect(full.replaceAll("\n", "")).toContain(first.replaceAll("\n", ""))
    expect(full.replaceAll("\n", "")).toContain(middle.replaceAll("\n", ""))
    expect(full.replaceAll("\n", "")).toContain(last.replaceAll("\n", ""))
    expect(full.length).toBeGreaterThan(16_000)
  })

  test("wraps long unbroken text without losing characters so middle content is readable in a page", async () => {
    await using tmp = await fixture()
    const text = "a".repeat(10_000) + "MIDDLE_MARKER" + "\u{1F600}".repeat(6_000)
    await rollout(tmp.home, [event("user_message", text)])
    const result = await CodexSession.resolve(id, tmp)
    expect(result.type).toBe("found")
    if (result.type !== "found") throw new Error(result.message)
    const full = await Bun.file(result.path).text()
    const lines = full.split("\n")
    expect(lines.every((line) => line.length <= 1000)).toBe(true)
    expect(full).toContain("Added line breaks are formatting only")
    const index = lines.findIndex((line) => line.includes("MIDDLE_MARKER"))
    expect(index).toBeGreaterThan(0)
    expect(
      lines
        .slice(index, index + 1)
        .map((line) => line.slice(0, 2000))
        .join("\n"),
    ).toContain("MIDDLE_MARKER")
    expect(full.split("## Message 1: User\n\n")[1].replaceAll("\n", "")).toBe(text)
  })

  test("publishes immutable complete cache files concurrently without changing the source", async () => {
    await using tmp = await fixture()
    const file = await rollout(tmp.home)
    const privateFiles = ["auth.json", "config.toml", "state.sqlite"]
    await Promise.all(privateFiles.map((name) => Bun.write(path.join(tmp.home, name), "PRIVATE_SOURCE_UNTOUCHED")))
    const before = await Bun.file(file).text()
    const modified = (await fs.stat(file)).mtimeMs
    const results = await Promise.all(Array.from({ length: 8 }, () => CodexSession.resolve(title, tmp)))
    const paths = results.flatMap((result) => (result.type === "found" ? [result.path] : []))
    expect(paths).toHaveLength(8)
    expect(new Set(paths).size).toBe(1)
    const original = await Bun.file(paths[0]).text()
    expect(original).toContain("machine-7")
    expect(await fs.readdir(tmp.cache)).toEqual([path.basename(paths[0])])
    expect(await Bun.file(file).text()).toBe(before)
    expect((await fs.stat(file)).mtimeMs).toBe(modified)
    expect(await Bun.file(path.join(tmp.home, "session_index.jsonl")).text()).toBe(jsonl([index]))
    for (const name of privateFiles) {
      expect(await Bun.file(path.join(tmp.home, name)).text()).toBe("PRIVATE_SOURCE_UNTOUCHED")
    }
    await fs.appendFile(file, jsonl([event("user_message", "A later visible question")]))
    const changed = await CodexSession.resolve(id, tmp)
    expect(changed.type).toBe("found")
    if (changed.type !== "found") throw new Error(changed.message)
    expect(changed.path).not.toBe(paths[0])
    expect(await Bun.file(paths[0]).text()).toBe(original)
  })

  test("returns actionable results for missing index, missing rollout, and empty visible history", async () => {
    await using tmp = await fixture()
    const absent = await CodexSession.resolve(title, { home: path.join(tmp.path, "absent"), cache: tmp.cache })
    expect(absent.type).toBe("missing")
    if (absent.type === "found") throw new Error("Unexpected transcript")
    expect(absent.message).toContain("CODEX_HOME")
    const noFile = await CodexSession.resolve(id, tmp)
    expect(noFile.type).toBe("missing")
    if (noFile.type === "found") throw new Error("Unexpected transcript")
    expect(noFile.message).toContain("rollout JSONL")
    await rollout(tmp.home, [event("agent_reasoning", "PRIVATE_ONLY")])
    const noMessages = await CodexSession.resolve(id, tmp)
    expect(noMessages.type).toBe("missing")
    if (noMessages.type === "found") throw new Error("Unexpected transcript")
    expect(noMessages.message).toContain("no visible")
    expect((await CodexSession.resolve(" ", tmp)).type).toBe("missing")
  })

  test("rejects unsafe index IDs and raw paths, and ignores arbitrary source paths in index rows", async () => {
    await using tmp = await fixture([
      { ...index, path: "/not/a/rollout.jsonl" },
      ...["../outside", "/outside", "bad/id", "bad\\id", "evil*", "[glob]", ".", ".."].map((id) => ({
        id,
        thread_name: `Unsafe ${id}`,
      })),
    ])
    const external = path.join(tmp.path, "outside.jsonl")
    await Bun.write(external, jsonl([event("user_message", "PRIVATE_OUTSIDE")]))
    await rollout(tmp.home)
    expect((await CodexSession.resolve("Unsafe", tmp)).type).toBe("missing")
    expect((await CodexSession.resolve(external, tmp)).type).toBe("missing")
    const result = await CodexSession.resolve(title, tmp)
    expect(result.type).toBe("found")
    if (result.type !== "found") throw new Error(result.message)
    expect(result.preview).not.toContain("PRIVATE_OUTSIDE")
    expect(await Bun.file(external).text()).toContain("PRIVATE_OUTSIDE")
  })

  test("does not follow rollout or nested directory symlinks outside the session root", async () => {
    await using tmp = await fixture()
    const external = await rollout(tmp.path, [event("user_message", "PRIVATE_SYMLINK")])
    const file = await rollout(tmp.home)
    await fs.unlink(file)
    await fs.symlink(external, file)
    const linkedFile = await CodexSession.resolve(id, tmp)
    expect(linkedFile.type).not.toBe("found")
    await fs.unlink(file)
    await fs.symlink(path.dirname(external), path.join(path.dirname(file), "linked"), "dir")
    expect((await CodexSession.resolve(id, tmp)).type).not.toBe("found")
    expect(await Bun.file(tmp.cache).exists()).toBe(false)
  })

  test("keeps Codex read-only even if the requested cache resolves through a symlink into home", async () => {
    await using tmp = await fixture()
    await rollout(tmp.home)
    const direct = await CodexSession.resolve(id, { ...tmp, cache: path.join(tmp.home, "cache") })
    expect(direct.type).toBe("error")
    await fs.symlink(tmp.home, tmp.cache, "dir")
    const linked = await CodexSession.resolve(id, { ...tmp, cache: path.join(tmp.cache, "new-cache") })
    expect(linked.type).toBe("error")
    expect(await fs.readdir(tmp.home)).toEqual(["session_index.jsonl", "sessions"])
  })

  test("reports cache failures and mismatched rollout metadata without throwing", async () => {
    await using tmp = await fixture()
    const file = await rollout(tmp.home)
    await Bun.write(tmp.cache, "do not replace")
    const failed = await CodexSession.resolve(id, tmp)
    expect(failed.type).toBe("error")
    expect(await Bun.file(tmp.cache).text()).toBe("do not replace")
    await Bun.write(file, jsonl([{ type: "session_meta", payload: { id: other } }, ...messages.slice(1)]))
    const mismatch = await CodexSession.resolve(id, tmp)
    expect(mismatch.type).toBe("error")
    if (mismatch.type === "found") throw new Error("Unexpected transcript")
    expect(mismatch.message).toContain("metadata does not match")
  })

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "handles unreadable index and rollout files",
    async () => {
      await using tmp = await fixture()
      const file = await rollout(tmp.home)
      const indexFile = path.join(tmp.home, "session_index.jsonl")
      await fs.chmod(indexFile, 0)
      expect((await CodexSession.resolve(id, tmp)).type).toBe("error")
      await fs.chmod(indexFile, 0o600)
      await fs.chmod(file, 0)
      expect((await CodexSession.resolve(id, tmp)).type).toBe("error")
    },
  )
})
