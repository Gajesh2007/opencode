import { describe, expect, spyOn } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient, HttpClientRequest } from "effect/unstable/http"
import { LLM } from "../src"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { Auth, LLMClient, RequestExecutor } from "../src/route"
import type { Interface } from "../src/route/client"
import { testEffect, it } from "./lib/effect"
import { dynamicResponse } from "./lib/http"

const request = LLM.request({
  model: OpenAIChat.route.model({ id: "test", provider: "test" }),
  prompt: "Hello",
})

const runtime = LLMClient.layer.pipe(
  Layer.provide(Layer.succeed(RequestExecutor.Service, { execute: () => Effect.die("Unexpected HTTP request") })),
)

describe("LLMClient.preconnect", () => {
  testEffect(runtime).effect("compiles the same endpoint, auth, body and options without executing frames", () =>
    Effect.gen(function* () {
      const prepared: HttpClientRequest.HttpClientRequest[] = []
      const resolved: unknown[] = []
      const transport = OpenAIChat.route.transport
      const route = OpenAIChat.route.with({
        endpoint: { baseURL: "https://example.test/v1", query: { base: "1" } },
        auth: Auth.bearer("secret"),
        generation: { maxTokens: 20 },
        http: { headers: { "x-default": "default" }, body: { metadata: { base: true } } },
        transport: {
          ...transport,
          preconnect: (input, request) =>
            Effect.sync(() => {
              prepared.push(input.request)
              resolved.push(request)
            }),
          frames: (input, request) => {
            prepared.push(input.request)
            resolved.push(request)
            return Stream.empty
          },
        },
      })
      const input = LLM.request({
        model: route.model({ id: "test", provider: "test" }),
        prompt: "Hello",
        http: { query: { request: "2" }, headers: { "x-request": "request" } },
      })
      yield* LLMClient.preconnect(input)
      expect(prepared).toHaveLength(1)
      yield* LLMClient.stream(input).pipe(Stream.runDrain)
      expect(prepared[0]).toEqual(prepared[1])
      expect(resolved[0]).toEqual(resolved[1])
      expect(prepared[0]?.url).toBe("https://example.test/v1/chat/completions?base=1&request=2")
      expect(prepared[0]?.headers.authorization).toBe("Bearer secret")
      expect(prepared[0]?.headers["x-default"]).toBe("default")
      expect(prepared[0]?.headers["x-request"]).toBe("request")
    }),
  )

  testEffect(runtime).effect("preserves authentication compilation errors before calling a hook", () =>
    Effect.gen(function* () {
      const route = OpenAIChat.route.with({
        auth: Auth.bearer(""),
        transport: { ...OpenAIChat.route.transport, preconnect: () => Effect.die("Unexpected hook") },
      })
      const input = LLM.request({ model: route.model({ id: "test", provider: "test" }), prompt: "Hello" })
      const expected = yield* LLMClient.prepare(input).pipe(Effect.flip)
      const actual = yield* LLMClient.preconnect(input).pipe(Effect.flip)
      expect(actual).toEqual(expected)
    }),
  )

  testEffect(runtime).effect("treats a transport without a hook as a no-op", () =>
    Effect.gen(function* () {
      const route = OpenAIChat.route.with({
        transport: {
          id: "no-hook",
          prepare: OpenAIChat.route.transport.prepare,
          frames: () => Stream.die("Unexpected frames"),
        },
      })
      yield* LLMClient.preconnect(
        LLM.request({ model: route.model({ id: "test", provider: "test" }), prompt: "Hello" }),
      )
    }),
  )

  it.effect("keeps older client implementations valid", () => {
    const client: Interface = {
      prepare: LLMClient.prepare,
      stream: () => Stream.empty,
      generate: () => Effect.die("Unexpected generate"),
    }
    return LLMClient.preconnect(request).pipe(Effect.provideService(LLMClient.Service, client))
  })

  testEffect(dynamicResponse(() => Effect.die("Unexpected custom HTTP request"))).effect(
    "does not bypass a custom HTTP client",
    () =>
      Effect.gen(function* () {
        const preconnect = yield* Effect.acquireRelease(
          Effect.sync(() => spyOn(globalThis.fetch, "preconnect").mockImplementation(() => {})),
          (spy) => Effect.sync(() => spy.mockRestore()),
        )
        yield* LLMClient.preconnect(request)
        expect(preconnect).not.toHaveBeenCalled()
      }),
  )
})

describe("default HTTP preconnect", () => {
  testEffect(RequestExecutor.defaultLayer).effect(
    "warms only an HTTP origin without sending headers or a request",
    () =>
      Effect.gen(function* () {
        const preconnect = yield* Effect.acquireRelease(
          Effect.sync(() => spyOn(globalThis.fetch, "preconnect").mockImplementation(() => {})),
          (spy) => Effect.sync(() => spy.mockRestore()),
        )
        const executor = yield* RequestExecutor.Service
        yield* executor.preconnect?.(HttpClientRequest.post("https://example.test/path?secret=hidden")) ?? Effect.void
        expect(preconnect.mock.calls).toEqual([["https://example.test"]])
        yield* executor.preconnect?.(HttpClientRequest.post("ftp://example.test/path")) ?? Effect.void
        yield* executor.preconnect?.(HttpClientRequest.post("not a URL")) ?? Effect.void
        expect(preconnect).toHaveBeenCalledTimes(1)
      }),
  )

  testEffect(RequestExecutor.defaultLayer).effect("does not bypass a custom fetch override", () =>
    Effect.gen(function* () {
      const preconnect = yield* Effect.acquireRelease(
        Effect.sync(() => spyOn(globalThis.fetch, "preconnect").mockImplementation(() => {})),
        (spy) => Effect.sync(() => spy.mockRestore()),
      )
      const executor = yield* RequestExecutor.Service
      const fetch: typeof globalThis.fetch = Object.assign(
        () => Promise.reject(new Error("Unexpected custom fetch request")),
        {
          preconnect: () => {
            throw new Error("Unexpected custom fetch preconnect")
          },
        },
      )
      yield* (executor.preconnect?.(HttpClientRequest.post("https://example.test/path")) ?? Effect.void).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      )
      expect(preconnect).not.toHaveBeenCalled()
    }),
  )

  testEffect(RequestExecutor.defaultLayer).effect("skips custom fetch options and reports preconnect errors", () =>
    Effect.gen(function* () {
      const preconnect = yield* Effect.acquireRelease(
        Effect.sync(() =>
          spyOn(globalThis.fetch, "preconnect").mockImplementation(() => {
            throw new Error("failure")
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      )
      const executor = yield* RequestExecutor.Service
      yield* (executor.preconnect?.(HttpClientRequest.post("https://example.test/path")) ?? Effect.void).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }),
      )
      expect(preconnect).not.toHaveBeenCalled()
      const error = yield* (
        executor.preconnect?.(HttpClientRequest.post("https://example.test/path")) ?? Effect.void
      ).pipe(Effect.flip)
      expect(error).toMatchObject({ module: "RequestExecutor", method: "preconnect", reason: { _tag: "Transport" } })
    }),
  )
})
