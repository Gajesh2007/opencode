import { describe, expect, test } from "bun:test"
import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { streamText, tool, wrapLanguageModel } from "ai"
import z from "zod"
import { BedrockRetry } from "../../src/session/llm/bedrock-retry"

type Part = LanguageModelV3StreamPart
type Result = Awaited<ReturnType<LanguageModelV3["doStream"]>>

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}
const finish: Part = { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }
// Bedrock's adapter flushes this shape when neither messageStop nor usage arrived.
const syntheticFinish: Part = {
  type: "finish",
  finishReason: { unified: "other", raw: undefined },
  usage: {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    raw: undefined,
  },
}
const call: Part = { type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: '{"query":"offline"}' }
const prompt: LanguageModelV3CallOptions = { prompt: [{ role: "user", content: [{ type: "text", text: "offline" }] }] }

// Drain promise continuations without advancing either real or virtual deadlines.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function clock() {
  const state = { now: 0, serial: 0 }
  const timers = new Map<number, { at: number; callback: () => void }>()
  const api: BedrockRetry.Clock = {
    now: () => state.now,
    timestamp: () => Date.UTC(2026, 0, 1) + state.now,
    random: () => 0,
    setTimeout(callback, ms) {
      const id = state.serial++
      timers.set(id, { at: state.now + ms, callback })
      return () => {
        timers.delete(id)
      }
    },
  }
  return {
    api,
    pending: () => [...timers.values()].map((timer) => timer.at).sort((a, b) => a - b),
    async advance(ms: number) {
      const end = state.now + ms
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > end) break
        state.now = next[1].at
        timers.delete(next[0])
        next[1].callback()
        await flush()
      }
      state.now = end
      await flush()
    },
  }
}

function harness(
  dispatch: (params: LanguageModelV3CallOptions, attempt: number) => ReturnType<LanguageModelV3["doStream"]>,
  params: Partial<LanguageModelV3CallOptions> = {},
) {
  const time = clock()
  const state = BedrockRetry.state()
  const caller = new AbortController()
  const calls: { at: number; params: LanguageModelV3CallOptions }[] = []
  const language = model((params) => {
    calls.push({ at: time.api.now(), params })
    return dispatch(params, calls.length)
  })
  return {
    time,
    state,
    caller,
    calls,
    model: language,
    start: () =>
      BedrockRetry.stream({
        model: language,
        params: { ...prompt, abortSignal: caller.signal, ...params },
        state,
        clock: time.api,
      }),
  }
}

function outcome<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  )
}

async function collect(result: Result, parts: Part[] = []) {
  const reader = result.stream.getReader()
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) return parts
      parts.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
}

function source(cancel?: (reason: unknown) => Promise<void>) {
  const state: { controller?: ReadableStreamDefaultController<Part> } = {}
  const cancelled = Promise.withResolvers<unknown>()
  const stream = new ReadableStream<Part>({
    start(controller) {
      state.controller = controller
    },
    cancel(reason) {
      cancelled.resolve(reason)
      return cancel?.(reason)
    },
  })
  return {
    stream,
    cancelled: cancelled.promise,
    push(part: Part) {
      if (!state.controller) throw new Error("Scripted stream has not started")
      state.controller.enqueue(part)
    },
    close() {
      if (!state.controller) throw new Error("Scripted stream has not started")
      state.controller.close()
    },
    error(error: unknown) {
      if (!state.controller) throw new Error("Scripted stream has not started")
      state.controller.error(error)
    },
  }
}

function model(doStream: LanguageModelV3["doStream"]): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "amazon-bedrock",
    modelId: "offline",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("Streaming fixture must not generate")
    },
    doStream,
  }
}

