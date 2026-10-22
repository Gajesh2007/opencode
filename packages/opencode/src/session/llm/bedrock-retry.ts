import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3StreamPart,
  type LanguageModelV3StreamResult,
} from "@ai-sdk/provider"
import * as Log from "@opencode-ai/core/util/log"
import { errorMessage } from "@/util/error"
import { quota, RETRY_TOKEN_QUOTA_DELAY } from "../retry"

const log = Log.create({ service: "bedrock-retry" })
// The final attempt waits normally instead of turning retry exhaustion into an error.
const windows = [10_000, 20_000, undefined]
const budget = 75_000

export type State = {
  active: boolean
  attempts: number
  committed: boolean
  error: Error | undefined
  unknownUsageAttempts: number
}

export function state(): State {
  return { active: false, attempts: 0, committed: false, error: undefined, unknownUsageAttempts: 0 }
}

export type Clock = {
  now(): number
  timestamp(): number
  random(): number
  setTimeout(callback: () => void, ms: number): () => void
}

const live: Clock = {
  now: () => performance.now(),
  timestamp: () => Date.now(),
  random: () => Math.random(),
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  },
}

export class BedrockRetryError extends Error {
  override readonly name = "BedrockRetryError"

  constructor(
    readonly reason: "deadline" | "budget" | "teardown" | "empty" | "prefix" | "incomplete",
    options?: ErrorOptions,
  ) {
    super(`Bedrock no-output retry stopped: ${reason}`, options)
  }
}

export function enabled(input: { providerID: string; npm: string; options: Record<string, unknown>; url?: string }) {
  if (input.providerID !== "amazon-bedrock" || input.options.noOutputRetries === false) return false
  const native = input.npm === "@ai-sdk/amazon-bedrock" || input.npm === "@ai-sdk/amazon-bedrock/mantle"
  if (!native && input.npm !== "@ai-sdk/openai") return false
  const url =
    typeof input.options.baseURL === "string" && input.options.baseURL !== "" ? input.options.baseURL : input.url
  if (!url) return native
  return /^https:\/\/bedrock-(?:runtime\.(?:[a-z0-9-]+|\$\{AWS_REGION\})\.amazonaws\.com|mantle\.(?:[a-z0-9-]+|\$\{AWS_REGION\})\.api\.aws)(?::443)?(?:\/|$)/.test(
    url,
  )
}

