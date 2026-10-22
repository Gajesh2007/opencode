import type { Auth } from "@/auth"
import type { Provider } from "@/provider/provider"
import { ProviderID } from "@/provider/schema"
import { ProviderTransform } from "@/provider/transform"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { asSchema, type ModelMessage, type Tool } from "ai"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { FetchHttpClient } from "effect/unstable/http"
import { tool as nativeTool, ToolFailure, LLMError, type JsonSchema, type LLMEvent } from "@opencode-ai/llm"
import type { LLMClientShape } from "@opencode-ai/llm/route"
import { LLMNative } from "./native-request"
import * as Continuation from "./continuation"
import { codexNativeAuth } from "@/plugin/codex"
import { readOnlyTools } from "./tool-execution"

export const createContinuationState = Continuation.createContinuationState

export type RuntimeStatus =
  | { readonly type: "supported"; readonly apiKey: string; readonly baseURL?: string }
  | { readonly type: "unsupported"; readonly reason: string }
export type StreamResult =
  | { readonly type: "supported"; readonly stream: Stream.Stream<LLMEvent, unknown> }
  | { readonly type: "unsupported"; readonly reason: string }

export type StreamInput = {
  readonly continuation?: Continuation.ContinuationState
  readonly sessionID?: string
  readonly previousResponseId?: string
  readonly model: Provider.Model
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly llmClient: LLMClientShape
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly toolChoice?: "auto" | "required" | "none"
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxOutputTokens?: number
  readonly providerOptions?: Record<string, any>
  readonly headers: Record<string, string>
  readonly abort: AbortSignal
}

export function status(input: Pick<StreamInput, "model" | "provider" | "auth">): RuntimeStatus {
  return statusWithFetch(input, providerFetch(input))
}

// Only the explicitly selected premium tier on the public API gets an
// automatic native path. Read the flat pre-transform options used by the
// request builder so eligibility agrees with the tier actually sent.
export function autoNative(input: Pick<StreamInput, "model" | "provider" | "auth" | "providerOptions">): boolean {
  if (input.model.providerID !== ProviderID.openai || input.provider.id !== ProviderID.openai) return false
  if (input.model.api.npm !== "@ai-sdk/openai" || status(input).type !== "supported") return false
  if (input.providerOptions?.serviceTier !== "ultrafast") return false
  const transport = input.model.options.transport ?? input.provider.options.transport
  if (transport !== undefined && transport !== "websocket") return false
  const baseURL = input.provider.options.baseURL ?? (input.model.api.url || "https://api.openai.com/v1")
  if (typeof baseURL !== "string" || !URL.canParse(baseURL)) return false
  const url = new URL(baseURL)
  return (
    url.origin === "https://api.openai.com" &&
    (url.pathname === "/v1" || url.pathname === "/v1/") &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  )
}

function statusWithFetch(
  input: Pick<StreamInput, "model" | "provider" | "auth">,
  fetch: typeof globalThis.fetch | undefined,
): RuntimeStatus {
  const providerID = input.model.providerID
  if (
    providerID !== ProviderID.openai &&
    providerID !== ProviderID.openaiCodex &&
    providerID !== ProviderID.anthropic &&
    !providerID.startsWith("opencode")
  )
    return { type: "unsupported", reason: "provider is not openai, opencode, or anthropic" }
  const npm = input.model.api.npm
  if (npm !== "@ai-sdk/openai" && npm !== "@ai-sdk/openai-compatible" && npm !== "@ai-sdk/anthropic")
    return { type: "unsupported", reason: "provider package is not OpenAI, OpenAI-compatible, or Anthropic" }
  if (input.auth?.type === "oauth" && !(input.provider.id === ProviderID.openaiCodex && fetch)) {
    return { type: "unsupported", reason: "OAuth auth requires a provider fetch override" }
  }
  if (typeof input.provider.options.fetch === "function" && !fetch)
    return { type: "unsupported", reason: "custom provider fetch is not supported by the native runtime" }

  const apiKey = typeof input.provider.options.apiKey === "string" ? input.provider.options.apiKey : input.provider.key
  if (!apiKey) return { type: "unsupported", reason: "API key is not configured" }

  return {
    type: "supported",
    apiKey,
    baseURL: typeof input.provider.options.baseURL === "string" ? input.provider.options.baseURL : undefined,
  }
}

export function stream(input: StreamInput): StreamResult {
  if (
    (input.model.api.npm === "@ai-sdk/openai" || input.model.api.npm === "@ai-sdk/azure") &&
    LLMNative.unsupportedCacheOrdering(input.messages)
  )
    return {
      type: "unsupported",
      reason: "Native Responses cannot preserve explicit cache breakpoints with interleaved system messages",
    }
  const fetch = providerFetch(input)
  const current = statusWithFetch(input, fetch)
  if (current.type === "unsupported") return current

  const codex = fetch && codexNativeAuth(fetch, current.baseURL ?? (input.model.api.url || "https://api.openai.com/v1"))
  if (codex) {
    return {
      ...current,
      stream: Stream.unwrap(
        Effect.tryPromise(codex).pipe(Effect.map((auth) => buildStream(input, { ...current, ...auth }, fetch, true))),
      ),
    }
  }
  return { ...current, stream: buildStream(input, current, fetch, false) }
}

