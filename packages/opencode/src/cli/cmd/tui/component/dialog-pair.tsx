import { RGBA, TextAttributes, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createOpencodeClient, type OpencodeClient, type RemoteStatus } from "@opencode-ai/sdk/v2"
import { batch, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { renderUnicodeCompact } from "uqr"
import { remoteConfirmMessage, remoteWarningLines } from "@/cli/remote-consent"
import { ServerAuth } from "@/server/auth"
import { PairingState } from "@/server/pairing-state"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useBindings } from "../keymap"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { Link } from "../ui/link"
import { Pair } from "../util/pair"
import { Spinner } from "./spinner"

// Phone cameras expect dark modules on a light background, whatever the theme.
const QR_LIGHT = RGBA.fromInts(255, 255, 255)
const QR_DARK = RGBA.fromInts(0, 0, 0)

export function DialogPair(props: { listen?: () => Promise<Pair.Listener>; enableRemote?: boolean }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [server, setServer] = createSignal<{ client: OpencodeClient; local: boolean }>()
  const [urls, setURLs] = createSignal<string[]>([])
  const [pairing, setPairing] = createSignal<{ code: string; minutes: number; expires: number }>()
  const [remote, setRemote] = createSignal<RemoteStatus>()
  const [remoteProblem, setRemoteProblem] = createSignal<string>()
  // Why the server refused the last toggle; it stays until the next one.
  const [refused, setRefused] = createSignal<string>()
  const [problem, setProblem] = createSignal<string>()
  const [mode, setMode] = createSignal<Pair.QRMode>("app")
  const [now, setNow] = createSignal(Date.now())
  const [measured, setMeasured] = createSignal(0)
  let scroll: ScrollBoxRenderable | undefined
  let disposed = false
  let poll: ReturnType<typeof setTimeout> | undefined
  let issuing = false
  let toggling = false
  // Remote status requests can overlap; only the most recently started one may update the view.
  let latest = 0

  const ordered = createMemo(() => Pair.order(urls(), remote()))
  const links = createMemo(() => {
    const current = pairing()
    return current ? ordered().map((url) => Pair.link(url, current.code)) : []
  })
  const local = createMemo(() => {
    const current = pairing()
    if (!current || !server()?.local) return
    return Pair.localLink(ordered(), current.code)
  })
  const qr = createMemo(() => {
    const current = pairing()
    const content = current ? Pair.qrContent(mode(), current.code, ordered()) : undefined
    return content ? renderUnicodeCompact(content, { border: 1 }) : undefined
  })
  const left = createMemo(() => Pair.secondsLeft(pairing()?.expires ?? 0, now()))
  // Matches the xlarge dialog's width and its padding.
  const horizontal = createMemo(() => {
    const code = qr()
    return !!code && Math.min(116, dimensions().width - 2) - 4 - code.indexOf("\n") - 3 >= 40
  })
  // Leaves room for the dialog's top offset, header, footer, and padding.
  const available = createMemo(() => Math.max(4, dimensions().height - Math.floor(dimensions().height / 4) - 6))
  const overflow = createMemo(() => measured() > available())
  const summary = createMemo(() => {
    const status = remote()
    return status ? Pair.remoteSummary(status) : undefined
  })

  onMount(() => {
    dialog.setSize("xlarge")
    const tick = setInterval(() => {
      setNow(Date.now())
      if (Date.now() >= (pairing()?.expires ?? Infinity)) void issue()
    }, 1000)
    onCleanup(() => {
      disposed = true
      clearInterval(tick)
      clearTimeout(poll)
    })
    void start()
  })

  async function start() {
    const opened = await open()
    if (disposed) return
    if ("error" in opened) return setProblem(opened.error)
    const [info, issued, status] = await Promise.all([
      opened.client.global.info(),
      opened.client.server.pair(),
      opened.client.server.remote(),
    ])
    if (disposed) return
    if (!issued.data) return setProblem(Pair.failure(issued))
    if (!info.data) return setProblem(Pair.failure(info))
    const urls = info.data.urls
    const code = issued.data
    batch(() => {
      setServer(opened)
      setURLs(urls)
      setPairing(expiry(code))
      observe(status)
    })
    if (props.enableRemote && status.data) return update(true)
  }

  // An in-process server has no network listener until pairing asks for one.
  async function open() {
    if (!props.listen) return { client: sdk.client, local: Pair.isLocal(sdk.url) }
    const listener = await props.listen()
    if ("error" in listener) return listener
    return {
      client: createOpencodeClient({ baseUrl: listener.url, headers: ServerAuth.headers(listener) }),
      local: true,
    }
  }

  function expiry(input: { code: string; expires_in: number }) {
    setNow(Date.now())
    return {
      code: input.code,
      minutes: Math.round(input.expires_in / 60),
      expires: Date.now() + input.expires_in * 1000,
    }
  }

  async function issue() {
    const current = server()
    if (!current || issuing || problem()) return
    issuing = true
    const result = await current.client.server.pair()
    issuing = false
    if (disposed) return
    if (!result.data) return setProblem(Pair.failure(result))
    setPairing(expiry(result.data))
  }

  async function watch() {
    const current = server()
    if (!current || problem()) return
    const id = ++latest
    const result = await current.client.server.remote()
    if (disposed || id !== latest) return
    observe(result)
  }

  async function update(enabled: boolean) {
    const current = server()
    if (!current || toggling) return
    toggling = true
    clearTimeout(poll)
    setRefused(undefined)
    const id = ++latest
    const result = await current.client.server.remoteUpdate({ enabled })
    toggling = false
    if (disposed || id !== latest) return
    if (result.data) return observe(result)
    setRefused(Pair.failure(result, "remote access"))
    return watch()
  }

  // Shows a remote status response and schedules the next one. Settled states are still watched, more slowly:
  // tunnels drop and reconnect, and other clients may toggle remote access too.
  function observe(result: { data?: RemoteStatus; error?: unknown; response?: Response }) {
    clearTimeout(poll)
    const status = result.data
    if (!status) {
      setRemoteProblem(Pair.failure(result, "remote access"))
      // A server without remote access will not grow it; other failures may pass.
      if (result.response?.status !== 404) poll = setTimeout(() => void watch(), 5000)
      return
    }
    const previous = remote()
    batch(() => {
      setRemoteProblem(undefined)
      setRemote(status)
      // The server lists the remote URL among its URLs only while connected; drop it now rather than after the
      // refresh below.
      if (previous?.url && previous.url !== status.url) setURLs((urls) => urls.filter((url) => url !== previous.url))
    })
    if (previous && (previous.state !== status.state || previous.url !== status.url)) void refresh()
    poll = setTimeout(() => void watch(), Pair.settled(status) ? 5000 : 1000)
  }

  async function refresh() {
    const result = await server()?.client.global.info()
    if (disposed || !result?.data) return
    setURLs(result.data.urls)
  }

  function toggle() {
    const status = remote()
    if (!status || toggling || problem()) return
    if (status.enabled) return void update(false)
    if (PairingState.read().remoteAccepted) return void update(true)
    const listen = props.listen
    // The confirmation replaces this dialog, which comes back to turn remote access on if accepted, unless another
    // dialog took over meanwhile.
    void DialogConfirm.show(dialog, remoteConfirmMessage, remoteWarningLines.join("\n")).then((accepted) => {
      if (dialog.stack.length > 0) return
      dialog.replace(() => <DialogPair listen={listen} enableRemote={accepted === true} />)
      if (accepted) PairingState.acceptRemote()
    })
  }

  function switchMode() {
    if (!qr() || problem()) return
    setMode((value) => (value === "app" ? "browser" : "app"))
  }

  useBindings(() => ({
    bindings: [
      { key: "tab", desc: "Switch between the app and browser QR codes", group: "Pair", cmd: switchMode },
      { key: "r", desc: "Turn remote access on or off", group: "Pair", cmd: toggle },
      { key: "up", desc: "Scroll up", group: "Pair", cmd: () => scroll?.scrollBy(-1) },
      { key: "down", desc: "Scroll down", group: "Pair", cmd: () => scroll?.scrollBy(1) },
      { key: "pageup", desc: "Scroll up one page", group: "Pair", cmd: () => scroll?.scrollBy(-available()) },
      { key: "pagedown", desc: "Scroll down one page", group: "Pair", cmd: () => scroll?.scrollBy(available()) },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Pair device
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Switch
        fallback={
          <text fg={theme.textMuted}>
            {props.listen ? "Starting a network listener…" : "Loading server information…"}
          </text>
        }
      >
        <Match when={problem()}>
          {(message) => (
            <box>
              <text fg={theme.error} attributes={TextAttributes.BOLD}>
                Could not create pairing links
              </text>
              <text fg={theme.textMuted} wrapMode="word">
                {message()}
              </text>
              <text fg={theme.textMuted}>Close and reopen /pair to try again.</text>
            </box>
          )}
        </Match>
        <Match when={pairing()}>
          {(current) => (
            <scrollbox
              ref={(value: ScrollBoxRenderable) => (scroll = value)}
              height={Math.min(measured(), available())}
              verticalScrollbarOptions={{
                paddingLeft: 1,
                visible: overflow(),
                trackOptions: { backgroundColor: theme.backgroundElement, foregroundColor: theme.border },
              }}
            >
              <box
                flexDirection={horizontal() ? "row" : "column"}
                flexShrink={0}
                gap={horizontal() ? 3 : 1}
                onSizeChange={function (this: BoxRenderable) {
                  setMeasured(this.height)
                }}
              >
                {/* Flexing applies to the width beside the QR code; stacked, the text keeps its height. */}
                <box
                  flexGrow={horizontal() ? 1 : 0}
                  flexShrink={horizontal() ? 1 : 0}
                  minWidth={0}
                  gap={1}
                >
                  <text fg={theme.textMuted} wrapMode="word">
                    Open a link to connect. Links work once and expire in {current().minutes} minutes.
                  </text>
                  <Show when={local()}>
                    {(url) => (
                      <box>
                        <text fg={theme.textMuted}>This device</text>
                        <Link href={url()} fg={theme.text} />
                      </box>
                    )}
                  </Show>
                  <box>
                    <text fg={theme.textMuted}>Links</text>
                    <For each={links()}>{(url) => <Link href={url} fg={theme.text} />}</For>
                  </box>
                  <box>
                    <box flexDirection="row" gap={1}>
                      <text fg={theme.textMuted} flexShrink={0}>
                        Remote access
                      </text>
                      <Switch fallback={<text fg={theme.textMuted}>…</text>}>
                        <Match when={remoteProblem()}>
                          {(message) => (
                            <text fg={theme.error} wrapMode="word">
                              {message()}
                            </text>
                          )}
                        </Match>
                        <Match when={summary()?.busy && summary()}>
                          {(value) => <Spinner color={theme.warning}>{value().text}</Spinner>}
                        </Match>
                        <Match when={summary()}>
                          {(value) => (
                            <text
                              fg={
                                {
                                  muted: theme.textMuted,
                                  warning: theme.warning,
                                  success: theme.success,
                                  error: theme.error,
                                }[value().tone]
                              }
                              wrapMode="word"
                            >
                              {value().tone === "success" ? "● " : ""}
                              {value().text}
                            </text>
                          )}
                        </Match>
                      </Switch>
                    </box>
                    <Show when={refused()}>
                      {(message) => (
                        <text fg={theme.error} wrapMode="word">
                          {message()}
                        </text>
                      )}
                    </Show>
                  </box>
                  <Show when={!qr()}>
                    <text fg={theme.textMuted} wrapMode="word">
                      {remote()?.enabled && remote()?.state !== "error"
                        ? "Links for other devices appear once remote access connects."
                        : "To pair another device, turn on remote access, or start opencode with --hostname 0.0.0.0 and OPENCODE_SERVER_PASSWORD set."}
                    </text>
                  </Show>
                </box>
                <Show when={qr()}>
                  {(code) => (
                    <box flexShrink={0} alignItems="center">
                      <text fg={QR_LIGHT} bg={QR_DARK} wrapMode="none">
                        {code()}
                      </text>
                      <text fg={theme.textMuted}>
                        {mode() === "app" ? "Scan with the OpenCode app" : "Scan to open in a browser"}
                      </text>
                    </box>
                  )}
                </Show>
              </box>
            </scrollbox>
          )}
        </Match>
      </Switch>
      <box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Show when={pairing() && !problem()}>
          <text fg={theme.textMuted}>new links in {Pair.clock(left())}</text>
        </Show>
        <Show when={overflow() && !problem()}>
          <text>
            <span style={{ fg: theme.text, bold: true }}>scroll </span>
            <span style={{ fg: theme.textMuted }}>↑↓</span>
          </text>
        </Show>
        <Show when={qr() && !problem()}>
          <text onMouseUp={switchMode}>
            <span style={{ fg: theme.text, bold: true }}>{mode() === "app" ? "browser QR " : "app QR "}</span>
            <span style={{ fg: theme.textMuted }}>tab</span>
          </text>
        </Show>
        <Show when={remote() && !problem()}>
          <text onMouseUp={toggle}>
            <span style={{ fg: theme.text, bold: true }}>
              {remote()?.enabled ? "disable remote " : "enable remote "}
            </span>
            <span style={{ fg: theme.textMuted }}>r</span>
          </text>
        </Show>
        <text onMouseUp={() => dialog.clear()}>
          <span style={{ fg: theme.text, bold: true }}>close </span>
          <span style={{ fg: theme.textMuted }}>esc</span>
        </text>
      </box>
    </box>
  )
}
