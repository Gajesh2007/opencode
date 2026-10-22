import { describe, expect, test } from "bun:test"
import type { NamedError } from "@opencode-ai/core/util/error"
import { APICallError } from "ai"
import { setTimeout as sleep } from "node:timers/promises"
import { Clock, Deferred, Effect, Fiber, Layer, Schedule, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderID } from "../../src/provider/schema"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const providerID = ProviderID.make("test")
const retryProvider = "test"
const it = testEffect(Layer.mergeAll(SessionStatus.defaultLayer, CrossSpawnSpawner.defaultLayer))
const tokenQuotas = [
  "quota input-tpm:123456789012:openai.gpt-6.1-sol (InputTokens) exceeded by 119936.47698333337",
  "quota output-tpm:123456789012:openai.gpt-6.1-sol (OutputTokens) exceeded by 1000",
  "Rate limit reached on tokens per minute (TPM)",
]

function apiError(headers?: Record<string, string>, message = "boom"): MessageV2.APIError {
  return Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
    new MessageV2.APIError({
      message,
      isRetryable: true,
      responseHeaders: headers,
    }).toObject(),
  )
}

function wrap(message: unknown): ReturnType<NamedError["toObject"]> {
  return { name: "", data: { message } }
}

describe("session.retry.delay", () => {
  test("caps delay at 30 seconds when headers missing", () => {
    const error = apiError()
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("uses retry-after values even when exceeding 10 minutes with headers", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)

    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.delay(1, longError)).toBe(700000)
  })

  test("caps oversized header delays to the runtime timer limit", () => {
    const error = apiError({ "retry-after-ms": "999999999999" })
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.RETRY_MAX_DELAY)
  })

  test.each(tokenQuotas)("waits a minute for token capacity: %s", (message) => {
    for (const attempt of [1, 5, 10]) {
      expect(SessionRetry.delay(attempt, wrap(message))).toBe(60_000)
      expect(SessionRetry.delay(attempt, apiError(undefined, message))).toBe(60_000)
    }
  })

  test("uses the minute fallback with unrelated or invalid headers", () => {
    const cases: Record<string, string>[] = [
      {},
      { "content-type": "application/json" },
      { "retry-after": "invalid" },
      { "retry-after": "-1" },
      { "retry-after": "" },
      { "retry-after-ms": "Infinity" },
      { "retry-after-ms": "1500ms" },
    ]
    for (const headers of cases) {
      expect(SessionRetry.delay(1, apiError(headers, tokenQuotas[0]), 0)).toBe(60_000)
    }
  })

  test("honors case-insensitive token quota retry headers before the fallback", () => {
    for (const [headers, expected] of [
      [{ "Retry-After": "75" }, 75_000],
      [{ "Retry-After-Ms": "1500", "Retry-After": "30" }, 1500],
      [{ "retry-after-ms": "-1", "retry-after": "30" }, 30_000],
      [{ "retry-after-ms": "0" }, 0],
    ] as const) {
      expect(SessionRetry.delay(1, apiError(headers, tokenQuotas[0]))).toBe(expected)
    }
    const now = Date.UTC(2026, 0, 1)
    expect(
      SessionRetry.delay(1, apiError({ "Retry-After": new Date(now + 90_000).toUTCString() }, tokenQuotas[0]), now),
    ).toBe(90_000)
  })

  for (const kind of ["plain", "api"] as const) {
    it.effect(`policy retries ${kind} token quota failures after the minute resets`, () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        const now = yield* Clock.currentTimeMillis
        const calls: number[] = []
        const updates: { message: string; next: number }[] = []
        const failure =
          kind === "plain"
            ? new Error(tokenQuotas[0])
            : new APICallError({
                message: "Too Many Requests",
                url: "https://offline.invalid",
                requestBodyValues: {},
                statusCode: 429,
                isRetryable: false,
                responseBody: JSON.stringify({ error: { code: "quota_exceeded", message: tokenQuotas[1] } }),
              })
        const fiber = yield* Effect.gen(function* () {
          calls.push(yield* Clock.currentTimeMillis)
          if (calls.length === 1) return yield* Effect.fail(failure)
          return "answer"
        }).pipe(
          Effect.retry(
            SessionRetry.policy({
              provider: retryProvider,
              parse: (error) => MessageV2.fromError(error, { providerID }),
              set: (info) =>
                Effect.gen(function* () {
                  updates.push(info)
                  yield* Deferred.succeed(ready, undefined)
                }),
            }),
          ),
          Effect.forkChild,
        )
        yield* Deferred.await(ready)
        expect(calls).toEqual([now])
        expect(updates).toHaveLength(1)
        expect(updates[0].next).toBe(now + 60_000)

        yield* TestClock.adjust(59_999)
        expect(calls).toHaveLength(1)
        yield* TestClock.adjust(1)
        expect(yield* Fiber.join(fiber)).toBe("answer")
        expect(calls).toEqual([now, now + 60_000])
      }),
    )
  }

  it.live("policy updates retry status and increments attempts", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionID = SessionID.make("session-retry-test")
        const error = apiError({ "retry-after-ms": "0" })
        const status = yield* SessionStatus.Service

        const step = yield* Schedule.toStepWithMetadata(
          SessionRetry.policy({
            provider: "test",
            parse: Schema.decodeUnknownSync(MessageV2.APIError.Schema),
            set: (info) =>
              status.set(sessionID, {
                type: "retry",
                attempt: info.attempt,
                message: info.message,
                next: info.next,
              }),
          }),
        )
        yield* step(error)
        yield* step(error)

        expect(yield* status.get(sessionID)).toMatchObject({
          type: "retry",
          attempt: 2,
          message: "boom",
        })
      }),
    ),
  )
})

