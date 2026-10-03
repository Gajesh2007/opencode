import { createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useEvent } from "./event"

// Coarse estimate for streamed text, reasoning, and tool arguments, not billing
// usage. Final message metrics use provider-reported tokens instead.
const CHARS_PER_TOKEN_APPROX = 4

const TICK_MS = 100
const MAX_ACTIVE_SESSIONS = 128

type State = {
  messageID: string
  startTime: number
  chars: number
}

export const { use: useStreamingMetrics, provider: StreamingMetricsProvider } = createSimpleContext({
  name: "StreamingMetrics",
  init: () => {
    const event = useEvent()
    const [state, setState] = createStore<Record<string, State | undefined>>({})

    // Keep rates updating between deltas without including time to first token.
    const [now, setNow] = createSignal(Date.now())
    const ticker = setInterval(() => {
      if (Object.keys(state).length) setNow(Date.now())
    }, TICK_MS)
    onCleanup(() => clearInterval(ticker))

    event.on("message.part.delta", (e) => {
      const props = e.properties
      // Count generated fragments once, never tool output or part snapshots.
      if (props.field !== "text" && props.field !== "state.raw") return
      if (!props.delta) return
      if (state[props.sessionID]?.messageID !== props.messageID) {
        const sessions = Object.keys(state)
        // Bound retention if a completion/idle event was missed.
        if (!state[props.sessionID] && sessions.length >= MAX_ACTIVE_SESSIONS) {
          setState(sessions[0], undefined)
        }
        const startTime = Date.now()
        setState(props.sessionID, {
          messageID: props.messageID,
          startTime,
          chars: props.delta.length,
        })
        setNow(startTime)
        return
      }
      setState(props.sessionID, "chars", (c) => c + props.delta.length)
    })

    event.on("message.updated", (e) => {
      const info = e.properties.info
      if (info.role !== "assistant") return
      if (info.id !== state[info.sessionID]?.messageID) return
      if (info.time.completed === undefined) return
      setState(info.sessionID, undefined)
    })

    event.on("session.status", (e) => {
      if (e.properties.status.type !== "idle") return
      setState(e.properties.sessionID, undefined)
    })

    event.on("session.idle", (e) => {
      setState(e.properties.sessionID, undefined)
    })

    return {
      active: (sessionID: string | undefined) => !!sessionID && !!state[sessionID],
      messageID: (sessionID: string | undefined) => (sessionID ? state[sessionID]?.messageID : undefined),
      tps: (sessionID: string | undefined) => {
        const current = sessionID ? state[sessionID] : undefined
        if (!current) return 0
        const elapsedMs = now() - current.startTime
        if (elapsedMs <= 0) return 0
        return Math.round(current.chars / CHARS_PER_TOKEN_APPROX / (elapsedMs / 1000))
      },
    }
  },
})
