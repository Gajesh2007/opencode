import { Splash } from "@opencode-ai/ui/logo"
import { createSignal, Show } from "solid-js"
import { TunnelTransport, type ConnectionState } from "./tunnel"
import { setActiveTunnel } from "./tunnel-state"

const KEYS = { relay: "oc_relay", room: "oc_room", token: "oc_token" } as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key) ?? ""
  } catch {
    return ""
  }
}

const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {}
}

// First screen: collect relay/room/token, persist them, open the tunnel and hand
// the live transport up once the relay reports "connected" (the relay only admits
// a client when the opencode host is already online, so connected ⇒ host online).
export function ConnectGate(props: { onConnected: (tunnel: TunnelTransport) => void }) {
  const [relay, setRelay] = createSignal(read(KEYS.relay))
  const [room, setRoom] = createSignal(read(KEYS.room))
  const [token, setToken] = createSignal(read(KEYS.token))
  const [state, setState] = createSignal<ConnectionState | "idle">("idle")
  const [error, setError] = createSignal("")

  let current: TunnelTransport | null = null
  let done = false

  const submit = (event: Event) => {
    event.preventDefault()
    const r = relay().trim()
    const rm = room().trim()
    const tk = token().trim()
    if (!r || !rm || !tk) {
      setError("Relay URL, room and token are all required")
      return
    }
    write(KEYS.relay, r)
    write(KEYS.room, rm)
    write(KEYS.token, tk)
    setError("")
    setState("connecting")
    done = false
    current?.disconnect()

    const tunnel = new TunnelTransport(r, rm, tk, (next) => {
      setState(next)
      if (next === "connected" && !done) {
        done = true
        setActiveTunnel(tunnel)
        props.onConnected(tunnel)
      }
    })
    current = tunnel
    tunnel.connect()
  }

  const connecting = () => state() === "connecting" || state() === "connected"

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-8 p-6">
      <div class="flex flex-col items-center gap-3">
        <Splash class="w-12 h-15" />
        <h1 class="text-14-regular font-medium text-text-strong">opencode remote</h1>
        <p class="text-12-regular text-text-weak text-center max-w-xs">
          Connect to your opencode host through the relay tunnel.
        </p>
      </div>

      <form class="flex flex-col gap-3 w-full max-w-sm" onSubmit={submit}>
        <Field label="Relay WebSocket URL" placeholder="wss://relay.example.com" value={relay()} onInput={setRelay} />
        <Field label="Room" placeholder="my-room" value={room()} onInput={setRoom} />
        <Field label="Token" placeholder="secret-token" type="password" value={token()} onInput={setToken} />

        <Show when={error()}>
          <p class="text-12-regular text-text-critical-base">{error()}</p>
        </Show>

        <button
          type="submit"
          disabled={connecting()}
          class="mt-2 h-10 rounded-lg bg-surface-base border border-border-base text-text-strong text-14-regular font-medium hover:bg-surface-raised-base-hover disabled:opacity-60 transition-colors"
        >
          {connecting() ? "Connecting…" : "Connect"}
        </button>

        <Show when={state() === "connecting"}>
          <p class="text-12-regular text-text-weak text-center">
            Waiting for the relay and host. The relay only admits a client when the host is online.
          </p>
        </Show>
        <Show when={state() === "disconnected"}>
          <p class="text-12-regular text-text-weak text-center">Disconnected — retrying…</p>
        </Show>
      </form>
    </div>
  )
}

function Field(props: {
  label: string
  placeholder?: string
  value: string
  type?: string
  onInput: (value: string) => void
}) {
  return (
    <label class="flex flex-col gap-1">
      <span class="text-12-regular text-text-weak">{props.label}</span>
      <input
        type={props.type ?? "text"}
        placeholder={props.placeholder}
        value={props.value}
        autocapitalize="off"
        autocomplete="off"
        autocorrect="off"
        spellcheck={false}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        class="h-10 px-3 rounded-lg bg-surface-base border border-border-weak-base text-14-regular text-text-strong placeholder:text-text-weakest outline-none focus:border-border-base"
      />
    </label>
  )
}
