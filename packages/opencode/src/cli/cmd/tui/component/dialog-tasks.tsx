import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { useLocal } from "@tui/context/local"
import { createMemo, onMount } from "solid-js"
import { Locale } from "@/util/locale"
import { Spinner } from "./spinner"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"

const SUBAGENT_TITLE = /\(@([\w-]+) (subagent|fork)\)\s*$/

export function DialogTasks() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const local = useLocal()

  function tokensFor(sessionID: string) {
    const last = (sync.data.message[sessionID] ?? []).findLast(
      (x): x is AssistantMessage => x.role === "assistant" && x.tokens.output > 0,
    )
    if (!last) return 0
    return last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
  }

  function isRunning(sessionID: string) {
    const status = sync.data.session_status?.[sessionID]
    return status?.type === "busy" || status?.type === "retry"
  }

  const options = createMemo(() => {
    const subagents = sync.data.session
      .filter((x) => x.parentID !== undefined)
      .toSorted((a, b) => {
        const ra = isRunning(a.id) ? 0 : 1
        const rb = isRunning(b.id) ? 0 : 1
        if (ra !== rb) return ra - rb
        return b.time.updated - a.time.updated
      })
      .slice(0, 50)

    return subagents.map((s) => {
      const match = s.title.match(SUBAGENT_TITLE)
      const agent = match?.[1]
      const kind = match?.[2]
      const description = match ? s.title.slice(0, match.index).trim() : s.title
      const running = isRunning(s.id)
      const color = local.agent.color(agent ?? "")

      const meta = [
        agent ? Locale.titlecase(agent) : undefined,
        kind === "fork" ? "fork" : undefined,
        tokensFor(s.id) > 0 ? `${Locale.number(tokensFor(s.id))} tokens` : undefined,
        Locale.time(s.time.updated),
      ].filter(Boolean)

      return {
        title: description || s.title,
        value: s.id,
        category: running ? "Running" : "Done",
        gutter: running ? () => <Spinner /> : () => <text fg={color}>│</text>,
        footer: meta.join(" · "),
      }
    })
  })

  onMount(() => dialog.setSize("large"))

  return (
    <DialogSelect
      title="Tasks"
      options={options()}
      onSelect={(option) => {
        route.navigate({ type: "session", sessionID: option.value })
        dialog.clear()
      }}
      actions={[
        {
          command: "subagent.stop",
          title: "stop",
          onTrigger: (option) => {
            void sdk.client.session.abort({ sessionID: option.value }).catch(() => {})
          },
        },
      ]}
    />
  )
}
