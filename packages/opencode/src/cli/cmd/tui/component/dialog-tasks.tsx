import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { useLocal } from "@tui/context/local"
import { useTheme } from "@tui/context/theme"
import { useToast } from "@tui/ui/toast"
import { createMemo, onMount } from "solid-js"
import { Locale } from "@/util/locale"
import { Spinner } from "./spinner"
import { backgroundEntries } from "./task-entries"
import { DialogShellOutput } from "./dialog-shell-output"
import { shellResult, shellTone } from "../util/background"
import type { AssistantMessage, ShellProcess } from "@opencode-ai/sdk/v2"

const SUBAGENT_TITLE = /\(@([\w-]+) (subagent|fork)\)\s*$/

type Value = { type: "shell" | "subagent"; id: string }

export function DialogTasks() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const local = useLocal()
  const toast = useToast()
  const { theme } = useTheme()

  function tokensFor(sessionID: string) {
    const last = (sync.data.message[sessionID] ?? []).findLast(
      (x): x is AssistantMessage => x.role === "assistant" && x.tokens.output > 0,
    )
    if (!last) return 0
    return (
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    )
  }

  function shellOption(shell: ShellProcess, category: string): DialogSelectOption<Value> {
    const running = shell.status === "running"
    const meta = [
      shell.source === "user" ? "user shell" : "shell",
      running ? (shell.background ? "background" : undefined) : shellResult(shell),
      Locale.time(shell.time.completed ?? shell.time.started),
    ].filter(Boolean)
    return {
      title: shell.description || shell.command.split("\n", 1)[0],
      value: { type: "shell", id: shell.id },
      category,
      gutter: running ? () => <Spinner /> : () => <text fg={theme[shellTone(shell)]}>$</text>,
      footer: meta.join(" · "),
    }
  }

  const entries = createMemo(() =>
    backgroundEntries(sync.data, route.data.type === "session" ? route.data.sessionID : undefined),
  )

  const options = createMemo(() =>
    entries().map((entry): DialogSelectOption<Value> => {
      if (entry.type === "shell") return shellOption(entry.shell, entry.category)
      const s = entry.session
      const match = s.title.match(SUBAGENT_TITLE)
      const agent = match?.[1]
      const kind = match?.[2]
      const description = match ? s.title.slice(0, match.index).trim() : s.title
      const running = entry.category === "Running"
      const color = local.agent.color(agent ?? "")

      const meta = [
        agent ? Locale.titlecase(agent) : undefined,
        kind === "fork" ? "fork" : undefined,
        entry.background ? "background" : undefined,
        tokensFor(s.id) > 0 ? `${Locale.number(tokensFor(s.id))} tokens` : undefined,
        Locale.time(s.time.updated),
      ].filter(Boolean)

      return {
        title: description || s.title,
        value: { type: "subagent", id: s.id },
        category: entry.category,
        gutter: running ? () => <Spinner /> : () => <text fg={color}>│</text>,
        footer: meta.join(" · "),
      }
    }),
  )

  const runningShells = createMemo(() =>
    entries().some((entry) => entry.type === "shell" && entry.shell.status === "running"),
  )
  const subagents = createMemo(() => entries().some((entry) => entry.type === "subagent"))

  onMount(() => dialog.setSize("large"))

  return (
    <DialogSelect
      title="Tasks"
      options={options()}
      onSelect={(option) => {
        if (option.value.type === "shell") {
          dialog.replace(() => (
            <DialogShellOutput
              shellID={option.value.id}
              command={sync.shell.get(option.value.id)?.command}
              onBack={() => dialog.replace(() => <DialogTasks />)}
            />
          ))
          return
        }
        route.navigate({ type: "session", sessionID: option.value.id })
        dialog.clear()
      }}
      actions={[
        {
          command: "subagent.stop",
          title: "stop",
          disabled: !subagents(),
          onTrigger: (option) => {
            if (option.value.type !== "subagent") return
            void sdk.client.session.abort({ sessionID: option.value.id }).catch(() => {})
          },
        },
        {
          command: "shell.kill",
          title: "kill",
          disabled: !runningShells(),
          onTrigger: (option) => {
            if (option.value.type !== "shell" || sync.shell.get(option.value.id)?.status !== "running") return
            void sdk.client.shell.kill({ shellID: option.value.id }).then((result) => {
              if (!result.data) toast.show({ message: "Failed to kill shell command", variant: "error" })
            })
          },
        },
      ]}
    />
  )
}