describe("session.retry.retryable", () => {
  test("maps too_many_requests json messages", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Too Many Requests" })
  })

  test("maps overloaded provider codes", () => {
    const error = wrap(JSON.stringify({ code: "resource_exhausted" }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Provider is overloaded" })
  })

  test("does not retry unknown json messages", () => {
    const error = wrap(JSON.stringify({ error: { message: "no_kv_space" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("does not throw on numeric error codes", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { code: 123 } }))
    const result = SessionRetry.retryable(error, retryProvider)
    expect(result).toBeUndefined()
  })

  test("returns undefined for non-json message", () => {
    const error = wrap("not-json")
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries plain text rate limit errors from Alibaba", () => {
    const msg =
      "Upstream error from Alibaba: Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time."
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test("retries plain text rate limit errors", () => {
    const msg = "Rate limit exceeded, please try again later"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test.each(tokenQuotas)("retries parsed plain token quota errors: %s", (message) => {
    const error = MessageV2.fromError(new Error(message), { providerID })
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message })
  })

  test("recognizes token capacity in the API error body even without a retryable status", () => {
    const error = MessageV2.fromError(
      new APICallError({
        message: "Provider quota failure",
        url: "https://offline.invalid",
        requestBodyValues: {},
        isRetryable: false,
        responseBody: JSON.stringify({ error: { code: "quota_exceeded", message: tokenQuotas[0] } }),
      }),
      { providerID },
    )
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({
      message: expect.stringContaining("Provider quota failure"),
    })
    expect(SessionRetry.delay(1, error)).toBe(60_000)
  })

  test.each([
    "You exceeded your current quota, please check your plan and billing details",
    "Your credit balance is too low",
    "Insufficient credits",
    "Your credits have been exhausted",
    "billing_hard_limit_reached",
    "payment_required",
    "spend_limit_exceeded",
    "Monthly token quota exceeded",
    `insufficient_quota: ${tokenQuotas[0]}`,
  ])("does not retry permanent quota failures: %s", (message) => {
    expect(SessionRetry.retryable(wrap(`${message}. Please try again.`), retryProvider)).toBeUndefined()
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Too Many Requests",
        statusCode: 429,
        isRetryable: true,
        responseBody: JSON.stringify({ error: { message } }),
      }).toObject(),
    )
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("token quota wording does not override fatal authentication status", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({ message: tokenQuotas[0], statusCode: 403, isRetryable: false }).toObject(),
    )
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries too many requests in plain text", () => {
    const msg = "Too many requests, please slow down"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: msg })
  })

  test("does not retry context overflow errors", () => {
    const error = new MessageV2.ContextOverflowError({
      message: "Input exceeds context window of this model",
      responseBody: '{"error":{"code":"context_length_exceeded"}}',
    }).toObject()

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries 500 errors even when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Internal server error",
        isRetryable: false,
        statusCode: 500,
        responseBody: '{"type":"api_error","message":"Internal server error"}',
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Internal server error" })
  })

  test("retries 502 bad gateway errors", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Bad gateway",
        isRetryable: false,
        statusCode: 502,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Bad gateway" })
  })

  test("retries 503 service unavailable errors", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Service unavailable",
        isRetryable: false,
        statusCode: 503,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Service unavailable" })
  })

  test("does not retry 4xx errors when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Bad request",
        isRetryable: false,
        statusCode: 400,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries 429 rate limit status even when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Too Many Requests",
        isRetryable: false,
        statusCode: 429,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Too Many Requests" })
  })

  test("retries gateway internal server errors that arrive without a status", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Internal server error",
        isRetryable: false,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Internal server error" })
  })

  test("does not retry fatal 4xx errors even with a transient-looking message", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Service unavailable for your plan",
        isRetryable: false,
        statusCode: 403,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries plain-text gateway internal server errors (Unknown)", () => {
    const msg = "Vercel AI Gateway: internal server error"
    expect(SessionRetry.retryable(wrap(msg), retryProvider)).toEqual({ message: msg })
  })

  test("retries plain-text transient network failures (Unknown)", () => {
    for (const msg of ["fetch failed", "socket hang up", "ETIMEDOUT", "Connection reset by peer", "bad gateway"]) {
      expect(SessionRetry.retryable(wrap(msg), retryProvider)).toEqual({ message: msg })
    }
  })

  test("does not retry plain-text fatal errors (Unknown)", () => {
    for (const msg of ["invalid api key", "model not found", "unsupported parameter"]) {
      expect(SessionRetry.retryable(wrap(msg), retryProvider)).toBeUndefined()
    }
  })

  test("retries ZlibError decompression failures", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Response decompression failed",
        isRetryable: true,
        metadata: { code: "ZlibError" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "Response decompression failed" })
  })

  test("maps free limits to Go upsell action", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Free usage exceeded",
        isRetryable: true,
        statusCode: 429,
        responseBody: JSON.stringify({
          type: "error",
          error: { type: "FreeUsageLimitError", message: "Free usage exceeded" },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "opencode")).toEqual({
      message: SessionRetry.GO_UPSELL_MESSAGE,
      action: {
        reason: "free_tier_limit",
        provider: "opencode",
        title: "Free limit reached",
        message: "Subscribe to OpenCode Go for reliable access to the best open-source models, starting at $5/month.",
        label: "subscribe",
        link: SessionRetry.GO_UPSELL_URL,
      },
    })
  })

  test("maps Go subscription limits to workspace PAYG upsell", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Subscription quota exceeded. You can continue using free models.",
        isRetryable: true,
        statusCode: 429,
        responseHeaders: {
          "retry-after": "19380",
        },
        responseBody: JSON.stringify({
          type: "error",
          error: {
            type: "GoUsageLimitError",
            message: "Subscription quota exceeded. You can continue using free models.",
          },
          metadata: {
            workspace: "wrk_01K6XGM22R6FM8JVABE9XDQXGH",
            limitName: "5 hour",
          },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "opencode-go")).toEqual({
      message:
        "5 hour usage limit reached. It will reset in 5 hours 23 minutes. To continue using this model now, enable usage from your available balance - https://opencode.ai/workspace/wrk_01K6XGM22R6FM8JVABE9XDQXGH/go",
      action: {
        reason: "account_rate_limit",
        provider: "opencode-go",
        title: "Go limit reached",
        message:
          "5 hour usage limit reached. It will reset in 5 hours 23 minutes. To continue using this model now, enable usage from your available balance",
        label: "open settings",
        link: "https://opencode.ai/workspace/wrk_01K6XGM22R6FM8JVABE9XDQXGH/go",
      },
    })
  })

  test("maps Go subscription limits without limit metadata", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Subscription quota exceeded. You can continue using free models.",
        isRetryable: true,
        statusCode: 429,
        responseHeaders: {
          "retry-after": "900",
        },
        responseBody: JSON.stringify({
          type: "error",
          error: {
            type: "GoUsageLimitError",
            message: "Subscription quota exceeded. You can continue using free models.",
          },
          metadata: {
            workspace: "wrk_01K6XGM22R6FM8JVABE9XDQXGH",
          },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "opencode-go")?.action?.message).toBe(
      "Usage limit reached. It will reset in 15 minutes. To continue using this model now, enable usage from your available balance",
    )
  })
})