const progress: Part[] = [
  { type: "text-start", id: "text" },
  { type: "text-delta", id: "text", delta: "hello" },
  { type: "text-delta", id: "text", delta: "" },
  { type: "text-end", id: "text" },
  { type: "reasoning-start", id: "reasoning" },
  { type: "reasoning-delta", id: "reasoning", delta: "thinking" },
  { type: "reasoning-delta", id: "reasoning", delta: "" },
  { type: "reasoning-end", id: "reasoning" },
  { type: "tool-input-start", id: "call-1", toolName: "lookup" },
  { type: "tool-input-delta", id: "call-1", delta: '{"query":' },
  { type: "tool-input-delta", id: "call-1", delta: "" },
  { type: "tool-input-end", id: "call-1" },
  call,
  { ...call, providerExecuted: true },
  { type: "tool-result", toolCallId: "call-1", toolName: "lookup", result: "found" },
  { type: "tool-approval-request", approvalId: "approval-1", toolCallId: "call-1" },
  { type: "file", mediaType: "image/png", data: "offline" },
  { type: "source", sourceType: "url", id: "source-1", url: "https://offline.invalid" },
  { type: "source", sourceType: "document", id: "source-1", mediaType: "text/plain", title: "offline" },
  { type: "raw", rawValue: { unknown: "possibly semantic" } },
]

describe("Bedrock raw pre-output retry deadlines", () => {
  test.each(["before headers", "metadata only", "metadata with fetch-like abort"])(
    "10/20/40 second windows %s, with separate backoff",
    async (phase) => {
      const stops: number[] = []
      const h = harness((params) => {
        if (phase === "before headers") {
          return new Promise<Result>((_, reject) => {
            params.abortSignal?.addEventListener(
              "abort",
              () => {
                stops.push(h.time.api.now())
                reject(params.abortSignal?.reason)
              },
              { once: true },
            )
          })
        }
        const raw = source(async () => {
          stops.push(h.time.api.now())
        })
        if (phase === "metadata with fetch-like abort")
          params.abortSignal?.addEventListener(
            "abort",
            () => {
              stops.push(h.time.api.now())
              raw.error(params.abortSignal?.reason)
            },
            { once: true },
          )
        raw.push({ type: "stream-start", warnings: [] })
        raw.push({ type: "response-metadata", id: `attempt-${h.calls.length}` })
        return Promise.resolve({ stream: raw.stream })
      })
      const done = outcome(h.start().then(collect))
      await flush()

      for (const [index, window] of [10_000, 20_000, 40_000].entries()) {
        expect(h.calls).toHaveLength(index + 1)
        await h.time.advance(window - 1)
        expect(stops).toHaveLength(index)
        await h.time.advance(1)
        expect(stops).toHaveLength(index + 1)
        expect(h.calls).toHaveLength(index + 1)
        if (index === 2) break
        await h.time.advance(99)
        expect(h.calls).toHaveLength(index + 1)
        await h.time.advance(1)
      }

      expect((await done).error).toBeInstanceOf(BedrockRetry.BedrockRetryError)
      expect(h.state.error).toMatchObject({ reason: "deadline" })
      expect(h.state.attempts).toBe(3)
      expect(h.state.unknownUsageAttempts).toBe(3)
      expect(h.state.committed).toBe(false)
      expect(h.calls.map((call) => call.at)).toEqual([0, 10_100, 30_200])
      expect(stops).toEqual([10_000, 30_100, 70_200])
      await h.time.advance(100_000)
      expect(h.calls).toHaveLength(3)
      expect(h.time.pending()).toEqual([])
    },
  )

  test("metadata arrival does not restart the first deadline", async () => {
    const raw = source()
    const h = harness(async () => ({ stream: raw.stream }))
    const done = outcome(h.start().then(collect))
    await flush()
    await h.time.advance(9_999)
    raw.push({ type: "response-metadata", id: "late-header" })
    await flush()
    await h.time.advance(1)
    await raw.cancelled
    expect(h.calls[0].params.abortSignal?.aborted).toBe(true)
    h.caller.abort()
    await h.time.advance(1_000)
    expect((await done).error).toBeDefined()
    expect(h.calls).toHaveLength(1)
  })

  test("the 75 second wall budget includes Retry-After and clips a later attempt window", async () => {
    const h = harness((params, attempt) => {
      if (attempt === 1)
        return Promise.reject(
          new APICallError({
            message: "busy",
            url: "https://offline.invalid",
            requestBodyValues: {},
            statusCode: 503,
            responseHeaders: { "retry-after": "35" },
          }),
        )
      return new Promise<Result>((_, reject) => {
        params.abortSignal?.addEventListener("abort", () => reject(params.abortSignal?.reason), { once: true })
      })
    })
    const done = outcome(h.start().then(collect))
    await flush()
    await h.time.advance(35_099)
    expect(h.calls).toHaveLength(1)
    await h.time.advance(1)
    expect(h.calls.map((call) => call.at)).toEqual([0, 35_100])
    await h.time.advance(20_100)
    expect(h.calls.map((call) => call.at)).toEqual([0, 35_100, 55_200])
    await h.time.advance(19_799)
    expect(h.calls[2].params.abortSignal?.aborted).toBe(false)
    await h.time.advance(1)
    expect((await done).error).toBeInstanceOf(BedrockRetry.BedrockRetryError)
    expect(h.time.api.now()).toBe(75_000)
    expect(h.state.attempts).toBe(3)
    expect(h.calls[2].params.abortSignal?.aborted).toBe(true)
    await h.time.advance(100_000)
    expect(h.calls).toHaveLength(3)
    expect(h.time.pending()).toEqual([])
  })

  test("empty completions share the same three wire-attempt budget", async () => {
    const h = harness(async () => {
      const raw = source()
      raw.push({ type: "stream-start", warnings: [] })
      raw.push(finish)
      raw.close()
      return { stream: raw.stream }
    })
    const done = outcome(h.start().then(collect))
    await flush()
    await h.time.advance(200)
    expect((await done).error).toBeInstanceOf(BedrockRetry.BedrockRetryError)
    expect(h.state.error).toMatchObject({ reason: "empty" })
    expect(h.state.attempts).toBe(3)
    expect(h.calls.map((call) => call.at)).toEqual([0, 100, 200])
    expect(h.time.pending()).toEqual([])
  })
})

