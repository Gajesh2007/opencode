import { type Cause, Deferred, Effect, Queue, References, Schedule, Stream } from "effect"
import type { Concurrency } from "effect/Types"
import {
  type ContentPart,
  type FinishReason,
  LLMError,
  LLMEvent,
  LLMRequest,
  Message,
  type ProviderMetadata,
  ToolCallPart,
  ToolFailure,
  ToolResultPart,
  ToolResultValue,
  type ToolResultValue as ToolResultValueType,
  Usage,
} from "./schema"
import { type AnyTool, type ExecutableTools, type Tools, toDefinitions } from "./tool"

export interface RuntimeState {
  readonly step: number
  readonly request: LLMRequest
}

export type StopCondition = (state: RuntimeState) => boolean

export type ToolExecution = "auto" | "none"

interface RunOptionsBase {
  readonly request: LLMRequest
  readonly concurrency?: Concurrency
  readonly stopWhen?: StopCondition
}

export type RunOptions<T extends Tools> = RunOptionsAuto<T & ExecutableTools> | RunOptionsNone<T>

export interface RunOptionsAuto<T extends ExecutableTools> extends RunOptionsBase {
  readonly request: LLMRequest
  readonly tools: T
  readonly toolExecution?: "auto"
}

export interface RunOptionsNone<T extends Tools> extends RunOptionsBase {
  readonly request: LLMRequest
  readonly tools: T
  /** Advertise tool schemas but leave model-emitted tool calls for the caller. */
  readonly toolExecution: "none"
}

export type StreamOptions<T extends Tools> = RunOptions<T> & {
  readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
}

export const stepCountIs =
  (count: number): StopCondition =>
  (state) =>
    state.step + 1 >= count

/**
 * Run a model with typed tools. This helper owns tool orchestration, while the
 * caller supplies the actual model stream function. It can advertise schemas
 * only (`toolExecution: "none"`), execute one step, or continue model rounds
 * when `stopWhen` is provided.
 */