function buildRequest(
  input: StreamInput,
  current: Extract<RuntimeStatus, { type: "supported" }> & { headers?: Record<string, string> },
  codex: boolean,
  http = false,
  tools?: Parameters<typeof LLMNative.request>[0]["tools"],
) {
  // Integration point with @opencode-ai/llm: native-request lowers session data
  // into an LLMRequest, then LLMClient handles route selection and transport.
  //
  // ProviderTransform.providerOptions builds AI-SDK-shaped options for the
  // selected SDK key (e.g. "openai") and the native LLM SDK reads the same
  // keys via OpenAIOptions.* (store, reasoningEffort, reasoningSummary,
  // include, textVerbosity, promptCacheKey). Both sides intentionally use
  // OpenAI's official wire field names, so this is identity, not translation
  // — if a field ever needs to differ between the two surfaces, the
  // translation belongs here, not split across both packages.
  const providerOptions = ProviderTransform.providerOptions(input.model, input.providerOptions ?? {})
  if (providerOptions.openai) {
    providerOptions.openai = { ...providerOptions.openai }
    delete providerOptions.openai.previousResponseId
  }
  const headers = { ...input.model.headers, ...providerHeaders(input.provider.options.headers), ...input.headers }
  const automatic = autoNative(input)
  const transport = http ? undefined : resolveTransport(input, codex, automatic)
  if (codex) {
    for (const key of Object.keys(headers)) {
      if (["authorization", "chatgpt-account-id", "openai-beta"].includes(key.toLowerCase())) delete headers[key]
    }
  }
  return LLMNative.request({
    model: codex ? { ...input.model, headers: {} } : input.model,
    apiKey: current.apiKey,
    baseURL: current.baseURL,
    messages: ProviderTransform.message(input.messages, input.model, input.providerOptions ?? {}),
    toolChoice: input.toolChoice,
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK,
    maxOutputTokens: input.maxOutputTokens,
    providerOptions,
    headers: { ...headers, ...current.headers },
    transport,
    tools,
  })
}

function buildStream(
  input: StreamInput,
  current: Extract<RuntimeStatus, { type: "supported" }> & { headers?: Record<string, string> },
  fetch: typeof globalThis.fetch | undefined,
  codex: boolean,
  http = false,
): Stream.Stream<LLMEvent, unknown> {
  const request = buildRequest(input, current, codex, http)
  const automatic = autoNative(input)
  const transport = http ? undefined : resolveTransport(input, codex, automatic)
  const tools = nativeTools(input.tools, input)
  const run = (request: ReturnType<typeof LLMNative.request>) => input.llmClient.stream({ request, tools })
  const enabled =
    !http &&
    (input.model.options.responsesContinuation ?? input.provider.options.responsesContinuation ?? automatic) === true
  const stream =
    enabled &&
    input.continuation &&
    input.sessionID &&
    (input.model.providerID === ProviderID.openai || codex) &&
    input.model.api.npm === "@ai-sdk/openai"
      ? Continuation.stream({
          state: input.continuation,
          sessionID: input.sessionID,
          previousResponseId: input.previousResponseId,
          owner: Continuation.fingerprint({
            model: input.model.api,
            provider: input.model.providerID,
            apiKey: current.apiKey,
            auth: codex ? undefined : input.auth,
            baseURL: current.baseURL,
            headers: request.model.route.defaults.headers,
            transport,
            system: request.system,
            instructions: request.providerOptions?.openai?.instructions,
          }),
          request,
          run,
        })
      : run(request)

  if (fetch) return stream.pipe(Stream.provideService(FetchHttpClient.Fetch, fetch))
  if (http || !automatic || (input.model.options.transport ?? input.provider.options.transport) !== undefined)
    return stream
  return Stream.suspend(() => {
    const progress = { output: false }
    return stream.pipe(
      Stream.tap((event) =>
        Effect.sync(() => {
          if (event.type !== "step-start") progress.output = true
        }),
      ),
      Stream.catchIf(
        (error) =>
          !progress.output &&
          !input.abort.aborted &&
          error instanceof LLMError &&
          error.module === "WebSocketExecutor" &&
          error.method === "open" &&
          error.reason._tag === "Transport" &&
          error.reason.kind === "open" &&
          !/timeout|timed?\s*out/i.test(error.reason.message),
        () => {
          // The failed socket never sent this request. Its continuation receipt
          // is consumed; retry the complete history once, without a WS pointer.
          if (input.sessionID) input.continuation?.delete(input.sessionID)
          return buildStream(input, current, undefined, false, true)
        },
      ),
    )
  })
}

