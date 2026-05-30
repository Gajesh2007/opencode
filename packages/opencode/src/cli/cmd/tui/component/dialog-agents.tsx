import { createMemo, createSignal, onMount } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { Locale } from "@/util/locale"
import { Spinner } from "./spinner"

const SUBAGENT_TITLE = /\(@([\w-]+) (subagent|fork)\)\s*$/

export function DialogAgents() {
  const local = useLocal()
  const sync = useSync()
  const route = useRoute()
  const sdk = useSDK()
  const { theme } = useTheme()
  const dialog = useDialog()
  const [tab, setTab] = createSignal<"running" | "library">("running")

  const running = createMemo(() =>
    sync.data.session
      .filter((x) => {
        if (x.parentID === undefined) return false
        const status = sync.data.session_status?.[x.id]
        return status?.type === "busy" || status?.type === "retry"
      })
      .toSorted((a, b) => b.time.updated - a.time.updated),
  )

  onMount(() => {
    dialog.setSize("large")
    if (running().length === 0) setTab("library")
  })

  const runningOptions = createMemo(() =>
    running().map((s) => {
      const match = s.title.match(SUBAGENT_TITLE)
      const agent = match?.[1]
      const description = match ? s.title.slice(0, match.index).trim() : s.title
      const color = local.agent.color(agent ?? "")
      return {
        value: s.id,
        title: description || s.title,
        gutter: () => <Spinner color={color} />,
        footer: [agent ? Locale.titlecase(agent) : undefined, Locale.time(s.time.updated)].filter(Boolean).join(" · "),
      }
    }),
  )

  const libraryOptions = createMemo(() =>
    local.agent.list().map((item) => ({
      value: item.name,
      title: item.name,
      description: item.native ? "native" : item.description,
      gutter: () => <text fg={local.agent.color(item.name)}>│</text>,
    })),
  )

  function TabBar() {
    const style = (active: boolean) => ({
      fg: active ? theme.accent : theme.textMuted,
      attributes: active ? TextAttributes.BOLD : undefined,
    })
    return (
      <box flexDirection="row" gap={2}>
        <text {...style(tab() === "running")}>Running ({running().length})</text>
        <text {...style(tab() === "library")}>Library ({local.agent.list().length})</text>
        <text fg={theme.textMuted}>· tab to switch</text>
      </box>
    )
  }

  return (
    <DialogSelect
      title="Agents"
      header={<TabBar />}
      current={tab() === "library" ? local.agent.current()?.name : undefined}
      options={tab() === "running" ? runningOptions() : libraryOptions()}
      bindings={[
        {
          key: "tab",
          desc: "Switch tab",
          group: "Dialog",
          cmd: () => {
            setTab((t) => (t === "running" ? "library" : "running"))
          },
        },
      ]}
      onSelect={(option) => {
        if (tab() === "library") {
          local.agent.set(option.value)
          dialog.clear()
          return
        }
        route.navigate({ type: "session", sessionID: option.value })
        dialog.clear()
      }}
      actions={
        tab() === "running"
          ? [
              {
                command: "subagent.stop",
                title: "stop",
                onTrigger: (option) => {
                  void sdk.client.session.abort({ sessionID: option.value }).catch(() => {})
                },
              },
            ]
          : []
      }
    />
  )
}