describe("Bedrock local teardown acknowledgement", () => {
  test("abort acknowledgement and late response reader cancellation both precede redispatch", async () => {
    const headers = Promise.withResolvers<Result>()
    const cancelled = Promise.withResolvers<void>()
    const stale = source(() => cancelled.promise)
    const good = source()
    const h = harness(async (_params, attempt) => (attempt === 1 ? headers.promise : { stream: good.stream }))
    const done = outcome(h.start().then(collect))
    await flush()
    await h.time.advance(10_000)
    expect(h.calls[0].params.abortSignal?.aborted).toBe(true)
    expect(h.calls).toHaveLength(1)
    await h.time.advance(200)
    stale.push({ type: "response-metadata", id: "invalidated" })
    stale.push({ type: "text-start", id: "stale" })
    stale.push({ type: "text-delta", id: "stale", delta: "must not escape" })
    headers.resolve({ stream: stale.stream })
    await stale.cancelled
    await h.time.advance(200)
    expect(h.calls).toHaveLength(1)
    cancelled.resolve()
    await flush()
    await h.time.advance(99)
    expect(h.calls).toHaveLength(1)
    await h.time.advance(1)
    expect(h.calls.map((call) => call.at)).toEqual([0, 10_500])
    good.push({ type: "response-metadata", id: "valid" })
    good.push({ type: "text-start", id: "live" })
    good.push({ type: "text-delta", id: "live", delta: "accepted" })
    good.push(finish)
    good.close()
    expect((await done).value).toEqual([
      { type: "response-metadata", id: "valid" },
      { type: "text-start", id: "live" },
      { type: "text-delta", id: "live", delta: "accepted" },
      finish,
    ])
    expect(h.state.committed).toBe(true)
    expect(h.time.pending()).toEqual([])
  })

  test.each(["headers never settle", "reader never cancels", "reader cancel rejects"])(
    "no resend when %s",
    async (phase) => {
      const pending = Promise.withResolvers<void>()
      const headers = Promise.withResolvers<Result>()
      const raw = source(() =>
        phase === "reader cancel rejects" ? Promise.reject(new Error("cancel failed")) : pending.promise,
      )
      const h = harness(async () => (phase === "headers never settle" ? headers.promise : { stream: raw.stream }))
      const done = outcome(h.start().then(collect))
      await flush()
      await h.time.advance(10_000)
      expect(h.calls[0].params.abortSignal?.aborted).toBe(true)
      await h.time.advance(1_000)
      expect((await done).error).toBeInstanceOf(BedrockRetry.BedrockRetryError)
      expect(h.state.error).toMatchObject({ reason: "teardown" })
      expect(h.calls).toHaveLength(1)
      pending.resolve()
      if (phase === "headers never settle") headers.resolve({ stream: raw.stream })
      await flush()
      await h.time.advance(100_000)
      expect(h.calls).toHaveLength(1)
      expect(h.time.pending()).toEqual([])
    },
  )

  test("metadata buffered by a cancelled attempt is discarded", async () => {
    const first = source()
    const second = source()
    const h = harness(async (_params, attempt) => ({ stream: attempt === 1 ? first.stream : second.stream }))
    const seen: Part[] = []
    const done = h.start().then((result) => collect(result, seen))
    first.push({ type: "stream-start", warnings: [{ type: "other", message: "stale warning" }] })
    first.push({ type: "response-metadata", id: "stale" })
    await flush()
    expect(seen).toEqual([])
    await h.time.advance(10_100)
    second.push({ type: "stream-start", warnings: [] })
    second.push({ type: "response-metadata", id: "live" })
    second.push({ type: "text-start", id: "live" })
    second.push(finish)
    second.close()
    await done
    expect(seen).toEqual([
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", id: "live" },
      { type: "text-start", id: "live" },
      finish,
    ])
  })
})

