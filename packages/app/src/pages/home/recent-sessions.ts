import type { GlobalSession, OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"

export async function loadRecentSessions(client: OpencodeClient, cursor?: number, signal?: AbortSignal) {
  const result = await client.experimental.session.list(
    { roots: true, limit: 20, cursor },
    { throwOnError: true, signal },
  )
  const next = result.response.headers.get("x-next-cursor")
  return {
    sessions: result.data,
    cursor: next !== null && next.trim() !== "" && Number.isFinite(Number(next)) ? Number(next) : undefined,
  }
}

export function mergeRecentSessions(pages: { sessions: GlobalSession[] }[]) {
  return [...new Map(pages.flatMap((page) => page.sessions).map((session) => [session.id, session])).values()]
}

export function recentSessionTarget(session: GlobalSession) {
  return {
    directory: session.project && session.project.id !== "global" ? session.project.worktree : session.directory,
    href: `/${base64Encode(session.directory)}/session/${session.id}`,
  }
}
