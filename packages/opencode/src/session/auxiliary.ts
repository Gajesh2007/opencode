import { Cause, Effect, Stream } from "effect"
import { LLMEvent } from "@opencode-ai/llm"

// Auxiliary calls must never stall the main turn or retain unbounded model output.
export const TIMEOUT = 30_000
export const MAX_OUTPUT = 8_192

export function text<E, R>(stream: Stream.Stream<LLMEvent, E, R>) {
  return stream.pipe(
    Stream.runFoldEffect(
      () => ({ text: "", finished: false }),
      (result, event) => {
        if (LLMEvent.is.providerError(event) || LLMEvent.is.toolError(event)) return Effect.fail("provider")
        if (LLMEvent.is.finish(event)) {
          if (event.reason !== "stop") return Effect.fail("incomplete")
          return Effect.succeed({ ...result, finished: true })
        }
        if (!LLMEvent.is.textDelta(event)) return Effect.succeed(result)
        if (result.text.length + event.text.length > MAX_OUTPUT) return Effect.fail("output_limit")
        return Effect.succeed({ ...result, text: result.text + event.text })
      },
    ),
    Effect.flatMap((result) => (result.finished ? Effect.succeed(result.text) : Effect.fail("incomplete"))),
  )
}

export function recover<A, E, R, B>(effect: Effect.Effect<A, E, R>, unavailable: B) {
  return effect.pipe(
    Effect.timeoutOrElse({ duration: TIMEOUT, orElse: () => Effect.succeed(unavailable) }),
    Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(unavailable))),
  )
}