describe("Bedrock raw semantic commitment", () => {
  test.each(progress.map((part, index) => [`${part.type} (${index})`, part] as const))(
    "%s fences retries and completion deadlines",
    async (_name, part) => {
      const raw = source()
      const h = harness(async () => ({ stream: raw.stream }))
      const done = outcome(h.start().then(collect))
      raw.push(part)
      await flush()
      expect(h.state.committed).toBe(true)
      await h.time.advance(100_000)
      expect(h.calls).toHaveLength(1)
      expect(h.calls[0].params.abortSignal?.aborted).toBe(false)
      expect(h.time.pending()).toEqual([])
      const failure = new APICallError({
        message: "transient after commitment",
        url: "https://offline.invalid",
        requestBodyValues: {},
        statusCode: 503,
      })
      raw.error(failure)
      expect((await done).error).toBeDefined()
      await h.time.advance(100_000)
      expect(h.calls).toHaveLength(1)
      expect(h.state.attempts).toBe(1)
      expect(h.state.unknownUsageAttempts).toBe(1)
    },
  )

  test("unknown future event types fail closed before downstream dispatch", async () => {
    const raw = source()
    const h = harness(async () => ({ stream: raw.stream }))
    const done = outcome(h.start().then(collect))
    // A future provider event is deliberately outside today's SDK discriminated union.
    const part = { type: "future-tool-activity", id: "unknown" } as unknown as Part
    raw.push(part)
    await flush()
    expect(h.state.committed).toBe(true)
    await h.time.advance(100_000)
    expect(h.calls).toHaveLength(1)
    raw.push(finish)
    raw.close()
    expect((await done).value).toEqual([part, finish])
  })

  test.each(["event count", "byte count"])("metadata prefix %s is bounded without resend", async (bound) => {
    const raw = source()
    const h = harness(async () => ({ stream: raw.stream }))
    const done = outcome(h.start().then(collect))
    if (bound === "event count") {
      for (const index of Array.from({ length: 65 }, (_, index) => index))
        raw.push({ type: "response-metadata", id: `${index}` })
    } else {
      raw.push({ type: "response-metadata", id: "m".repeat(65_537) })
    }
    expect((await done).error).toBeInstanceOf(BedrockRetry.BedrockRetryError)
    expect(h.state.error).toMatchObject({ reason: "prefix" })
    await h.time.advance(100_000)
    expect(h.calls).toHaveLength(1)
    expect(h.time.pending()).toEqual([])
  })
})

