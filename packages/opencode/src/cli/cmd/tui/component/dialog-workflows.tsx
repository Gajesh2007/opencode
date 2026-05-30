import { createMemo, onMount } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useSDK } from "@tui/context/sdk"
import { Spinner } from "./spinner"
import type { ToolPart } from "@opencode-ai/sdk/v2"

export function DialogWorkflows() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const { theme } = useTheme()
  const sdk = useSDK()

  const workflows = createMemo(() => {
    const out: { part: ToolPart; sessionID: string }[] = []
    for (const [sessionID, msgs] of Object.entries(sync.data.message)) {
      for (const msg of msgs) {
        for (const part of sync.data.part[msg.id] ?? []) {
          if (part.type === "tool" && part.tool === "workflow") out.push({ part, sessionID })
        }
      }
    }
    const updatedAt = (id: string) => sync.data.session.find((s) => s.id === id)?.time.updated ?? 0
    return out.toSorted((a, b) => updatedAt(b.sessionID) - updatedAt(a.sessionID))
  })

  const options = createMemo(() =>
    workflows().map(({ part, sessionID }) => {
      const status = part.state.status
      const input = (part.state.input ?? {}) as { description?: string }
      const m = (status === "pending" ? {} : (part.state.metadata ?? {})) as {
        cells?: number
        completed?: number
        failed?: number
        findings?: number
      }
      const cells = m.cells ?? 0
      const done = m.completed ?? 0
      const footer = [
        `${done}/${cells} cells`,
        cells ? `${Math.round((done / cells) * 100)}%` : undefined,
        (m.findings ?? 0) > 0 ? `${m.findings} findings` : undefined,
        (m.failed ?? 0) > 0 ? `${m.failed} failed` : undefined,
      ]
        .filter(Boolean)
        .join(" · ")
      return {
        value: sessionID,
        title: input.description || "fan-out",
        gutter:
          status === "running"
            ? () => <Spinner color={theme.accent} />
            : status === "error"
              ? () => <text fg={theme.error}>✗</text>
              : () => <text fg={theme.success}>✓</text>,
        footer,
      }
    }),
  )

  onMount(() => dialog.setSize("large"))

  return (
    <DialogSelect
      title="Workflows"
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