/** No plugin hooks, history or tool execution are involved in connection setup. */
export const preconnect = Effect.fn("LLMNativeRuntime.preconnect")(function* (input: StreamInput) {
  const current = status(input)
  if (current.type === "unsupported" || !input.llmClient.preconnect) return false
  if (input.model.api.npm !== "@ai-sdk/openai" || input.model.providerID !== input.provider.id) return false
  if (input.model.options.fetch !== undefined) return false
  const baseURL = current.baseURL ?? (input.model.api.url || "https://api.openai.com/v1")
  if (!URL.canParse(baseURL)) return false
  const url = new URL(baseURL)
  if (url.username || url.password || url.search || url.hash) return false
  const publicURL = url.origin === "https://api.openai.com" && ["/v1", "/v1/"].includes(url.pathname)
  const codexURL =
    url.origin === "https://chatgpt.com" && ["/backend-api/codex", "/backend-api/codex/"].includes(url.pathname)
  if (input.provider.id === ProviderID.openai) {
    if (!publicURL || input.provider.options.fetch !== undefined) return false
  } else if (input.provider.id !== ProviderID.openaiCodex || (!publicURL && !codexURL)) return false
  const fetch = providerFetch(input)
  const refresh = fetch && codexNativeAuth(fetch, baseURL)
  if (input.provider.id === ProviderID.openaiCodex && !refresh) return false
  const auth = refresh ? yield* Effect.tryPromise(refresh) : undefined
  yield* input.llmClient.preconnect(
    buildRequest({ ...input, messages: [], tools: {} }, { ...current, ...auth }, !!auth),
  )
  return true
})

/** HTTP-only prefix request: no continuation, fallback, or executable tools. */
export function warmRequest(input: StreamInput, tools: Parameters<typeof LLMNative.request>[0]["tools"]) {
  const current = status(input)
  if (current.type === "unsupported" || input.provider.id !== ProviderID.openai) return undefined
  return buildRequest(input, current, false, true, tools)
}

// Model overrides provider; HTTP explicitly opts out of WebSocket, including
// the public OpenAI Ultrafast policy. Codex still requires an explicit opt-in.
function resolveTransport(
  input: Pick<StreamInput, "model" | "provider">,
  codex = false,
  automatic = false,
): "websocket" | undefined {
  // An arbitrary fetch override cannot authenticate a WebSocket handshake.
  if (input.provider.id === ProviderID.openaiCodex && !codex) return undefined
  const transport = input.model.options.transport ?? input.provider.options.transport
  return transport === "websocket" || (transport === undefined && automatic) ? "websocket" : undefined
}

function providerFetch(input: Pick<StreamInput, "provider" | "auth">): typeof globalThis.fetch | undefined {
  if (input.provider.id !== ProviderID.openaiCodex || input.auth?.type !== "oauth") return undefined
  const value: unknown = input.provider.options.fetch
  if (typeof value !== "function") return undefined
  return value as typeof globalThis.fetch
}

function providerHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function nativeSchema(value: unknown): JsonSchema {
  if (!value || typeof value !== "object") return { type: "object", properties: {} }
  if ("jsonSchema" in value && value.jsonSchema && typeof value.jsonSchema === "object")
    return value.jsonSchema as JsonSchema
  return asSchema(value as Parameters<typeof asSchema>[0]).jsonSchema as JsonSchema
}

export function nativeTools(tools: Record<string, Tool>, input: Pick<StreamInput, "messages" | "abort">) {
  return Object.fromEntries(
    Object.entries(tools).map(([name, item]) => [
      name,
      // Tool execution remains opencode-owned. The native runtime only adapts
      // the @opencode-ai/llm tool call back into the AI SDK Tool.execute shape.
      nativeTool({
        description: item.description ?? "",
        jsonSchema: nativeSchema(item.inputSchema),
        execution: readOnlyTools.has(item) ? "eager" : undefined,
        execute: (args: unknown, ctx) =>
          Effect.callback<unknown, ToolFailure>((resume, signal) => {
            const result = Promise.resolve().then(() => {
              if (!item.execute) throw new Error(`Tool has no execute handler: ${name}`)
              return item.execute(args, {
                toolCallId: ctx?.id ?? name,
                messages: input.messages,
                abortSignal: AbortSignal.any([input.abort, signal]),
              })
            })
            result.then(
              (value) => resume(Effect.succeed(value)),
              (error) => resume(Effect.fail(new ToolFailure({ message: errorMessage(error), error }))),
            )
            // Eager reads own cancellable bridge fibers; drain their cleanup before the stream ends.
            if (readOnlyTools.has(item))
              return Effect.promise(() =>
                result.then(
                  () => {},
                  () => {},
                ),
              )
          }),
      }),
    ]),
  )
}

export * as LLMNativeRuntime from "./native-runtime"
