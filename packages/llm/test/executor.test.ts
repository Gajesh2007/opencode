import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Random, Ref, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LLM, LLMError } from "../src"
import { LLMClient, RequestExecutor } from "../src/route"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { dynamicResponse } from "./lib/http"
import { deltaChunk } from "./lib/openai-chunks"
import { sseRaw } from "./lib/sse"
import { it } from "./lib/effect"

const request = HttpClientRequest.post("https://provider.test/v1/chat?api_key=secret&key=secret&debug=1").pipe(
  HttpClientRequest.setHeaders(Headers.fromInput({ authorization: "Bearer secret", "x-safe": "visible" })),
)

const secretRequest = HttpClientRequest.post("https://provider.test/v1/chat?api_key=query-secret-123&debug=1").pipe(
  HttpClientRequest.setHeaders(Headers.fromInput({ authorization: "Bearer header-secret-456" })),
)

const inputQuota = "quota input-tpm:084828557146:openai.gpt-6.1-sol (InputTokens) exceeded by 119936.47698333337"
const outputQuota = "quota output-tpm:084828557146:openai.gpt-6.1-sol (OutputTokens) exceeded by 119936.47698333337"

const responsesLayer = (responses: ReadonlyArray<Response>) =>
  RequestExecutor.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const cursor = yield* Ref.make(0)
          return Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.gen(function* () {
                const index = yield* Ref.getAndUpdate(cursor, (value) => value + 1)
                return HttpClientResponse.fromWeb(request, responses[index] ?? responses[responses.length - 1])
              }),
            ),
          )
        }),
      ),
    ),
  )

const countedResponsesLayer = (attempts: Ref.Ref<number>, responses: ReadonlyArray<Response>) =>
  RequestExecutor.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const cursor = yield* Ref.make(0)
          return Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.gen(function* () {
                yield* Ref.update(attempts, (value) => value + 1)
                const index = yield* Ref.getAndUpdate(cursor, (value) => value + 1)
                return HttpClientResponse.fromWeb(request, responses[index] ?? responses[responses.length - 1])
              }),
            ),
          )
        }),
      ),
    ),
  )

const randomMidpoint = {
  nextDoubleUnsafe: () => 0.5,
  nextIntUnsafe: () => 0,
}

const expectLLMError = (error: unknown) => {
  expect(error).toBeInstanceOf(LLMError)
  if (!(error instanceof LLMError)) throw new Error("expected LLMError")
  return error
}

const errorHttp = (error: LLMError) => ("http" in error.reason ? error.reason.http : undefined)

