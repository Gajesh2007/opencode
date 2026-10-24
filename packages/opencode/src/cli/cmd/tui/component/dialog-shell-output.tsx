import type { ScrollBoxRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import type { ShellProcess } from "@opencode-ai/sdk/v2"
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import stripAnsi from "strip-ansi"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useTuiConfig } from "../context/tui-config"
import { useBindings, useCommandShortcut } from "../keymap"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { shellTone } from "../util/background"

// The viewer starts at, and keeps, only the most recent output.
const PAGE_BYTES = 64 * 1024

export function DialogShellOutput(props: { shellID: string; command?: string; onBack?: () => void }) {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const renderer = useRenderer()
  const tuiConfig = useTuiConfig()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const killShortcut = useCommandShortcut("shell.kill")
  const [fetched, setFetched] = createSignal<ShellProcess>()
  // Polls cover events missed while the event stream reconnects. A command only ever moves from running to a
  // final status, so whichever source has seen the exit is current.
  const info = () => {
    const stored = sync.shell.get(props.shellID)
    return stored?.status === "running" ? (fetched() ?? stored) : (stored ?? fetched())
  }
  const running = () => info()?.status === "running"
  const [output, setOutput] = createSignal<string>()
  const [omitted, setOmitted] = createSignal(false)
  const [problem, setProblem] = createSignal<"missing" | "failed">()
  const text = createMemo(() =>
    stripAnsi(output() ?? "")
      .replace(/\r\n?/g, "\n")
      .trimEnd(),
  )
  const statusColor = createMemo(() => {
    const current = info()
    return !current || current.status === "running" ? theme.textMuted : theme[shellTone(current)]
  })
  const height = createMemo(() => Math.max(3, Math.floor(dimensions().height * 0.75) - 14))
  let scroll: ScrollBoxRenderable | undefined

  onMount(() => dialog.setSize("xlarge"))

  onMount(() => {
    let cursor: number | undefined
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    onCleanup(() => {
      disposed = true
      clearTimeout(timer)
    })

    // A client error means the command is unknown (evicted, or the server restarted); retrying won't help.
    const failure = (response: Response | undefined) =>
      response && response.status >= 400 && response.status < 500 ? "missing" : "failed"

    async function read() {
      if ((info()?.status ?? "running") === "running") {
        const current = await sdk.client.shell.get({ shellID: props.shellID })
        if (!current.data) return failure(current.response)
        setFetched(current.data)
      }
      // A command reports its exit only after its output is fully captured, so this size is final.
      const final = info()?.status !== "running"
      if (cursor === undefined) {
        const head = await sdk.client.shell.output({ shellID: props.shellID, cursor: String(Number.MAX_SAFE_INTEGER) })
        if (!head.data) return failure(head.response)
        cursor = Math.max(0, head.data.size - PAGE_BYTES)
        setOmitted(cursor > 0)
      }
      const start = cursor
      const page = await sdk.client.shell.output({
        shellID: props.shellID,
        cursor: String(start),
        limit: String(PAGE_BYTES),
      })
      if (!page.data) return failure(page.response)
      cursor = page.data.cursor
      const next = (output() ?? "") + page.data.output
      if (next.length > PAGE_BYTES) setOmitted(true)
      setOutput(next.slice(-PAGE_BYTES))
      setProblem(undefined)
      // A page cut before an incomplete trailing character makes no progress until more output arrives.
      if (cursor < page.data.size && cursor > start) return "more"
      if (final && cursor >= page.data.size) return "done"
      return "wait"
    }

    // Reads never overlap: the next one is scheduled only after the previous finished.
    function poll() {
      void read()
        .catch(() => "failed" as const)
        .then((state) => {
          if (disposed) return
          if (state === "missing" || state === "failed") setProblem(state)
          if (state === "missing" || state === "done") return
          timer = setTimeout(poll, state === "more" ? 0 : 1000)
        })
    }
    poll()
  })

  function kill() {
    if (!running()) return
    void sdk.client.shell.kill({ shellID: props.shellID }).then((result) => {
      if (!result.data) {
        toast.show({ message: "Failed to kill shell command", variant: "error" })
        return
      }
      setFetched(result.data)
    })
  }

  function close() {
    if (props.onBack) {
      props.onBack()
      return
    }
    dialog.clear()
  }

  useBindings(() => ({
    // Outranks the dialog's own escape so esc can return to the list this was opened from.
    priority: 1,
    commands: [{ name: "shell.kill", title: "Kill shell command", category: "Dialog", run: kill }],
    bindings: [
      { key: "up", desc: "Scroll output up", group: "Shell", cmd: () => scroll?.scrollBy(-1) },
      { key: "down", desc: "Scroll output down", group: "Shell", cmd: () => scroll?.scrollBy(1) },
      { key: "pageup", desc: "Scroll output up one page", group: "Shell", cmd: () => scroll?.scrollBy(-height()) },
      { key: "pagedown", desc: "Scroll output down one page", group: "Shell", cmd: () => scroll?.scrollBy(height()) },
      { key: "home", desc: "Scroll to the first loaded output", group: "Shell", cmd: () => scroll?.scrollTo(0) },
      {
        key: "end",
        desc: "Follow shell output",
        group: "Shell",
        cmd: () => {
          if (scroll) scroll.scrollTo(scroll.scrollHeight)
        },
      },
      ...(running() ? tuiConfig.keybinds.get("shell.kill") : []),
      ...(props.onBack
        ? [
            {
              key: "escape",
              desc: "Back",
              group: "Dialog",
              cmd: () => {
                if (renderer.getSelection()) renderer.clearSelection()
                close()
              },
            },
          ]
        : []),
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <text fg={theme.text} wrapMode="none">
          <span style={{ fg: theme.text, bold: true }}>Shell output</span>
          <span style={{ fg: statusColor() }}> {statusLabel(info())}</span>
          <Show when={info()?.background}>
            <span style={{ fg: theme.textMuted }}> · background</span>
          </Show>
        </text>
        <text fg={theme.textMuted} onMouseUp={close}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted} maxHeight={3} wrapMode="word">
        $ {info()?.command ?? props.command ?? ""}
      </text>
      <Show when={omitted()}>
        <text fg={theme.textMuted}>Earlier output omitted · showing recent output</text>
      </Show>
      <scrollbox
        ref={(value: ScrollBoxRenderable) => (scroll = value)}
        height={height()}
        stickyScroll={true}
        stickyStart="bottom"
        scrollbarOptions={{ visible: false }}
      >
        <text fg={text() ? theme.text : theme.textMuted} wrapMode="word">
          {text() || (output() !== undefined ? "No output captured." : problem() ? "" : "Loading output…")}
        </text>
      </scrollbox>
      <Show when={problem()}>
        {(value) => (
          <text fg={theme.error}>
            {value() === "missing" ? "Shell output is no longer available." : "Unable to read shell output. Retrying…"}
          </text>
        )}
      </Show>
      <box flexDirection="row" gap={2}>
        <text>
          <span style={{ fg: theme.text, bold: true }}>scroll </span>
          <span style={{ fg: theme.textMuted }}>↑↓</span>
        </text>
        <text>
          <span style={{ fg: theme.text, bold: true }}>follow </span>
          <span style={{ fg: theme.textMuted }}>end</span>
        </text>
        <Show when={running() && killShortcut()}>
          <text>
            <span style={{ fg: theme.text, bold: true }}>kill </span>
            <span style={{ fg: theme.textMuted }}>{killShortcut()}</span>
          </text>
        </Show>
        <text>
          <span style={{ fg: theme.text, bold: true }}>{props.onBack ? "back " : "close "}</span>
          <span style={{ fg: theme.textMuted }}>esc</span>
        </text>
      </box>
    </box>
  )
}

function statusLabel(info: ShellProcess | undefined) {
  if (!info) return ""
  if (info.status === "running") return "Running"
  if (info.status === "timeout") return "Timed out"
  if (info.status === "killed") return "Killed"
  if (info.exit !== undefined) return `Exited · code ${info.exit}`
  if (info.signal) return `Exited · ${info.signal}`
  return "Exited"
}
