import { expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { LLMEvent } from "@opencode-ai/llm"
import * as Auxiliary from "../../src/session/auxiliary"
import { it } from "../lib/effect"

const unavailable = { type: "unavailable" as const, message: "" }

it.effect("auxiliary recovers typed provider failures and defects", () =>
  Effect.gen(function* () {
    for (const failed of [Effect.fail("secret provider error"), Effect.die("secret parse error")]) {
      expect(yield* Auxiliary.recover(failed, unavailable)).toEqual(unavailable)
    }
  }),
)

it.effect("auxiliary preserves interruptions, including mixed failure causes", () =>
  Effect.gen(function* () {
    for (const failed of [Effect.interrupt, Effect.failCause(Cause.combine(Cause.die("failure"), Cause.interrupt()))]) {
      const exit = yield* Auxiliary.recover(failed, unavailable).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    }
  }),
)

it.effect("auxiliary times out without approving and releases the call", () =>
  Effect.gen(function* () {
    let released = false
    const call = yield* Auxiliary.recover(
      Effect.never.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            released = true
          }),
        ),
      ),
      unavailable,
    ).pipe(Effect.forkChild)
    yield* TestClock.adjust(Auxiliary.TIMEOUT)
    expect(yield* Fiber.join(call)).toEqual(unavailable)
    expect(released).toBe(true)
  }),
)

it.effect("auxiliary bounds output and rejects provider errors and incomplete responses", () =>
  Effect.gen(function* () {
    const text = (value: string) => LLMEvent.textDelta({ id: "text", text: value })
    const finish = LLMEvent.finish({ reason: "stop" })
    for (const events of [
      [text("x".repeat(Auxiliary.MAX_OUTPUT + 1)), finish],
      [text("REVIEW_OK"), LLMEvent.providerError({ message: "secret" })],
      [text("REVIEW_OK")],
      [text("REVIEW_OK"), LLMEvent.finish({ reason: "length" })],
    ]) {
      expect(yield* Auxiliary.recover(Auxiliary.text(Stream.fromIterable<LLMEvent>(events)), unavailable)).toEqual(
        unavailable,
      )
    }
    expect(yield* Auxiliary.text(Stream.fromIterable([text("REVIEW_OK"), finish]))).toBe("REVIEW_OK")
  }),
)