describe("RequestExecutor", () => {
  it.effect("returns redacted diagnostics for retryable rate limits", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error).toMatchObject({
        retryable: true,
        retryAfterMs: 0,
        reason: {
          _tag: "RateLimit",
          rateLimit: { retryAfterMs: 0 },
          http: {
            requestId: "req_123",
            request: {
              method: "POST",
              url: "https://provider.test/v1/chat?api_key=%3Credacted%3E&key=%3Credacted%3E&debug=1",
              headers: { authorization: "<redacted>", "x-safe": "visible" },
            },
            response: {
              status: 429,
              headers: {
                "retry-after-ms": "0",
                "x-request-id": "req_123",
                "x-api-key": "<redacted>",
              },
            },
          },
        },
      })
      expect(errorHttp(error)?.body).toBe("rate limited")
    }).pipe(
      Effect.provide(
        responsesLayer(
          Array.from(
            { length: 3 },
            () =>
              new Response("rate limited", {
                status: 429,
                headers: { "retry-after-ms": "0", "x-request-id": "req_123", "x-api-key": "secret" },
              }),
          ),
        ),
      ),
    ),
  )

  it.effect("classifies token quotas as retryable without replay when RetryLimit is zero", () =>
    Effect.forEach(
      [
        inputQuota,
        outputQuota,
        JSON.stringify({ error: { code: "quota_exceeded", message: inputQuota } }),
        JSON.stringify({ error: { code: "quota_exceeded", message: outputQuota } }),
        JSON.stringify({ error: { code: "quota_exceeded", message: "Tokens per minute limit exceeded" } }),
        JSON.stringify({ error: { code: "quota_exceeded", message: "TPM limit exceeded" } }),
        "quota input_tpm exceeded",
        "quota output tpm exceeded",
        "quota tokens/min exceeded",
      ],
      (body) =>
        Effect.gen(function* () {
          const attempts = yield* Ref.make(0)
          const error = yield* Effect.flatMap(RequestExecutor.Service, (executor) => executor.execute(request)).pipe(
            Effect.provide(countedResponsesLayer(attempts, [new Response(body, { status: 429 })])),
            Effect.provideService(RequestExecutor.RetryLimit, 0),
            Effect.flip,
          )

          expectLLMError(error)
          expect(error).toMatchObject({
            retryable: true,
            retryAfterMs: 60_000,
            reason: { _tag: "RateLimit" },
          })
          expect(yield* Ref.get(attempts)).toBe(1)
        }),
    ),
  )

  it.effect("does not retry permanent quota errors even when they mention token capacity", () =>
    Effect.forEach(
      [
        JSON.stringify({ error: { code: "quota_exceeded", message: "Account quota exceeded" } }),
        JSON.stringify({ error: { code: "quota_exceeded", message: "Requests per minute exceeded" } }),
        JSON.stringify({ error: { code: "insufficient_quota", message: inputQuota } }),
        JSON.stringify({ error: { code: "billing_hard_limit_reached", message: outputQuota } }),
        `Payment required: ${inputQuota}`,
        `Insufficient credits: ${inputQuota}`,
        `Your credit balance is too low: ${outputQuota}`,
        `Your credits have been exhausted: ${inputQuota}`,
        `Spending limit reached: ${outputQuota}`,
      ],
      (body) =>
        Effect.gen(function* () {
          const attempts = yield* Ref.make(0)
          const error = yield* Effect.flatMap(RequestExecutor.Service, (executor) => executor.execute(request)).pipe(
            Effect.provide(
              countedResponsesLayer(attempts, [
                new Response(body, { status: 429, headers: { "retry-after": "0" } }),
                new Response("should not retry", { status: 200 }),
              ]),
            ),
            Effect.flip,
          )

          expectLLMError(error)
          expect(error).toMatchObject({ retryable: false, reason: { _tag: "QuotaExceeded" } })
          expect(yield* Ref.get(attempts)).toBe(1)
        }),
    ),
  )

  it.effect("honors current redacted header names in diagnostics", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(errorHttp(error)?.request.headers["x-safe"]).toBe("<redacted>")
      expect(errorHttp(error)?.response?.headers["x-safe"]).toBe("<redacted>")
    }).pipe(
      Effect.provide(responsesLayer([new Response("bad", { status: 400, headers: { "x-safe": "response-secret" } })])),
      Effect.provideService(Headers.CurrentRedactedNames, ["x-safe"]),
    ),
  )

  it.effect("extracts OpenAI-style rate-limit diagnostics", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "RateLimit" })
      expect(error.reason._tag === "RateLimit" ? error.reason.rateLimit : undefined).toEqual({
        retryAfterMs: 0,
        limit: { requests: "500", tokens: "30000" },
        remaining: { requests: "499", tokens: "29900" },
        reset: { requests: "1s", tokens: "10s" },
      })
    }).pipe(
      Effect.provide(
        responsesLayer(
          Array.from(
            { length: 3 },
            () =>
              new Response("rate limited", {
                status: 429,
                headers: {
                  "retry-after-ms": "0",
                  "x-ratelimit-limit-requests": "500",
                  "x-ratelimit-limit-tokens": "30000",
                  "x-ratelimit-remaining-requests": "499",
                  "x-ratelimit-remaining-tokens": "29900",
                  "x-ratelimit-reset-requests": "1s",
                  "x-ratelimit-reset-tokens": "10s",
                },
              }),
          ),
        ),
      ),
    ),
  )

  it.effect("extracts Anthropic-style rate-limit diagnostics", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "ProviderInternal" })
      expect(errorHttp(error)?.rateLimit).toEqual({
        retryAfterMs: 0,
        limit: { requests: "100", "input-tokens": "10000" },
        remaining: { requests: "12", "input-tokens": "9000" },
        reset: { requests: "2026-05-06T12:00:00Z", "input-tokens": "2026-05-06T12:00:10Z" },
      })
    }).pipe(
      Effect.provide(
        responsesLayer(
          Array.from(
            { length: 3 },
            () =>
              new Response("overloaded", {
                status: 529,
                headers: {
                  "retry-after-ms": "0",
                  "anthropic-ratelimit-requests-limit": "100",
                  "anthropic-ratelimit-requests-remaining": "12",
                  "anthropic-ratelimit-requests-reset": "2026-05-06T12:00:00Z",
                  "anthropic-ratelimit-input-tokens-limit": "10000",
                  "anthropic-ratelimit-input-tokens-remaining": "9000",
                  "anthropic-ratelimit-input-tokens-reset": "2026-05-06T12:00:10Z",
                },
              }),
          ),
        ),
      ),
    ),
  )

  it.effect("retries retryable status responses before returning the stream", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const response = yield* executor.execute(request)

      expect(response.status).toBe(200)
      expect(yield* response.text).toBe("ok")
    }).pipe(
      Effect.provide(
        responsesLayer([
          new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } }),
          new Response("ok", { status: 200 }),
        ]),
      ),
    ),
  )

  it.effect("marks 504 and 529 status responses retryable", () =>
    Effect.gen(function* () {
      const failWith = (status: number) =>
        Effect.gen(function* () {
          const executor = yield* RequestExecutor.Service
          const error = yield* executor.execute(request).pipe(Effect.flip)

          expectLLMError(error)
          expect(error.reason).toMatchObject({ _tag: "ProviderInternal", status })
          expect(error.retryable).toBe(true)
        }).pipe(
          Effect.provide(
            responsesLayer(
              Array.from(
                { length: 3 },
                () =>
                  new Response("retry", {
                    status,
                    headers: { "retry-after-ms": "0" },
                  }),
              ),
            ),
          ),
        )

      yield* failWith(504)
      yield* failWith(529)
    }),
  )

  it.effect("does not retry non-retryable status responses and truncates large bodies", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "Authentication" })
      expect(error.retryable).toBe(false)
      expect(errorHttp(error)?.bodyTruncated).toBe(true)
      expect(errorHttp(error)?.body).toHaveLength(16_384)
    }).pipe(
      Effect.provide(
        responsesLayer([
          new Response("x".repeat(20_000), { status: 401 }),
          new Response("should not retry", { status: 200 }),
        ]),
      ),
    ),
  )

  it.effect("redacts common secret fields in response bodies", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(errorHttp(error)?.body).toContain('"key":"<redacted>"')
      expect(errorHttp(error)?.body).toContain("api_key=<redacted>")
      expect(errorHttp(error)?.body).not.toContain("body-secret")
      expect(errorHttp(error)?.body).not.toContain("query-secret")
    }).pipe(
      Effect.provide(
        responsesLayer([
          new Response('{"error":{"message":"bad","key":"body-secret","detail":"api_key=query-secret"}}', {
            status: 400,
          }),
        ]),
      ),
    ),
  )

  it.effect("redacts echoed request secret values in response bodies", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(secretRequest).pipe(Effect.flip)

      expectLLMError(error)
      expect(errorHttp(error)?.body).toContain("provider echoed <redacted>")
      expect(errorHttp(error)?.body).toContain("authorization <redacted>")
      expect(errorHttp(error)?.body).not.toContain("query-secret-123")
      expect(errorHttp(error)?.body).not.toContain("header-secret-456")
    }).pipe(
      Effect.provide(
        responsesLayer([
          new Response("provider echoed query-secret-123 and authorization header-secret-456", { status: 400 }),
        ]),
      ),
    ),
  )

  it.effect("honors Retry-After delta seconds before retrying", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      return yield* Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        const fiber = yield* executor.execute(request).pipe(Effect.forkChild)

        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(1)

        yield* TestClock.adjust(1_999)
        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(1)

        yield* TestClock.adjust(1)
        const response = yield* Fiber.join(fiber)

        expect(response.status).toBe(200)
        expect(yield* Ref.get(attempts)).toBe(2)
      }).pipe(
        Effect.provide(
          countedResponsesLayer(attempts, [
            new Response("busy", { status: 503, headers: { "retry-after": "2" } }),
            new Response("ok", { status: 200 }),
          ]),
        ),
      )
    }),
  )

  it.effect("uses the token reset delay for invalid headers and never caps valid Retry-After", () => {
    const cases: Array<{ headers: Record<string, string>; delay: number; status?: number }> = [
      { headers: {}, delay: 60_000 },
      { headers: { "retry-after": "" }, delay: 60_000 },
      { headers: { "retry-after": "not a delay" }, delay: 60_000 },
      { headers: { "retry-after": "-1" }, delay: 60_000 },
      { headers: { "retry-after": "Infinity" }, delay: 60_000 },
      { headers: { "retry-after": "1e308" }, delay: 60_000 },
      { headers: { "retry-after-ms": " " }, delay: 60_000 },
      { headers: { "retry-after-ms": "-1" }, delay: 60_000 },
      { headers: { "retry-after-ms": "Infinity" }, delay: 60_000 },
      { headers: { "retry-after-ms": "not a delay" }, delay: 60_000 },
      { headers: { "retry-after": "5.5" }, delay: 5_500 },
      { headers: { "retry-after": "90" }, delay: 90_000 },
      { headers: { "retry-after-ms": "12500", "retry-after": "90" }, delay: 12_500 },
      { headers: { "retry-after-ms": "bad", "retry-after": "75" }, delay: 75_000 },
      { headers: { "retry-after": "Thu, 01 Jan 1970 00:01:30 GMT" }, delay: 90_000 },
      { headers: { "retry-after": "90" }, delay: 90_000, status: 503 },
    ]
    return Effect.forEach(cases, (input) =>
      Effect.gen(function* () {
        const attempts = yield* Ref.make(0)
        yield* TestClock.setTime(0)
        yield* Effect.gen(function* () {
          const executor = yield* RequestExecutor.Service
          const fiber = yield* executor.execute(request).pipe(Effect.forkChild)

          yield* Effect.yieldNow
          expect(yield* Ref.get(attempts)).toBe(1)

          yield* TestClock.adjust(input.delay - 1)
          yield* Effect.yieldNow
          expect(yield* Ref.get(attempts)).toBe(1)

          yield* TestClock.adjust(1)
          const response = yield* Fiber.join(fiber)
          expect(response.status).toBe(200)
          expect(yield* Ref.get(attempts)).toBe(2)
        }).pipe(
          Effect.provide(
            countedResponsesLayer(attempts, [
              new Response(input.status === 503 ? "busy" : inputQuota, {
                status: input.status ?? 429,
                headers: input.headers,
              }),
              new Response("ok", { status: 200 }),
            ]),
          ),
        )
      }),
    )
  })

  it.effect("uses exponential jittered delay when retry-after is absent", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      return yield* Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        const fiber = yield* executor.execute(request).pipe(Effect.flip, Effect.forkChild)

        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(1)

        yield* TestClock.adjust(499)
        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(1)

        yield* TestClock.adjust(1)
        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(2)

        yield* TestClock.adjust(999)
        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(2)

        yield* TestClock.adjust(1)
        const error = yield* Fiber.join(fiber)

        expectLLMError(error)
        expect(error.reason).toMatchObject({ _tag: "ProviderInternal" })
        expect(yield* Ref.get(attempts)).toBe(3)
      }).pipe(
        Effect.provide(
          countedResponsesLayer(attempts, [
            new Response("busy", { status: 503 }),
            new Response("still busy", { status: 503 }),
            new Response("done retrying", { status: 503 }),
          ]),
        ),
      )
    }).pipe(Effect.provideService(Random.Random, randomMidpoint)),
  )

  it.effect("does not retry after a successful response reaches stream parsing", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "gpt-4o-mini" })
      const error = yield* LLMClient.generate(LLM.request({ model, prompt: "Say hello." })).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Ref.update(attempts, (value) => value + 1).pipe(
              Effect.as(
                input.respond(
                  sseRaw(
                    `data: ${JSON.stringify(deltaChunk({ role: "assistant", content: "Hello" }))}`,
                    "data: not-json",
                  ),
                  { headers: { "content-type": "text/event-stream" } },
                ),
              ),
            ),
          ),
        ),
        Effect.flip,
      )

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "InvalidProviderOutput" })
      expect(yield* Ref.get(attempts)).toBe(1)
    }),
  )

  it.effect("disables retries per stream while preserving the captured client's default retry limit", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const input = LLM.request({
        model: OpenAIChat.route.model({ id: "test", provider: "test" }),
        prompt: "Hello",
      })
      yield* Effect.gen(function* () {
        const client = yield* LLMClient.Service
        const error = yield* client
          .stream(input)
          .pipe(Stream.provideService(RequestExecutor.RetryLimit, 0), Stream.runDrain, Effect.flip)
        expectLLMError(error)
        expect(error.retryable).toBe(true)
        expect(yield* Ref.get(attempts)).toBe(1)

        const retried = yield* client.stream(input).pipe(Stream.runDrain, Effect.flip)
        expectLLMError(retried)
        expect(retried.retryable).toBe(true)
        expect(yield* Ref.get(attempts)).toBe(4)
      }).pipe(
        Effect.provide(
          LLMClient.layer.pipe(
            Layer.provide(
              countedResponsesLayer(
                attempts,
                Array.from({ length: 4 }, () => new Response("busy", { status: 503, headers: { "retry-after": "0" } })),
              ),
            ),
          ),
        ),
      )
    }),
  )
})