describe("Bedrock committed truncation", () => {
  for (const channel of ["text", "tool"] as const) {
    test.each(["no finish", "synthetic finish"])(
      `${channel} followed by %s is terminal without replay`,
      async (ending) => {
        const raw = source()
        const h = harness(async () => ({ stream: raw.stream }))
        const seen: Part[] = []
        const done = outcome(h.start().then((result) => collect(result, seen)))
        const prefix: Part[] =
          channel === "tool"
            ? [call]
            : [
                { type: "text-start", id: "text" },
                { type: "text-delta", id: "text", delta: "partial answer" },
              ]
        for (const part of prefix) raw.push(part)
        await flush()
        expect(h.state.committed).toBe(true)
        expect(seen).toEqual(prefix)
        if (ending === "synthetic finish") raw.push(syntheticFinish)
        raw.close()
        const result = await done
        expect(result.error).toBeInstanceOf(BedrockRetry.BedrockRetryError)
        expect(result.error).toBe(h.state.error)
        expect(h.state.error).toMatchObject({ reason: "incomplete" })
        expect(h.state.unknownUsageAttempts).toBe(1)
        expect(seen).toEqual(prefix)
        h.caller.abort()
        await h.time.advance(100_000)
        expect(h.calls).toHaveLength(1)
        expect(h.state.attempts).toBe(1)
        expect(h.state.unknownUsageAttempts).toBe(1)
        expect(h.time.pending()).toEqual([])
      },
    )
  }

  test.each(["stop", "tool-calls", "length", "content-filter"] as const)(
    "authoritative %s finish still passes through",
    async (reason) => {
      const raw = source()
      const h = harness(async () => ({ stream: raw.stream }))
      const done = outcome(h.start().then(collect))
      const part: Part = reason === "tool-calls" ? call : { type: "text-start", id: "text" }
      const terminal: Part = { type: "finish", finishReason: { unified: reason, raw: reason }, usage }
      raw.push(part)
      raw.push(terminal)
      raw.close()
      expect((await done).value).toEqual([part, terminal])
      expect(h.state.error).toBeUndefined()
      expect(h.state.unknownUsageAttempts).toBe(0)
      await h.time.advance(100_000)
      expect(h.calls).toHaveLength(1)
      expect(h.time.pending()).toEqual([])
    },
  )

  test.each(["no finish", "synthetic finish"])(
    "real SDK tool execution followed by %s is terminal without duplicate execution",
    async (ending) => {
      const raw = source()
      const executed = Promise.withResolvers<void>()
      const executions: unknown[] = []
      const errors: unknown[] = []
      const h = harness(async () => ({ stream: raw.stream }))
      const result = streamText({
        model: wrapLanguageModel({
          model: h.model,
          middleware: {
            specificationVersion: "v3",
            wrapStream: ({ model, params }) =>
              BedrockRetry.stream({ model, params, state: h.state, clock: h.time.api }),
          },
        }),
        prompt: "offline truncated tool response",
        maxRetries: 0,
        tools: {
          lookup: tool({
            inputSchema: z.object({ query: z.string() }),
            execute: async (input) => {
              executions.push(input)
              executed.resolve()
              return "found"
            },
          }),
        },
      })
      const consumed = result.consumeStream({
        onError: (error) => {
          errors.push(error)
        },
      })
      raw.push({ type: "stream-start", warnings: [] })
      raw.push(call)
      await executed.promise
      expect(executions).toEqual([{ query: "offline" }])
      if (ending === "synthetic finish") raw.push(syntheticFinish)
      raw.close()
      await consumed
      expect(h.state.error).toBeInstanceOf(BedrockRetry.BedrockRetryError)
      expect(h.state.error).toMatchObject({ reason: "incomplete" })
      expect(errors).toContain(h.state.error)
      await h.time.advance(100_000)
      expect(executions).toEqual([{ query: "offline" }])
      expect(h.calls).toHaveLength(1)
      expect(h.state.unknownUsageAttempts).toBe(1)
      expect(h.time.pending()).toEqual([])
    },
  )
})

