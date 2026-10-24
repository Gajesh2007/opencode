import type { ShellProcess } from "@opencode-ai/sdk/v2"
import { Locale } from "@/util/locale"

type Tone = "info" | "warning" | "error"

type ShellState = {
  status: ShellProcess["status"]
  exit?: number
  signal?: string
}

export type BackgroundNotice = {
  tone: Tone
  label: string
  detail?: string
  shellID?: string
  sessionID?: string
}

/** Short outcome of a shell command, e.g. "exit 1" or "timed out". */
export function shellResult(shell: ShellState) {
  if (shell.status === "running") return "running"
  if (shell.status === "timeout") return "timed out"
  if (shell.status === "killed") return "killed"
  if (shell.exit !== undefined) return `exit ${shell.exit}`
  return shell.signal ?? "exited"
}

/** Theme color for a shell command's outcome. */
export function shellTone(shell: ShellState): Tone {
  if (shell.status === "timeout" || shell.status === "killed") return "warning"
  if (shell.status === "exited" && (shell.exit || shell.signal)) return "error"
  return "info"
}

/**
 * Reads the completion notice that background work posts to its session as a synthetic text part. Returns undefined
 * for any other synthetic text, which stays hidden.
 */
export function backgroundNotice(metadata: Record<string, unknown> | undefined): BackgroundNotice | undefined {
  if (metadata?.source === "shell") {
    const shell: ShellState = {
      status: metadata.state === "timeout" || metadata.state === "killed" ? metadata.state : "exited",
      exit: typeof metadata.exit === "number" ? metadata.exit : undefined,
      signal: typeof metadata.signal === "string" ? metadata.signal : undefined,
    }
    const tone = shellTone(shell)
    const actor = metadata.user === true ? "User shell" : "Shell"
    const outcome = shell.status === "exited" ? `failed (${shellResult(shell)})` : shellResult(shell)
    return {
      tone,
      label: tone === "info" ? `↳ ${actor} finished` : `! ${actor} ${outcome}`,
      detail: [metadata.description, metadata.command]
        .find((item): item is string => typeof item === "string" && item.trim() !== "")
        ?.replace(/\s+/g, " ")
        .trim(),
      shellID: typeof metadata.shellID === "string" ? metadata.shellID : undefined,
    }
  }
  if (metadata?.source !== "subagent") return
  const agent = Locale.titlecase(typeof metadata.agent === "string" && metadata.agent ? metadata.agent : "subagent")
  const state = typeof metadata.state === "string" ? metadata.state : "completed"
  const tone: Tone = state === "completed" ? "info" : state === "error" ? "error" : "warning"
  const outcome = state === "completed" ? "finished" : state === "error" ? "failed" : state
  return {
    tone,
    label: `${tone === "info" ? "↳" : "!"} ${agent} ${outcome}`,
    detail: typeof metadata.description === "string" ? metadata.description : undefined,
    sessionID: typeof metadata.sessionID === "string" ? metadata.sessionID : undefined,
  }
}
