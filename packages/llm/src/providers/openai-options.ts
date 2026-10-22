import type { ProviderOptions, ReasoningEffort, TextVerbosity } from "../schema"
import { mergeProviderOptions } from "../schema"
import type { OpenAIResponseIncludable } from "../protocols/utils/openai-options"

export type { OpenAIResponseIncludable } from "../protocols/utils/openai-options"

export interface OpenAIPromptCacheOptions {
  readonly mode?: "implicit" | "explicit"
  readonly ttl?: "30m"
  // Opt-in only: prewarming incurs cache-write charges and generates no output.
  readonly prewarm?: boolean
}

export interface OpenAITextMetadata {
  readonly promptCacheBreakpoint?: { readonly mode: "explicit" }
}

export interface OpenAIOptionsInput {
  readonly [key: string]: unknown
  readonly store?: boolean
  // Responses API; omitted leaves the provider default unchanged.
  readonly parallelToolCalls?: boolean
  readonly promptCacheKey?: string
  readonly promptCacheRetention?: "in-memory" | "24h"
  // Responses API, GPT-5.6 and later. Older models retain their existing defaults.
  readonly promptCacheOptions?: OpenAIPromptCacheOptions
  readonly serviceTier?: "auto" | "default" | "flex" | "scale" | "priority" | "ultrafast"
  readonly reasoningEffort?: ReasoningEffort
  readonly reasoningSummary?: "auto"
  // OpenAI Responses `include` wire field. Mirrors the official SDK's
  // `ResponseIncludable[]` union exactly so AI SDK callers and direct
  // native-SDK callers share one shape and no translation is required.
  readonly include?: ReadonlyArray<OpenAIResponseIncludable>
  readonly textVerbosity?: TextVerbosity
  // Continuation pointer for the OpenAI Responses API. When set, the server
  // skips re-tokenizing the prior conversation and reuses the cached
  // state for that response id. Required for the article's connection-
  // scoped speedup and the only safe way to chain turns under WebSocket
  // mode (`response.create` + previous_response_id is OpenAI's documented
  // continuation pattern, see developers.openai.com/api/docs/guides/
  // websocket-mode). Works equally over plain HTTP — the server still
  // caches some state per response id.
  readonly previousResponseId?: string
}

export type OpenAIProviderOptionsInput = ProviderOptions & {
  readonly openai?: OpenAIOptionsInput
}

const definedEntries = (input: Record<string, unknown>) =>
  Object.entries(input).filter((entry) => entry[1] !== undefined)

const openAIProviderOptions = (options: OpenAIOptionsInput | undefined): ProviderOptions | undefined => {
  const openai = Object.fromEntries(
    definedEntries({
      store: options?.store,
      parallelToolCalls: options?.parallelToolCalls,
      promptCacheKey: options?.promptCacheKey,
      promptCacheRetention: options?.promptCacheRetention,
      promptCacheOptions: options?.promptCacheOptions,
      serviceTier: options?.serviceTier,
      reasoningEffort: options?.reasoningEffort,
      reasoningSummary: options?.reasoningSummary,
      include: options?.include,
      textVerbosity: options?.textVerbosity,
      previousResponseId: options?.previousResponseId,
    }),
  )
  if (Object.keys(openai).length === 0) return undefined
  return { openai }
}

export const gpt5DefaultOptions = (
  modelID: string,
  options: { readonly textVerbosity?: boolean } = {},
): ProviderOptions | undefined => {
  const id = modelID.toLowerCase()
  if (!id.includes("gpt-5") || id.includes("gpt-5-chat") || id.includes("gpt-5-pro")) return undefined
  return openAIProviderOptions({
    reasoningEffort: "medium",
    reasoningSummary: "auto",
    // GPT-5 reasoning models are configured stateless (`store: false`) by
    // `openAIDefaultOptions` below, so the only way a follow-up turn can
    // carry reasoning state is via the encrypted reasoning include. Without
    // this, callers using the default model facade get reasoning summaries
    // they cannot replay statelessly.
    include: ["reasoning.encrypted_content"],
    textVerbosity:
      options.textVerbosity === true && id.includes("gpt-5.") && !id.includes("codex") && !id.includes("-chat")
        ? "low"
        : undefined,
  })
}

export const openAIDefaultOptions = (
  modelID: string,
  options: { readonly textVerbosity?: boolean } = {},
): ProviderOptions | undefined =>
  mergeProviderOptions(openAIProviderOptions({ store: false }), gpt5DefaultOptions(modelID, options))

export const withOpenAIOptions = <Options extends { readonly providerOptions?: OpenAIProviderOptionsInput }>(
  modelID: string,
  options: Options,
  defaults: { readonly textVerbosity?: boolean } = {},
): Omit<Options, "providerOptions"> & { readonly providerOptions?: ProviderOptions } => {
  return {
    ...options,
    providerOptions: mergeProviderOptions(openAIDefaultOptions(modelID, defaults), options.providerOptions),
  }
}

export * as OpenAIProviderOptions from "./openai-options"
