import { createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useEvent } from "./event"

// Coarse English-text average. Used as a divisor on streamed character count
// to produce a "live tok/s" estimate while the model is generating. The final
// realized TPS on the message footer uses the provider-reported token count
// from step-finish, which is exact — this one is best-effort, never persisted.
const CHARS_PER_TOKEN_APPROX = 4

const TICK_MS = 100

type State = {
  messageID: string | undefined
  startTime: number
  chars: number
}

export const { use: useStreamingMetrics, provider: StreamingMetricsProvider } = createSimpleContext({
  name: "StreamingMetrics",
  init: () => {
    const event = useEvent()
    const [state, setState] = createStore<State>({
      messageID: undefined,
      startTime: 0,
      chars: 0,
    })

    // Wall-clock tick so the TPS keeps updating between deltas. Cheap; only
    // re-renders consumers when they actually read `tps()` and the value
    // crosses a rounded integer.
    const [now, setNow] = createSignal(Date.now())
    const ticker = setInterval(() => {
      if (state.messageID) setNow(Date.now())
    }, TICK_MS)
    onCleanup(() => clearInterval(ticker))

    event.on("message.part.delta", (e) => {
      const props = e.properties as { messageID: string; field?: string; delta?: string }
      // Streaming deltas land on multiple field names (text content, reasoning
      // text, tool input JSON, etc.). Count only "text" — the visible stream —
      // so tool-call argument streaming doesn't inflate the rate.
      if (props.field !== "text") return
      const delta = props.delta ?? ""
      if (state.messageID !== props.messageID) {
        // First delta for a new message: anchor the start time here, not at
        // request-send time, because request-send → first-token is dominated
        // by TTFT which would skew the per-token rate downward.
        setState({
          messageID: props.messageID,
          startTime: Date.now(),
          chars: delta.length,
        })
        setNow(Date.now())
        return
      }
      setState("chars", (c) => c + delta.length)
    })

    event.on("message.updated", (e) => {
      const info = e.properties.info as { id: string; role?: string; time?: { completed?: number } }
      if (info.role !== "assistant") return
      if (info.id !== state.messageID) return
      if (info.time?.completed) {
        setState({ messageID: undefined, startTime: 0, chars: 0 })
      }
    })

    return {
      active: () => !!state.messageID,
      messageID: () => state.messageID,
      tps: () => {
        if (!state.messageID) return 0
        const elapsedMs = now() - state.startTime
        if (elapsedMs <= 0) return 0
        return Math.round(state.chars / CHARS_PER_TOKEN_APPROX / (elapsedMs / 1000))
      },
    }
  },
})