// This boundary runs before AI SDK input hooks, approvals, and tool dispatch.
// Aborting fetch does not establish that AWS stopped inference or billing.
export async function stream(input: {
  model: Pick<LanguageModelV3, "doStream">
  params: LanguageModelV3CallOptions
  state: State
  clock?: Clock
}): Promise<LanguageModelV3StreamResult> {
  if (input.params.tools?.some((tool) => tool.type === "provider")) return input.model.doStream(input.params)
  const clock = input.clock ?? live
  const state = input.state
  const started = clock.now()
  const parent = input.params.abortSignal
  state.active = true

  const fail = (error: unknown): never => {
    state.error = toError(error)
    throw state.error
  }

  for (const window of windows) {
    if (parent?.aborted) return fail(parent.reason)
    if (state.committed || state.attempts >= windows.length || clock.now() - started >= budget)
      return fail(new BedrockRetryError("budget"))
    state.attempts++
    const attemptStarted = clock.now()
    const ctrl = new AbortController()
    const signal = parent ? AbortSignal.any([parent, ctrl.signal]) : ctrl.signal
    const pending = Promise.withResolvers<never>()
    const prefix: LanguageModelV3StreamPart[] = []
    const first = new Set<string>()
    let size = 0
    let valid = true
    let finished = false
    let unknown = false
    let reader: ReadableStreamDefaultReader<LanguageModelV3StreamPart> | undefined
    let readFailure: { error: unknown } | undefined

    const abandon = (reason: string) => {
      if (finished || unknown) return
      unknown = true
      state.unknownUsageAttempts++
      log.warn("abandoned attempt", {
        attempt: state.attempts,
        reason,
        elapsedMs: clock.now() - attemptStarted,
        unknownUsageAttempts: state.unknownUsageAttempts,
        usage: "unknown; AWS cancellation and billing cessation are not confirmed",
      })
    }
    const invalidate = (error: unknown) => {
      valid = false
      pending.reject(error)
      ctrl.abort(error)
    }
    const onAbort = () => invalidate(parent?.reason)
    const clear =
      window === undefined
        ? () => {}
        : clock.setTimeout(
            () => invalidate(new BedrockRetryError("deadline")),
            Math.min(window, budget - (clock.now() - started)),
          )
    parent?.addEventListener("abort", onAbort, { once: true })
    const stop = () => {
      clear()
      parent?.removeEventListener("abort", onAbort)
    }
    const observe = (part: LanguageModelV3StreamPart) => {
      if (
        (part.type !== "text-delta" && part.type !== "reasoning-delta" && part.type !== "tool-input-delta") ||
        !part.delta ||
        first.has(part.type)
      )
        return
      first.add(part.type)
      log.info("first output", { attempt: state.attempts, kind: part.type, elapsedMs: clock.now() - attemptStarted })
    }
    log.info("attempt", { attempt: state.attempts, windowMs: window, unknownUsageAttempts: state.unknownUsageAttempts })

    const opening = Promise.resolve().then(() => {
      signal.throwIfAborted()
      return input.model.doStream({ ...input.params, abortSignal: signal })
    })
    const work = opening.then(async (result) => {
      reader = result.stream.getReader()
      log.info("stream opened", { attempt: state.attempts, elapsedMs: clock.now() - attemptStarted })
      while (valid) {
        const part = await reader.read().catch((error: unknown) => {
          readFailure = { error }
          throw error
        })
        signal.throwIfAborted()
        if (!valid) throw new BedrockRetryError("deadline")
        if (!part.done && part.value.type === "finish")
          finished = part.value.finishReason.unified !== "other" || part.value.finishReason.raw !== undefined
        if ((part.done || part.value.type === "finish") && window !== undefined) throw new BedrockRetryError("empty")
        if (part.done) {
          abandon("eof")
          stop()
          reader.releaseLock()
          return {
            ...result,
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              start(controller) {
                for (const item of prefix) controller.enqueue(item)
                controller.close()
              },
            }),
          }
        }
        if (part.value.type === "error") throw part.value.error
        prefix.push(part.value)
        if (part.value.type === "stream-start" || part.value.type === "response-metadata") {
          size += new TextEncoder().encode(JSON.stringify(part.value)).byteLength
          if (prefix.length > 64 || size > 65_536) throw new BedrockRetryError("prefix")
          continue
        }

        // Semantic starts and unknown parts fail closed, even before visible text.
        // The latch precedes enqueueing, so eager SDK tool execution cannot race it.
        if (part.value.type !== "finish") state.committed = true
        stop()
        observe(part.value)
        log.info(state.committed ? "progress" : "empty completion", {
          attempt: state.attempts,
          kind: part.value.type,
          elapsedMs: clock.now() - attemptStarted,
          unknownUsageAttempts: state.unknownUsageAttempts,
        })
        const source = reader
        let detach = () => {}
        return {
          ...result,
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              const onAbort = () => {
                if (!valid) return
                valid = false
                abandon("abort")
                state.error = toError(parent?.reason)
                ctrl.abort(parent?.reason)
                void source.cancel(parent?.reason).catch(() => {})
                controller.error(state.error)
              }
              parent?.addEventListener("abort", onAbort, { once: true })
              detach = () => parent?.removeEventListener("abort", onAbort)
              if (parent?.aborted) return onAbort()
              for (const item of prefix) controller.enqueue(item)
            },
            async pull(controller) {
              try {
                const next = await source.read()
                signal.throwIfAborted()
                if (!valid) return
                if (next.done) {
                  abandon("eof")
                  if (!finished && state.committed) throw new BedrockRetryError("incomplete")
                  valid = false
                  detach()
                  source.releaseLock()
                  controller.close()
                  return
                }
                observe(next.value)
                if (next.value.type === "finish") {
                  // Bedrock synthesizes this finish when AWS messageStop is missing.
                  if (
                    state.committed &&
                    next.value.finishReason.unified === "other" &&
                    next.value.finishReason.raw === undefined
                  )
                    throw new BedrockRetryError("incomplete")
                  finished = true
                }
                if (next.value.type === "error") {
                  abandon("error")
                  state.error = toError(next.value.error)
                }
                controller.enqueue(next.value)
              } catch (error) {
                if (!valid) return
                valid = false
                abandon("error")
                detach()
                state.error = toError(error)
                ctrl.abort(error)
                void source.cancel(error).catch(() => {})
                controller.error(state.error)
              }
            },
            async cancel(reason) {
              valid = false
              abandon("cancel")
              detach()
              ctrl.abort(reason)
              await source.cancel(reason)
            },
          }),
        }
      }
      throw new BedrockRetryError("deadline")
    })

    const result = await Promise.race([work, pending.promise]).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    stop()
    if ("value" in result) return result.value
    invalidate(result.error)
    abandon("no-output")

    // Joining both setup and the reader is required before any replacement request.
    // A provider that ignores abort fails closed rather than creating an overlap.
    const teardown = Promise.all([
      opening.then(
        () =>
          reader?.cancel(result.error).catch((error: unknown) => {
            // Fetch abort errors the stream; cancel then rejects its stored read
            // error. That is already closed, unlike a failing cancellation hook.
            if (readFailure && Object.is(readFailure.error, error)) return
            throw error
          }),
        () => {},
      ),
      work.then(
        () => {},
        () => {},
      ),
    ]).then(() => reader?.releaseLock())
    const closed = await within(
      teardown,
      window === undefined ? 1000 : Math.min(1000, Math.max(0, budget - (clock.now() - started))),
      clock,
    )
    if (parent?.aborted) return fail(parent.reason)
    if (!closed) return fail(new BedrockRetryError("teardown", { cause: result.error }))
    if (state.committed) return fail(result.error)
    const api = APICallError.isInstance(result.error) ? result.error : undefined
    const limit = quota(errorMessage(result.error), api?.responseBody)
    const retry =
      (result.error instanceof BedrockRetryError &&
        (result.error.reason === "deadline" || result.error.reason === "empty")) ||
      (limit !== "permanent" &&
        (api
          ? api.isRetryable ||
            (api.statusCode !== undefined &&
              ([408, 409, 425, 429].includes(api.statusCode) || api.statusCode >= 500)) ||
            (api.statusCode === undefined && limit === "temporary")
          : limit === "temporary"))
    if (!retry || state.attempts >= windows.length) return fail(result.error)

    const delay =
      (retryAfter(api?.responseHeaders, clock.timestamp()) ??
        (limit === "temporary" ? RETRY_TOKEN_QUOTA_DELAY : api ? 2000 * 2 ** (state.attempts - 1) : 0)) +
      100 +
      Math.floor(Math.max(0, Math.min(1, clock.random())) * 200)
    if (delay >= budget - (clock.now() - started)) return fail(result.error)
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        cancel()
        reject(parent?.reason)
      }
      const cancel = clock.setTimeout(() => {
        parent?.removeEventListener("abort", onAbort)
        resolve()
      }, delay)
      parent?.addEventListener("abort", onAbort, { once: true })
      if (parent?.aborted) onAbort()
    }).catch(fail)
  }
  return fail(new BedrockRetryError("budget"))
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(errorMessage(error), { cause: error })
}

function retryAfter(headers: Record<string, string> | undefined, now: number) {
  if (!headers) return
  const normalized = new Headers(headers)
  const ms = normalized.get("retry-after-ms")
  if (ms !== null && ms.trim() !== "" && Number.isFinite(Number(ms)) && Number(ms) >= 0) return Number(ms)
  const seconds = normalized.get("retry-after")
  if (seconds === null || seconds.trim() === "") return
  if (Number.isFinite(Number(seconds)) && Number(seconds) >= 0) return Number(seconds) * 1000
  const date = Date.parse(seconds)
  if (Number.isFinite(date) && date > now) return date - now
}

async function within(promise: Promise<unknown>, ms: number, clock: Clock) {
  const expiry = Promise.withResolvers<boolean>()
  const cancel = clock.setTimeout(() => expiry.resolve(false), ms)
  return Promise.race([
    promise.then(
      () => true,
      () => false,
    ),
    expiry.promise,
  ]).finally(cancel)
}

export * as BedrockRetry from "./bedrock-retry"