describe("Bedrock caller cancellation", () => {
  test.each(["AbortError", "TimeoutError"])(
    "already cancelled caller retains %s and makes no dispatch",
    async (name) => {
      const h = harness(async () => {
        throw new Error("must not dispatch")
      })
      const reason = new DOMException("caller stopped", name)
      h.caller.abort(reason)
      const done = await outcome(h.start().then(collect))
      expect(done.error).toBe(reason)
      expect(h.state.error).toBe(reason)
      expect(h.calls).toHaveLength(0)
      expect(h.time.pending()).toEqual([])
    },
  )

  test.each(["before headers", "metadata", "teardown", "backoff", "after commitment"])(
    "caller cancellation during %s never resends",
    async (phase) => {
      const acknowledgement = Promise.withResolvers<void>()
      const raw = source(() => (phase === "teardown" ? acknowledgement.promise : Promise.resolve()))
      const h = harness((params) => {
        if (phase !== "before headers") return Promise.resolve({ stream: raw.stream })
        return new Promise<Result>((_, reject) => {
          params.abortSignal?.addEventListener("abort", () => reject(params.abortSignal?.reason), { once: true })
        })
      })
      const done = outcome(h.start().then(collect))
      if (phase !== "before headers") raw.push({ type: "response-metadata", id: "metadata" })
      if (phase === "after commitment") raw.push({ type: "text-start", id: "content" })
      await flush()
      if (phase === "teardown" || phase === "backoff") await h.time.advance(10_000)
      const reason = new DOMException("explicit user stop", "AbortError")
      h.caller.abort(reason)
      acknowledgement.resolve()
      await h.time.advance(1_000)
      expect((await done).error).toBe(reason)
      expect(h.state.error).toBe(reason)
      expect(h.calls[0].params.abortSignal?.aborted).toBe(true)
      await h.time.advance(100_000)
      expect(h.calls).toHaveLength(1)
      expect(h.time.pending()).toEqual([])
      expect(h.state.unknownUsageAttempts).toBe(1)
    },
  )

  test("consumer reader cancellation tears down instead of starting another attempt", async () => {
    const cancelled = Promise.withResolvers<void>()
    const raw = source(() => cancelled.promise)
    const h = harness(async () => ({ stream: raw.stream }))
    const result = h.start()
    raw.push({ type: "text-start", id: "content" })
    const reader = (await result).stream.getReader()
    expect((await reader.read()).value).toEqual({ type: "text-start", id: "content" })
    const cancellation = reader.cancel("consumer stopped")
    await raw.cancelled
    expect(h.calls[0].params.abortSignal?.aborted).toBe(true)
    cancelled.resolve()
    await cancellation
    await h.time.advance(100_000)
    expect(h.calls).toHaveLength(1)
    expect(h.time.pending()).toEqual([])
    expect(h.state.unknownUsageAttempts).toBe(1)
    h.caller.abort()
    await reader.cancel()
    expect(h.state.unknownUsageAttempts).toBe(1)
  })
})

