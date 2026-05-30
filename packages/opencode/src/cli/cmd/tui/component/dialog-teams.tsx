import { createMemo, createSignal, onMount, type JSX } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useSDK } from "@tui/context/sdk"
import { useLocal } from "@tui/context/local"
import { Locale } from "@/util/locale"
import { Spinner } from "./spinner"
import type { AssistantMessage, ToolPart } from "@opencode-ai/sdk/v2"

type Member = { team: string; name: string; sessionID: string; lead: boolean }

export function DialogTeams() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const local = useLocal()
  const { theme } = useTheme()
  const [tab, setTab] = createSignal<"roster" | "tasks">("roster")

  const toolParts = createMemo(() => {
    const out: { part: ToolPart; time: number }[] = []
    for (const msgs of Object.values(sync.data.message)) {
      for (const msg of msgs) {
        for (const part of sync.data.part[msg.id] ?? []) {
          if (part.type === "tool") out.push({ part, time: msg.time.created })
        }
      }
    }
    return out
  })

  const members = createMemo(() => {
    const map = new Map<string, Member>()
    for (const { part } of toolParts()) {
      if (part.tool !== "task") continue
      const input = (part.state.input ?? {}) as { team?: string; name?: string; subagent_type?: string }
      if (!input.team) continue
      const meta = (part.state.status === "pending" ? {} : (part.state.metadata ?? {})) as {
        sessionId?: string
        parentSessionId?: string
      }
      if (meta.parentSessionId) {
        const key = `${input.team}|${meta.parentSessionId}`
        if (!map.has(key)) map.set(key, { team: input.team, name: "lead", sessionID: meta.parentSessionId, lead: true })
      }
      if (meta.sessionId) {
        map.set(`${input.team}|${meta.sessionId}`, {
          team: input.team,
          name: input.name ?? input.subagent_type ?? "teammate",
          sessionID: meta.sessionId,
          lead: false,
        })
      }
    }
    return [...map.values()].toSorted((a, b) =>
      a.team !== b.team ? (a.team < b.team ? -1 : 1) : a.lead === b.lead ? 0 : a.lead ? -1 : 1,
    )
  })

  onMount(() => {
    dialog.setSize("large")
    for (const m of members()) {
      if (!sync.data.message[m.sessionID]?.length) void sync.session.sync(m.sessionID)
    }
  })

  function isRunning(id: string) {
    const s = sync.data.session_status?.[id]
    return s?.type === "busy" || s?.type === "retry"
  }

  function tokensFor(id: string) {
    const last = (sync.data.message[id] ?? []).findLast(
      (x): x is AssistantMessage => x.role === "assistant" && x.tokens.output > 0,
    )
    if (!last) return 0
    return last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
  }

  const rosterOptions = createMemo(() =>
    members().map((m) => {
      const running = isRunning(m.sessionID)
      const color = local.agent.color(m.name)
      const tk = tokensFor(m.sessionID)
      return {
        value: m.sessionID,
        title: m.lead ? `${m.name} (lead)` : m.name,
        category: m.team,
        gutter: running
          ? () => <Spinner color={color} />
          : () => <text fg={color}>{m.lead ? "★" : "│"}</text>,
        footer: [running ? "running" : "idle", tk > 0 ? `${Locale.number(tk)} tokens` : undefined]
          .filter(Boolean)
          .join(" · "),
      }
    }),
  )

  const taskOptions = createMemo(() => {
    type Reconstructed = { id: string; title: string; status: string; team: string; assignee?: string; order: number }
    const tasks = new Map<string, Reconstructed>()
    let order = 0
    const events = toolParts()
      .filter(({ part }) => part.tool === "team_tasks")
      .toSorted((a, b) => a.time - b.time)
    for (const { part } of events) {
      const input = (part.state.input ?? {}) as { action?: string; title?: string; status?: string; assignee?: string }
      const meta = (part.state.status === "pending" ? {} : (part.state.metadata ?? {})) as { team?: string; id?: string }
      if (!meta.id || !meta.team) continue
      if (input.action === "create") {
        tasks.set(meta.id, {
          id: meta.id,
          title: input.title ?? "(untitled)",
          status: input.status ?? "pending",
          team: meta.team,
          assignee: input.assignee,
          order: order++,
        })
        continue
      }
      const existing = tasks.get(meta.id)
      if (!existing) continue
      if (input.status) existing.status = input.status
      if (input.assignee) existing.assignee = input.assignee
    }
    return [...tasks.values()]
      .toSorted((a, b) => (a.team !== b.team ? (a.team < b.team ? -1 : 1) : a.order - b.order))
      .map((t) => ({
        value: t.id,
        title: t.title,
        category: t.team,
        gutter: () => statusGutter(t.status),
        footer: [t.status, t.assignee ? `@${t.assignee}` : undefined].filter(Boolean).join(" · "),
      }))
  })

  function statusGutter(status: string): JSX.Element {
    if (status === "done") return <text fg={theme.success}>✓</text>
    if (status === "in_progress") return <Spinner color={theme.accent} />
    if (status === "blocked") return <text fg={theme.error}>✗</text>
    return <text fg={theme.textMuted}>∙</text>
  }

  function TabBar() {
    const style = (active: boolean) => ({
      fg: active ? theme.accent : theme.textMuted,
      attributes: active ? TextAttributes.BOLD : undefined,
    })
    const teams = new Set(members().map((m) => m.team)).size
    return (
      <box flexDirection="row" gap={2}>
        <text {...style(tab() === "roster")}>Roster ({members().length})</text>
        <text {...style(tab() === "tasks")}>Tasks ({taskOptions().length})</text>
        <text fg={theme.textMuted}>
          · {teams} team{teams === 1 ? "" : "s"} · tab to switch
        </text>
      </box>
    )
  }

  return (
    <DialogSelect
      title="Teams"
      header={<TabBar />}
      options={tab() === "roster" ? rosterOptions() : taskOptions()}
      bindings={[
        {
          key: "tab",
          desc: "Switch tab",
          group: "Dialog",
          cmd: () => {
            setTab((t) => (t === "roster" ? "tasks" : "roster"))
          },
        },
      ]}
      onSelect={(option) => {
        if (tab() !== "roster") return
        route.navigate({ type: "session", sessionID: option.value })
        dialog.clear()
      }}
      actions={
        tab() === "roster"
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