describe("session.message-v2.fromError", () => {
  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(_req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID })

      expect(MessageV2.APIError.isInstance(result)).toBe(true)
      if (!MessageV2.APIError.isInstance(result)) throw new Error("expected APIError")
      expect(result.data.isRetryable).toBe(true)
      expect(result.data.message).toBe("Connection reset by server")
      expect(result.data.metadata?.code).toBe("ECONNRESET")
      expect(result.data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Connection reset by server",
        isRetryable: true,
        metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "Connection reset by server" })
  })

  test("marks OpenAI 404 status codes as retryable", () => {
    const error = new APICallError({
      message: "boom",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":"boom"}',
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID: ProviderID.make("openai") })
    if (!MessageV2.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
  })

  test("converts OpenAI server_error stream chunks to retryable APIError", () => {
    const result = MessageV2.fromError(
      {
        message: JSON.stringify({
          type: "error",
          sequence_number: 2,
          error: {
            type: "server_error",
            code: "server_error",
            message: "An error occurred while processing your request.",
            param: null,
          },
        }),
      },
      { providerID: ProviderID.make("openai") },
    )

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    if (!MessageV2.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
    expect(SessionRetry.retryable(result, retryProvider)).toEqual({
      message: "An error occurred while processing your request.",
    })
  })
})
