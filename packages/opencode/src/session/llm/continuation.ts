import { LLMRequest, type LLMEvent } from "@opencode-ai/llm"
import { Effect, Exit, Schema, Stream } from "effect"
import { isRecord } from "@/util/record"

type Receipt = {
  readonly id: string
  readonly owner: string
  readonly prefix: string
  readonly length: number
  readonly assistant: string
}

// Only hashes are retained; eviction and process restarts safely lose the optimization.
export const createContinuationState = () => new Map<string, Receipt>()
export type ContinuationState = ReturnType<typeof createContinuationState>

export const fingerprint = (value: unknown) =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")

const staleBody = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const stale = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  if (value.code === "previous_response_not_found") return true
  if (isRecord(value.error) && value.error.code === "previous_response_not_found") return true
  if (!isRecord(value.reason)) return false
  if (!isRecord(value.reason.http) || typeof value.reason.http.body !== "string") return false
  const body = staleBody(value.reason.http.body)
  return body._tag === "Some" && stale(body.value)
}

type Content =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; metadata: ReturnType<typeof reasoningMetadata> }
  | { type: "tool-call"; id: string; name: string; input: unknown }

function reasoningMetadata(value: unknown) {
  const openai = isRecord(value) && isRecord(value.openai) ? value.openai : undefined
  return {
    itemId: openai?.itemId,
    reasoningEncryptedContent: openai?.reasoningEncryptedContent,
  }
}

function append(content: Content[], part: Content) {
  const last = content.at(-1)
  if (part.type === "text" && last?.type === "text") {
    last.text += part.text
    return
  }
  content.push(part)
}

function contentFingerprint(parts: Iterable<Content>) {
  const content: Content[] = []
  for (const part of parts) {
    // AI SDK's session conversion drops empty text, but preserves empty reasoning.
    if (part.type === "text" && part.text === "") continue
    append(content, { ...part })
  }
  return fingerprint(content)
}

function assistantFingerprint(message: LLMRequest["messages"][number] | undefined) {
  if (message?.role !== "assistant") return undefined
  const content: Content[] = []
  for (const part of message.content) {
    if (part.type === "text") {
      append(content, { type: part.type, text: part.text })
      continue
    }
    if (part.type === "reasoning") {
      append(content, { type: part.type, text: part.text, metadata: reasoningMetadata(part.providerMetadata) })
      continue
    }
    if (part.type === "tool-call" && !part.providerExecuted) {
      append(content, { type: part.type, id: part.id, name: part.name, input: part.input })
      continue
    }
    return undefined
  }
  return contentFingerprint(content)
}

export function stream(input: {
  readonly state: ContinuationState
  readonly sessionID: string
  readonly owner: string
  readonly previousResponseId?: string
  readonly request: LLMRequest
  readonly run: (request: LLMRequest) => Stream.Stream<LLMEvent, unknown>
}) {
  return Stream.suspend(() => {
    const previous = input.state.get(input.sessionID)
    // Consume the receipt before starting: failures/cancellation cannot leave a
    // stale eligible prefix, and concurrent calls cannot both reuse it.
    input.state.delete(input.sessionID)
    const eligible =
      previous &&
      previous.id === input.previousResponseId &&
      previous.owner === input.owner &&
      input.request.messages.length > previous.length + 1 &&
      fingerprint(input.request.messages.slice(0, previous.length)) === previous.prefix &&
      assistantFingerprint(input.request.messages[previous.length]) === previous.assistant
    const request = eligible
      ? LLMRequest.update(input.request, {
          system: [],
          messages: input.request.messages.slice(previous.length + 1),
          providerOptions: {
            ...input.request.providerOptions,
            openai: { ...input.request.providerOptions?.openai, previousResponseId: previous.id },
          },
        })
      : input.request
    // Session parts are persisted in start order, not delta/completion order.
    const content = new Map<string, Content>()
    const result: { id?: string; output: boolean; failed: boolean } = { output: false, failed: false }
    const run = (request: LLMRequest, retry: boolean): Stream.Stream<LLMEvent, unknown> =>
      input.run(request).pipe(
        Stream.mapEffect((event) => {
          if (event.type === "provider-error") {
            result.failed = true
            if (retry && !result.output && /^previous_response_not_found(?::|$)/.test(event.message))
              return Effect.fail({ code: "previous_response_not_found" })
          }
          // No retry after content/tool events, even if the provider later says
          // its cached response is missing. Tools may already have side effects.
          if (event.type !== "step-start" && event.type !== "provider-error") result.output = true
          if (event.type === "text-start") content.set(`text:${event.id}`, { type: "text", text: "" })
          if (event.type === "reasoning-start")
            content.set(`reasoning:${event.id}`, {
              type: "reasoning",
              text: "",
              metadata: reasoningMetadata(event.providerMetadata),
            })
          if (event.type === "text-delta" || event.type === "reasoning-delta") {
            const type = event.type === "text-delta" ? "text" : "reasoning"
            const part = content.get(`${type}:${event.id}`)
            if (part && part.type !== "tool-call") {
              part.text += event.text
              if (part.type === "reasoning" && event.providerMetadata)
                part.metadata = reasoningMetadata(event.providerMetadata)
            }
          }
          if (event.type === "reasoning-end" && event.providerMetadata) {
            const part = content.get(`reasoning:${event.id}`)
            if (part?.type === "reasoning") part.metadata = reasoningMetadata(event.providerMetadata)
          }
          if (event.type === "tool-input-start")
            content.set(`tool:${event.id}`, { type: "tool-call", id: event.id, name: event.name, input: undefined })
          if (event.type === "tool-call") {
            if (event.providerExecuted) result.failed = true
            content.set(`tool:${event.id}`, { type: "tool-call", id: event.id, name: event.name, input: event.input })
          }
          if (event.type === "finish") {
            const id = event.providerMetadata?.openai?.responseId
            if (typeof id === "string" && (event.reason === "stop" || event.reason === "tool-calls")) result.id = id
          }
          return Effect.succeed(event)
        }),
        Stream.catchIf(
          (error) => retry && !result.output && stale(error),
          () => {
            result.failed = false
            return run(input.request, false)
          },
        ),
      )
    return run(request, !!eligible).pipe(
      Stream.onExit((exit) =>
        Effect.sync(() => {
          if (!Exit.isSuccess(exit) || result.failed || !result.id) return
          input.state.set(input.sessionID, {
            id: result.id,
            owner: input.owner,
            length: input.request.messages.length,
            prefix: fingerprint(input.request.messages),
            assistant: contentFingerprint(content.values()),
          })
          if (input.state.size <= 128) return
          const oldest = input.state.keys().next().value
          if (oldest !== undefined) input.state.delete(oldest)
        }),
      ),
    )
  })
}
