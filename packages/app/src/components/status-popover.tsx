import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/components/icon-button-v2.jsx"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/components/icon.jsx"
import { Popover } from "@opencode-ai/ui/popover"
import { Suspense, createMemo, createSignal, lazy, Show, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"

const DirectoryBody = lazy(() => import("./status-popover-body").then((x) => ({ default: x.StatusPopoverBody })))
const ServerBody = lazy(() => import("./status-popover-body").then((x) => ({ default: x.StatusPopoverServerBody })))

export function StatusPopover(props: { variant?: "v2"; scope?: "server" }) {
  if (props.scope === "server") return <ServerStatusPopover variant={props.variant} />
  return <DirectoryStatusPopover variant={props.variant} />
}

function DirectoryStatusPopover(props: { variant?: "v2" }) {
  const language = useLanguage()
  const server = useServer()
  const sync = useSync()
  const [shown, setShown] = createSignal(false)
  const ready = createMemo(() => server.healthy() === false || sync.data.mcp_ready)
  const mcpIssue = createMemo(() => {
    const mcp = Object.values(sync.data.mcp ?? {})
    const failed = mcp.some((item) => item.status === "failed" || item.status === "needs_client_registration")
    const warn = mcp.some((item) => item.status === "needs_auth")
    if (failed) return "critical" as const
    if (warn) return "warning" as const
  })
  const healthy = createMemo(() => server.healthy() === true && !mcpIssue())
  const state = createMemo<StatusPopoverState>(() => ({
    variant: props.variant,
    shown: shown(),
    ready: ready(),
    healthy: healthy(),
    serverHealth: server.healthy(),
    issue: mcpIssue(),
    label: language.t("status.popover.trigger"),
    onOpenChange: setShown,
    body: () => (
      <StatusPopoverBody shown={shown()}>
        <DirectoryBody shown={shown} />
      </StatusPopoverBody>
    ),
  }))

  return <StatusPopoverView state={state()} />
}

function ServerStatusPopover(props: { variant?: "v2" }) {
  const language = useLanguage()
  const server = useServer()
  const [shown, setShown] = createSignal(false)
  const state = createMemo<StatusPopoverState>(() => ({
    variant: props.variant,
    shown: shown(),
    ready: server.healthy() !== undefined,
    healthy: server.healthy() === true,
    serverHealth: server.healthy(),
    label: language.t("status.popover.trigger"),
    onOpenChange: setShown,
    body: () => (
      <StatusPopoverBody shown={shown()}>
        <ServerBody shown={shown} />
      </StatusPopoverBody>
    ),
  }))

  return <StatusPopoverView state={state()} />
}

type StatusPopoverState = {
  variant?: "v2"
  shown: boolean
  ready: boolean
  healthy: boolean
  serverHealth: boolean | undefined
  issue?: "critical" | "warning"
  label: string
  onOpenChange: (value: boolean) => void
  body: () => JSX.Element
}

function StatusPopoverBody(props: { shown: boolean; children: JSX.Element }) {
  return (
    <Show when={props.shown}>
      <Suspense
        fallback={<div class="w-[360px] h-14 rounded-xl bg-background-strong shadow-[var(--shadow-lg-border-base)]" />}
      >
        {props.children}
      </Suspense>
    </Show>
  )
}

function StatusPopoverView(props: { state: StatusPopoverState }) {
  const statusDotClass = () => ({
    "absolute rounded-full": true,
    "bg-icon-success-base": props.state.ready && props.state.healthy,
    "bg-icon-warning-base": props.state.ready && props.state.serverHealth === true && props.state.issue === "warning",
    "bg-icon-critical-base":
      props.state.serverHealth === false ||
      (props.state.ready && props.state.serverHealth === true && props.state.issue === "critical"),
    "bg-border-weak-base": props.state.serverHealth === undefined || !props.state.ready,
  })

  const popoverProps = {
    class: "[&_[data-slot=popover-body]]:p-0 w-[360px] max-w-[calc(100vw-40px)] bg-transparent border-0 shadow-none rounded-xl",
    gutter: 4,
    placement: "bottom-end" as const,
    shift: -168,
  }

  if (props.state.variant === "v2") {
    return (
      <Popover
        open={props.state.shown}
        onOpenChange={props.state.onOpenChange}
        triggerAs={IconButtonV2}
        triggerProps={{
          variant: "ghost-muted",
          size: "large",
          class: "!w-9 shrink-0",
          state: props.state.shown ? "pressed" : undefined,
          "aria-label": props.state.label,
        }}
        trigger={
          <div class="relative size-4">
            <IconV2 name={props.state.shown ? "status-active" : "status"} />
            <div classList={statusDotClass()} class="-top-1 -right-1 size-2 border border-[var(--v2-background-bg-deep)]" />
          </div>
        }
        {...popoverProps}
      >
        {props.state.body()}
      </Popover>
    )
  }

  return (
    <Popover
      open={props.state.shown}
      onOpenChange={props.state.onOpenChange}
      triggerAs={Button}
      triggerProps={{
        variant: "ghost",
        class: "titlebar-icon w-8 h-6 p-0 box-border",
        "aria-label": props.state.label,
        style: { scale: 1 },
      }}
      trigger={
        <div class="relative size-4">
          <div class="badge-mask-tight size-4 flex items-center justify-center">
            <Icon name={props.state.shown ? "status-active" : "status"} size="small" />
          </div>
          <div classList={statusDotClass()} class="-top-px -right-px size-1.5" />
        </div>
      }
      {...popoverProps}
    >
      {props.state.body()}
    </Popover>
  )
}