export const stream = <T extends Tools>(options: StreamOptions<T>): Stream.Stream<LLMEvent, LLMError> => {
  const concurrency = options.concurrency ?? 10
  const retainHistory = options.stopWhen !== undefined && options.toolExecution !== "none"
  const tools = options.tools as Tools
  const eager = options.toolExecution !== "none" && Object.values(tools).some((tool) => tool.execution === "eager")
  const runtimeTools = toDefinitions(tools)
  const runtimeToolNames = new Set(runtimeTools.map((tool) => tool.name))
  const initialRequest =
    runtimeTools.length === 0
      ? options.request
      : LLMRequest.update(options.request, {
          tools: [...options.request.tools.filter((tool) => !runtimeToolNames.has(tool.name)), ...runtimeTools],
        })

  const loop = (
    request: LLMRequest,
    step: number,
    usage: Usage | undefined,
    providerMetadata: ProviderMetadata | undefined,
  ): Stream.Stream<LLMEvent, LLMError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const state: StepState = {
          assistantContent: [],
          toolCalls: [],
          toolCallIds: new Set(),
          toolInputs: new Map(),
          providerResultIds: new Set(),
          eagerCount: 0,
          finished: false,
          failed: false,
          finishReason: undefined,
          usage: undefined,
          providerMetadata: undefined,
        }

        const limit = concurrency === "inherit" ? yield* References.CurrentConcurrency : concurrency
        const dispatched: Array<readonly [ToolCallPart, ToolResultValueType]> = []
        const execute = (call: ToolCallPart, index: number) =>
          dispatch(tools, call).pipe(
            Effect.map((result) => {
              // Emit as tools complete, but retain the model's call order for history.
              if (retainHistory) dispatched[index] = [call, result.result]
              return emitEvents(call, result.result, result.error)
            }),
          )

        const retry = { attempts: 0, output: false }
        const source = Stream.suspend(() => {
          retry.attempts++
          return options.stream(request)
        }).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (event.type !== "step-start") retry.output = true
            }),
          ),
          Stream.retry(
            Schedule.spaced("200 millis").pipe(
              Schedule.while(
                ({ input }) =>
                  retry.attempts < 3 &&
                  !retry.output &&
                  input instanceof LLMError &&
                  input.reason._tag === "InvalidProviderOutput" &&
                  input.reason.message === "OpenAI Responses tool argument delta is missing its tool call",
              ),
            ),
          ),
        )
        const modelStream = eager
          ? Stream.callback<LLMEvent, LLMError>(
              (output) =>
                Effect.gen(function* () {
                  const jobs = yield* Effect.acquireRelease(
                    Queue.unbounded<{ call: ToolCallPart; index: number }, Cause.Done>(),
                    Queue.shutdown,
                  )
                  const cancelled = yield* Deferred.make<void>()
                  let blocked = false
                  yield* Effect.all(
                    [
                      Stream.fromQueue(jobs).pipe(
                        Stream.mapEffect(({ call, index }) => execute(call, index), {
                          concurrency: limit,
                          unordered: true,
                        }),
                        Stream.runForEach((events) => Queue.offerAll(output, events)),
                        Effect.raceFirst(Deferred.await(cancelled)),
                      ),
                      source.pipe(
                        Stream.runForEach((event) =>
                          Effect.gen(function* () {
                            const index = state.toolCalls.length
                            const indexed = indexStep(event, step)
                            if (!accumulate(state, indexed, retainHistory)) return
                            if (
                              state.failed ||
                              (state.finished && state.finishReason !== "tool-calls" && state.finishReason !== "stop")
                            )
                              yield* Deferred.succeed(cancelled, undefined)
                            // Offer the call before making its result runnable.
                            if (indexed.type !== "finish") yield* Queue.offer(output, indexed)
                            // A mutation may still be streaming its arguments when a later read completes.
                            if (
                              (indexed.type === "tool-input-start" ||
                                indexed.type === "tool-input-delta" ||
                                indexed.type === "tool-input-end") &&
                              tools[indexed.name]?.execution !== "eager"
                            )
                              blocked = true
                            if (indexed.type !== "tool-call" || indexed.providerExecuted) return
                            if (tools[indexed.name]?.execution !== "eager") blocked = true
                            const call = state.toolCalls[index]
                            if (blocked || state.failed || state.finished || !call) return
                            state.eagerCount++
                            yield* Queue.offer(jobs, { call, index })
                          }),
                        ),
                        Effect.andThen(() =>
                          state.finished &&
                          !state.failed &&
                          (state.finishReason === "tool-calls" || state.finishReason === "stop")
                            ? Queue.end(jobs)
                            : Deferred.succeed(cancelled, undefined),
                        ),
                      ),
                    ],
                    { concurrency: 2, discard: true },
                  )
                }).pipe(
                  Effect.scoped,
                  Effect.matchCauseEffect({
                    onFailure: (cause) => Queue.failCause(output, cause),
                    onSuccess: () => Queue.end(output),
                  }),
                ),
              { bufferSize: 16 },
            )
          : source.pipe(
              Stream.map((event) => indexStep(event, step)),
              Stream.filter((event) => accumulate(state, event, retainHistory) && event.type !== "finish"),
            )

        const continuation = Stream.unwrap(
          Effect.gen(function* () {
            const totalUsage = addUsage(usage, state.usage)
            const totalProviderMetadata = mergeProviderMetadata(providerMetadata, state.providerMetadata)
            const finishStream = Stream.fromIterable([
              LLMEvent.finish({
                reason: state.failed ? "error" : state.finished ? (state.finishReason ?? "unknown") : "unknown",
                usage: totalUsage,
                providerMetadata: totalProviderMetadata,
              }),
            ])

            if (!state.finished || state.failed || state.finishReason !== "tool-calls" || state.toolCalls.length === 0)
              return finishStream
            if (options.toolExecution === "none") return finishStream

            const resultStream = Stream.fromIterable(state.toolCalls.slice(state.eagerCount)).pipe(
              Stream.mapEffect((call, index) => execute(call, index + state.eagerCount), {
                concurrency: limit,
                unordered: true,
              }),
              Stream.flattenIterable,
            )

            return resultStream.pipe(
              Stream.concat(
                Stream.suspend(() => {
                  if (!options.stopWhen || options.stopWhen({ step, request })) return finishStream
                  return loop(followUpRequest(request, state, dispatched), step + 1, totalUsage, totalProviderMetadata)
                }),
              ),
            )
          }),
        )

        return modelStream.pipe(Stream.concat(continuation))
      }),
    )

  return loop(initialRequest, 0, undefined, undefined)
}

