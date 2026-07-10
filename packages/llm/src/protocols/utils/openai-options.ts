import { Schema } from "effect"
import type { LLMRequest, ReasoningEffort, TextVerbosity as TextVerbosityValue } from "../../schema"
import { ReasoningEfforts, TextVerbosity } from "../../schema"

export const OpenAIReasoningEfforts = ReasoningEfforts
export type OpenAIReasoningEffort = (typeof OpenAIReasoningEfforts)[number]

// Mirrors OpenAI's `ResponseIncludable` union from the official SDK. Keep this
// in lockstep with `openai-node/src/resources/responses/responses.ts`.
export const OpenAIResponseIncludables = [
  "file_search_call.results",
  "web_search_call.results",
  "web_search_call.action.sources",
  "message.input_image.image_url",
  "computer_call_output.output.image_url",
  "code_interpreter_call.outputs",
  "reasoning.encrypted_content",
  "message.output_text.logprobs",
] as const
export type OpenAIResponseIncludable = (typeof OpenAIResponseIncludables)[number]

const REASONING_EFFORTS = new Set<string>(ReasoningEfforts)
const OPENAI_REASONING_EFFORTS = new Set<string>(OpenAIReasoningEfforts)
const TEXT_VERBOSITY = new Set<string>(["low", "medium", "high"])
const INCLUDABLES = new Set<string>(OpenAIResponseIncludables)
const PROMPT_CACHE_RETENTIONS = ["in-memory", "24h"] as const
const SERVICE_TIERS = ["auto", "default", "flex", "scale", "priority"] as const
type PromptCacheRetention = (typeof PROMPT_CACHE_RETENTIONS)[number]
type ServiceTier = (typeof SERVICE_TIERS)[number]
const PROMPT_CACHE_RETENTION_SET = new Set<string>(PROMPT_CACHE_RETENTIONS)
const SERVICE_TIER_SET = new Set<string>(SERVICE_TIERS)

export const OpenAIReasoningEffort = Schema.Literals(OpenAIReasoningEfforts)
export const OpenAITextVerbosity = TextVerbosity
export const OpenAIResponseIncludable = Schema.Literals(OpenAIResponseIncludables)

const isAnyReasoningEffort = (effort: unknown): effort is ReasoningEffort =>
  typeof effort === "string" && REASONING_EFFORTS.has(effort)

export const isReasoningEffort = (effort: unknown): effort is OpenAIReasoningEffort =>
  typeof effort === "string" && OPENAI_REASONING_EFFORTS.has(effort)

const isTextVerbosity = (value: unknown): value is TextVerbosityValue =>
  typeof value === "string" && TEXT_VERBOSITY.has(value)

const options = (request: LLMRequest) => request.providerOptions?.openai

export const store = (request: LLMRequest): boolean | undefined => {
  const value = options(request)?.store
  return typeof value === "boolean" ? value : undefined
}

export const reasoningEffort = (request: LLMRequest): ReasoningEffort | undefined => {
  const value = options(request)?.reasoningEffort
  return isAnyReasoningEffort(value) ? value : undefined
}

export const reasoningSummary = (request: LLMRequest): "auto" | undefined =>
  options(request)?.reasoningSummary === "auto" ? "auto" : undefined

// Resolve the OpenAI Responses `include` field. Filters out unknown
// includable values defensively so a typo in upstream config drops the
// invalid entry instead of poisoning the wire body. An empty array (either
// passed directly or produced by filtering) is treated as "no include" and
// returns undefined so the request body omits the field entirely.
export const include = (request: LLMRequest): ReadonlyArray<OpenAIResponseIncludable> | undefined => {
  const value = options(request)?.include
  if (!Array.isArray(value)) return undefined
  const filtered = value.filter((entry): entry is OpenAIResponseIncludable => INCLUDABLES.has(entry))
  return filtered.length > 0 ? filtered : undefined
}

export const promptCacheKey = (request: LLMRequest) => {
  const value = options(request)?.promptCacheKey
  return typeof value === "string" ? value : undefined
}

export const promptCacheRetention = (request: LLMRequest): PromptCacheRetention | undefined => {
  const value = options(request)?.promptCacheRetention
  return typeof value === "string" && PROMPT_CACHE_RETENTION_SET.has(value)
    ? (value as PromptCacheRetention)
    : undefined
}

export const serviceTier = (request: LLMRequest): ServiceTier | undefined => {
  const value = options(request)?.serviceTier
  return typeof value === "string" && SERVICE_TIER_SET.has(value) ? (value as ServiceTier) : undefined
}

export const textVerbosity = (request: LLMRequest) => {
  const value = options(request)?.textVerbosity
  return isTextVerbosity(value) ? value : undefined
}

export const instructions = (request: LLMRequest) => {
  const value = options(request)?.instructions
  return typeof value === "string" ? value : undefined
}

// Continuation pointer (see OpenAIOptionsInput.previousResponseId). When the
// session layer captures `providerMetadata.openai.responseId` from a prior
// turn's `finish` LLMEvent and threads it back on the next request, the
// OpenAI server replays the cached conversation prefix instead of
// retokenizing the full history. Required for the WebSocket-mode speedup
// (works on HTTP too, with a smaller benefit).
export const previousResponseId = (request: LLMRequest) => {
  const value = options(request)?.previousResponseId
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export * as OpenAIOptions from "./openai-options"