describe("Bedrock unknown usage diagnostics", () => {
  test("a committed error followed by caller cancellation records one unknown-usage attempt", async () => {
    const raw = source()
    const h = harness(async () => ({ stream: raw.stream }))
    const done = outcome(h.start().then(collect))
    raw.push({ type: "text-start", id: "text" })
    await flush()
    raw.push({ type: "error", error: new Error("stream failed before usage") })
    await flush()
    expect(h.state.unknownUsageAttempts).toBe(1)
    h.caller.abort()
    await done
    expect(h.state.unknownUsageAttempts).toBe(1)
    expect(h.calls).toHaveLength(1)
  })

  test("a received finish keeps usage known when the caller cancels before EOF", async () => {
    const raw = source()
    const h = harness(async () => ({ stream: raw.stream }))
    const result = h.start()
    raw.push({ type: "text-start", id: "text" })
    raw.push(finish)
    const reader = (await result).stream.getReader()
    await reader.read()
    expect((await reader.read()).value).toEqual(finish)
    h.caller.abort()
    await outcome(reader.read())
    expect(h.state.unknownUsageAttempts).toBe(0)
    expect(h.calls).toHaveLength(1)
    expect(h.time.pending()).toEqual([])
    reader.releaseLock()
  })
})

describe("Bedrock retry admission", () => {
  test("default-on selection and explicit optout only apply to known Bedrock routes", () => {
    const bedrock = { providerID: "amazon-bedrock", npm: "@ai-sdk/amazon-bedrock", options: {} }
    expect(BedrockRetry.enabled(bedrock)).toBe(true)
    expect(BedrockRetry.enabled({ ...bedrock, options: { noOutputRetries: false } })).toBe(false)
    expect(BedrockRetry.enabled({ ...bedrock, options: { noOutputRetries: true } })).toBe(true)
    expect(BedrockRetry.enabled({ ...bedrock, providerID: "other" })).toBe(false)
    expect(BedrockRetry.enabled({ ...bedrock, npm: "@ai-sdk/anthropic" })).toBe(false)
    expect(BedrockRetry.enabled({ ...bedrock, npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" })).toBe(false)
    expect(
      BedrockRetry.enabled({ ...bedrock, npm: "@ai-sdk/openai", url: "http://bedrock-mantle.us-east-1.api.aws/v1" }),
    ).toBe(false)
    expect(
      BedrockRetry.enabled({
        ...bedrock,
        npm: "@ai-sdk/openai",
        url: "https://bedrock-mantle.us-east-1.api.aws.evil.invalid/v1",
      }),
    ).toBe(false)
    expect(
      BedrockRetry.enabled({ ...bedrock, npm: "@ai-sdk/openai", url: "https://bedrock-mantle.us-east-1.api.aws/v1" }),
    ).toBe(true)
  })

  test("provider-defined tools bypass the helper upfront with untouched params and result", async () => {
    const time = clock()
    const state = BedrockRetry.state()
    const raw = source()
    const caller = new AbortController()
    const params: LanguageModelV3CallOptions = {
      ...prompt,
      abortSignal: caller.signal,
      tools: [{ type: "provider", id: "bedrock.hosted", name: "hosted", args: {} }],
      headers: { "x-fixture": "preserved" },
      providerOptions: { bedrock: { latency: "optimized" } },
    }
    const response = {
      stream: raw.stream,
      request: { body: "untouched" },
      response: { headers: { "x-request-id": "raw" } },
    }
    const called: LanguageModelV3CallOptions[] = []
    const result = await BedrockRetry.stream({
      model: model(async (input) => {
        called.push(input)
        return response
      }),
      params,
      state,
      clock: time.api,
    })
    expect(result).toBe(response)
    expect(called).toEqual([params])
    expect(called[0]).toBe(params)
    expect(called[0].abortSignal).toBe(caller.signal)
    expect(state.active).toBe(false)
    expect(state.attempts).toBe(0)
    await time.advance(100_000)
    expect(called).toHaveLength(1)
    expect(time.pending()).toEqual([])
    await raw.stream.cancel()
  })
})

describe("Bedrock retry fencing before real AI SDK tool hooks", () => {
  test("a tool call resolved on an invalidated deadline cannot reach hooks or execute", async () => {
    const stale = source()
    const current = source()
    const hooks: unknown[] = []
    const executions: unknown[] = []
    const h = harness(async (_params, attempt) => ({ stream: attempt === 1 ? stale.stream : current.stream }))
    const result = streamText({
      model: wrapLanguageModel({
        model: h.model,
        middleware: {
          specificationVersion: "v3",
          wrapStream: ({ model, params }) => BedrockRetry.stream({ model, params, state: h.state, clock: h.time.api }),
        },
      }),
      prompt: "offline invalidated tool race",
      maxRetries: 0,
      tools: {
        lookup: tool({
          inputSchema: z.object({ query: z.string() }),
          onInputAvailable: ({ input }) => {
            hooks.push(input)
          },
          execute: async (input) => {
            executions.push(input)
            return "found"
          },
        }),
      },
    })
    const consumed = result.consumeStream()
    await flush()
    expect(h.calls).toHaveLength(1)
    await h.time.advance(9_999)
    // Resolve the raw read, then invalidate the attempt before its continuation can run.
    stale.push({ ...call, input: '{"query":"stale"}' })
    await h.time.advance(1)
    expect(hooks).toEqual([])
    expect(executions).toEqual([])
    expect(h.state.committed).toBe(false)
    await h.time.advance(100)
    expect(h.calls).toHaveLength(2)
    current.push(call)
    current.push({ ...finish, finishReason: { unified: "tool-calls", raw: "tool_calls" } })
    current.close()
    await consumed
    expect(hooks).toEqual([{ query: "offline" }])
    expect(executions).toEqual([{ query: "offline" }])
    expect(h.calls).toHaveLength(2)
    expect(await result.toolResults).toHaveLength(1)
    expect(h.time.pending()).toEqual([])
  })

  test.each(["onInputStart", "onInputDelta", "onInputAvailable"] as const)(
    "%s can outlive the deadline without duplicate execution",
    async (hook) => {
      const raw = source()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const executed = Promise.withResolvers<void>()
      const executions: unknown[] = []
      const h = harness(async () => ({ stream: raw.stream }))
      const pause = async () => {
        entered.resolve()
        await release.promise
      }
      const result = streamText({
        model: wrapLanguageModel({
          model: h.model,
          middleware: {
            specificationVersion: "v3",
            wrapStream: ({ model, params }) =>
              BedrockRetry.stream({ model, params, state: h.state, clock: h.time.api }),
          },
        }),
        prompt: "offline tool race",
        maxRetries: 0,
        abortSignal: h.caller.signal,
        tools: {
          lookup: tool({
            inputSchema: z.object({ query: z.string() }),
            onInputStart: hook === "onInputStart" ? pause : undefined,
            onInputDelta: hook === "onInputDelta" ? pause : undefined,
            onInputAvailable: hook === "onInputAvailable" ? pause : undefined,
            execute: async (input) => {
              executions.push(input)
              executed.resolve()
              return "found"
            },
          }),
        },
      })
      const consumed = result.consumeStream()
      raw.push({ type: "stream-start", warnings: [] })
      if (hook !== "onInputAvailable") raw.push({ type: "tool-input-start", id: "call-1", toolName: "lookup" })
      if (hook === "onInputDelta") raw.push({ type: "tool-input-delta", id: "call-1", delta: '{"query":"offline"}' })
      if (hook === "onInputAvailable") raw.push(call)
      await entered.promise
      // This barrier is inside the SDK hook, before execute, not a consumer observation after side effects.
      expect(executions).toEqual([])
      expect(h.state.committed).toBe(true)
      expect(h.calls).toHaveLength(1)
      await h.time.advance(100_000)
      expect(h.calls).toHaveLength(1)
      expect(h.calls[0].params.abortSignal?.aborted).toBe(false)
      expect(executions).toEqual([])
      release.resolve()
      if (hook !== "onInputAvailable") {
        raw.push({ type: "tool-input-end", id: "call-1" })
        raw.push(call)
      }
      raw.push({ ...finish, finishReason: { unified: "tool-calls", raw: "tool_calls" } })
      raw.close()
      await executed.promise
      await consumed
      expect(executions).toEqual([{ query: "offline" }])
      expect(h.calls).toHaveLength(1)
      expect(await result.toolResults).toHaveLength(1)
      expect(h.time.pending()).toEqual([])
    },
  )
})