const indexStep = (event: LLMEvent, index: number): LLMEvent => {
  if (event.type === "step-start") return LLMEvent.stepStart({ index })
  if (event.type === "step-finish") return LLMEvent.stepFinish({ ...event, index })
  return event
}

interface StepState {
  assistantContent: ContentPart[]
  toolCalls: ToolCallPart[]
  toolCallIds: Set<string>
  toolInputs: Map<string, "started" | "ended">
  providerResultIds: Set<string>
  eagerCount: number
  finished: boolean
  failed: boolean
  finishReason: FinishReason | undefined
  usage: Usage | undefined
  providerMetadata: ProviderMetadata | undefined
}

// The same acceptance decision must gate history, dispatch, and public events.
const accumulate = (state: StepState, event: LLMEvent, retainHistory: boolean) => {
  if (event.type === "tool-input-start" || event.type === "tool-input-delta" || event.type === "tool-input-end") {
    if (state.toolCallIds.has(event.id) || state.toolInputs.get(event.id) === "ended") return false
    if (event.type === "tool-input-start") {
      if (state.toolInputs.has(event.id)) return false
      state.toolInputs.set(event.id, "started")
    }
    if (event.type === "tool-input-end") state.toolInputs.set(event.id, "ended")
    return true
  }
  if (retainHistory && event.type === "text-delta") {
    appendStreamingText(state, "text", event.text, undefined)
    return true
  }
  if (retainHistory && event.type === "reasoning-delta") {
    appendStreamingText(state, "reasoning", event.text, undefined)
    return true
  }
  if (retainHistory && event.type === "reasoning-end") {
    appendStreamingText(state, "reasoning", "", event.providerMetadata)
    return true
  }
  if (retainHistory && event.type === "text-end") {
    appendStreamingText(state, "text", "", event.providerMetadata)
    return true
  }
  if (event.type === "tool-call") {
    if (state.toolCallIds.has(event.id)) return false
    state.toolCallIds.add(event.id)
    state.toolInputs.delete(event.id)
    if (!retainHistory && event.providerExecuted) return true
    const part = ToolCallPart.make({
      id: event.id,
      name: event.name,
      input: event.input,
      inputError: event.inputError,
      providerExecuted: event.providerExecuted,
      providerMetadata: event.providerMetadata,
    })
    if (retainHistory) state.assistantContent.push(part)
    if (!event.providerExecuted) state.toolCalls.push(part)
    return true
  }
  if (event.type === "tool-result" && event.providerExecuted) {
    if (state.providerResultIds.has(event.id)) return false
    state.providerResultIds.add(event.id)
    if (retainHistory)
      state.assistantContent.push(
        ToolResultPart.make({
          id: event.id,
          name: event.name,
          result: event.result,
          providerExecuted: true,
          providerMetadata: event.providerMetadata,
        }),
      )
    return true
  }
  if (event.type === "step-finish") {
    state.finishReason = event.reason === "stop" && state.toolCalls.length > 0 ? "tool-calls" : event.reason
    state.usage = addUsage(state.usage, event.usage)
    state.providerMetadata = mergeProviderMetadata(state.providerMetadata, event.providerMetadata)
    return true
  }
  if (event.type === "finish") {
    state.finished = true
    if (event.reason !== "stop" && event.reason !== "tool-calls") state.finishReason = event.reason
    state.finishReason ??= event.reason
    state.usage ??= event.usage
    state.providerMetadata = mergeProviderMetadata(state.providerMetadata, event.providerMetadata)
  }
  if (event.type === "provider-error") state.failed = true
  return true
}

const addUsage = (left: Usage | undefined, right: Usage | undefined) => {
  if (!left) return right
  if (!right) return left
  type UsageKey =
    | "inputTokens"
    | "outputTokens"
    | "nonCachedInputTokens"
    | "cacheReadInputTokens"
    | "cacheWriteInputTokens"
    | "reasoningTokens"
    | "totalTokens"
  const sum = (key: UsageKey) =>
    left[key] === undefined && right[key] === undefined ? undefined : (left[key] ?? 0) + (right[key] ?? 0)

  return new Usage({
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    nonCachedInputTokens: sum("nonCachedInputTokens"),
    cacheReadInputTokens: sum("cacheReadInputTokens"),
    cacheWriteInputTokens: sum("cacheWriteInputTokens"),
    reasoningTokens: sum("reasoningTokens"),
    totalTokens: sum("totalTokens"),
    providerMetadata: mergeProviderMetadata(left.providerMetadata, right.providerMetadata),
  })
}

