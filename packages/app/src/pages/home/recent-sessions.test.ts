import { describe, expect, test } from "bun:test"
import type { GlobalSession } from "@opencode-ai/sdk/v2/client"
import { createClient } from "@opencode-ai/sdk/v2/gen/client"
import { OpencodeClient } from "@opencode-ai/sdk/v2"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { loadRecentSessions, mergeRecentSessions, recentSessionTarget } from "./recent-sessions"

// Other app tests replace the public SDK factory; exercise the real generated API here.
const createOpencodeClient = (config: Parameters<typeof createClient>[0]) =>
  new OpencodeClient({ client: createClient(config) })

function session(input: Partial<GlobalSession> = {}): GlobalSession {
  return {
    id: "ses_saved",
    slug: "saved-chat",
    projectID: "project_git",
    directory: "/Users/mac/worktree",
    title: "Saved chat",
    version: "1",
    time: { created: 1, updated: 2 },
    project: { id: "project_git", worktree: "/Users/mac/project" },
    ...input,
  }
}

describe("global recent sessions", () => {
  test("loads saved root chats across folders without a directory or local project history", async () => {
    const sessions = [session(), session({ id: "ses_other", directory: "/Users/mac/other" })]
    const requests: Request[] = []
    const client = createOpencodeClient({
      baseUrl: "http://mac.test",
      fetch: (async (request: Request) => {
        requests.push(request)
        return Response.json(sessions, { headers: { "x-next-cursor": "123" } })
      }) as typeof fetch,
    })

    expect(await loadRecentSessions(client)).toEqual({ sessions, cursor: 123 })
    const url = new URL(requests[0].url)
    expect(url.pathname).toBe("/experimental/session")
    expect(Object.fromEntries(url.searchParams)).toEqual({ roots: "true", limit: "20" })
    expect(requests[0].headers.has("x-opencode-directory")).toBe(false)
    expect(requests[0].method).toBe("GET")
  })

  test("uses the returned cursor for paging and starts fresh when refreshed", async () => {
    const requests: URL[] = []
    const client = createOpencodeClient({
      baseUrl: "http://mac.test",
      fetch: (async (request: Request) => {
        const url = new URL(request.url)
        requests.push(url)
        return url.searchParams.has("cursor")
          ? Response.json([session({ id: "ses_older" })])
          : Response.json([session()], { headers: { "x-next-cursor": "123" } })
      }) as typeof fetch,
    })

    const first = await loadRecentSessions(client)
    const next = await loadRecentSessions(client, first.cursor)
    expect(next.cursor).toBeUndefined()
    expect(mergeRecentSessions([first, next]).map((item) => item.id)).toEqual(["ses_saved", "ses_older"])
    expect(requests[1].searchParams.get("cursor")).toBe("123")
    expect(await loadRecentSessions(client)).toEqual(first)
    expect(requests[2].searchParams.has("cursor")).toBe(false)
  })

  test("handles empty results and ignores invalid pagination headers", async () => {
    for (const cursor of ["", "invalid", "Infinity"]) {
      const client = createOpencodeClient({
        baseUrl: "http://mac.test",
        fetch: (async (_request: Request) =>
          Response.json([], { headers: { "x-next-cursor": cursor } })) as typeof fetch,
      })
      expect(await loadRecentSessions(client)).toEqual({ sessions: [], cursor: undefined })
    }
  })

  test("propagates request errors instead of treating them as empty results", async () => {
    const client = createOpencodeClient({
      baseUrl: "http://mac.test",
      fetch: (async (_request: Request) =>
        Response.json({ name: "UnknownError", data: { message: "offline" } }, { status: 500 })) as typeof fetch,
    })
    await expect(loadRecentSessions(client)).rejects.toBeDefined()
  })

  test("deduplicates overlapping pages without losing session order", () => {
    const updated = session({ title: "Updated title" })
    expect(
      mergeRecentSessions([{ sessions: [session()] }, { sessions: [updated, session({ id: "ses_older" })] }]),
    ).toEqual([updated, session({ id: "ses_older" })])
  })

  test("registers the project root but navigates to the exact session directory", () => {
    const saved = session({ directory: "/Users/mac/work tree/\u65e5\u672c\u8a9e" })
    expect(recentSessionTarget(saved)).toEqual({
      directory: "/Users/mac/project",
      href: `/${base64Encode(saved.directory)}/session/ses_saved`,
    })
  })

  test("registers the actual directory for global and missing project metadata", () => {
    for (const project of [{ id: "global", worktree: "/" }, null]) {
      const saved = session({ projectID: "global", project })
      expect(recentSessionTarget(saved)).toEqual({
        directory: saved.directory,
        href: `/${base64Encode(saved.directory)}/session/ses_saved`,
      })
    }
  })
})