const sameProviderMetadata = (left: ProviderMetadata | undefined, right: ProviderMetadata | undefined) =>
  left === right || JSON.stringify(left) === JSON.stringify(right)

const mergeProviderMetadata = (left: ProviderMetadata | undefined, right: ProviderMetadata | undefined) => {
  if (!left) return right
  if (!right) return left
  return Object.fromEntries(
    Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).map((provider) => [
      provider,
      { ...left[provider], ...right[provider] },
    ]),
  )
}

const appendStreamingText = (
  state: StepState,
  type: "text" | "reasoning",
  text: string,
  providerMetadata: ProviderMetadata | undefined,
) => {
  const last = state.assistantContent.at(-1)
  if (last?.type === type && text.length === 0) {
    state.assistantContent[state.assistantContent.length - 1] = {
      ...last,
      providerMetadata: mergeProviderMetadata(last.providerMetadata, providerMetadata),
    }
    return
  }
  if (last?.type === type && sameProviderMetadata(last.providerMetadata, providerMetadata)) {
    state.assistantContent[state.assistantContent.length - 1] = { ...last, text: `${last.text}${text}` }
    return
  }
  state.assistantContent.push({ type, text, providerMetadata })
}

const dispatch = (
  tools: Tools,
  call: ToolCallPart,
): Effect.Effect<{ result: ToolResultValueType; error?: unknown }> => {
  if (call.inputError !== undefined)
    return Effect.succeed({ result: { type: "error" as const, value: call.inputError } })
  const tool = tools[call.name]
  if (!tool) return Effect.succeed({ result: { type: "error" as const, value: `Unknown tool: ${call.name}` } })
  if (!tool.execute)
    return Effect.succeed({ result: { type: "error" as const, value: `Tool has no execute handler: ${call.name}` } })

  return decodeAndExecute(tool, call).pipe(
    Effect.catchTag("LLM.ToolFailure", (failure) =>
      Effect.succeed({
        result: { type: "error" as const, value: failure.message } satisfies ToolResultValueType,
        error: failure.error,
      }),
    ),
    Effect.map((result) => ("result" in result ? result : { result })),
  )
}

const decodeAndExecute = (tool: AnyTool, call: ToolCallPart): Effect.Effect<ToolResultValueType, ToolFailure> =>
  tool._decode(call.input).pipe(
    Effect.mapError((error) => new ToolFailure({ message: `Invalid tool input: ${error.message}` })),
    Effect.flatMap((decoded) => tool.execute!(decoded, { id: call.id, name: call.name })),
    Effect.flatMap((value) =>
      tool._encode(value).pipe(
        Effect.mapError(
          (error) =>
            new ToolFailure({
              message: `Tool returned an invalid value for its success schema: ${error.message}`,
            }),
        ),
      ),
    ),
    Effect.map(
      (encoded): ToolResultValueType => (ToolResultValue.is(encoded) ? encoded : { type: "json", value: encoded }),
    ),
  )

const emitEvents = (call: ToolCallPart, result: ToolResultValueType, error: unknown): ReadonlyArray<LLMEvent> =>
  result.type === "error"
    ? [
        LLMEvent.toolError({ id: call.id, name: call.name, message: String(result.value), error }),
        LLMEvent.toolResult({ id: call.id, name: call.name, result }),
      ]
    : [LLMEvent.toolResult({ id: call.id, name: call.name, result })]

const followUpRequest = (
  request: LLMRequest,
  state: StepState,
  dispatched: ReadonlyArray<readonly [ToolCallPart, ToolResultValueType]>,
) =>
  LLMRequest.update(request, {
    messages: [
      ...request.messages,
      Message.assistant(state.assistantContent),
      ...dispatched.map(([call, result]) => Message.tool({ id: call.id, name: call.name, result })),
    ],
  })

export const ToolRuntime = { stream, stepCountIs } as const
