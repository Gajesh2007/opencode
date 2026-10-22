import { Provider } from "@/provider/provider"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import * as Log from "@opencode-ai/core/util/log"
import { Cause, Context, Effect, Exit, Layer } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import type { LLMEvent } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import type { LLMClientService } from "@opencode-ai/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Bus } from "@/bus"
import { Wildcard } from "@/util/wildcard"
import { isRecord } from "@/util/record"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"
import { BedrockRetry } from "./llm/bedrock-retry"
import { LLMWarm } from "./llm/warm"
import { SessionUsage } from "./usage"
import { SessionTiming } from "./timing"

const log = Log.create({ service: "llm" })
export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

export type StreamInput = {
  user: MessageV2.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: Permission.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  usageKind?: "assistant" | "reviewer" | "steering" | "auxiliary"
  tools: Record<string, Tool>
  retries?: number
  bedrockRetry?: BedrockRetry.State
  toolChoice?: "auto" | "required" | "none"
  /**
   * Candidate response ID from the prior assistant. Only the opt-in native
   * OpenAI runtime may use it, after verifying local ownership and history.
   * Unknown IDs, changed context, and AI SDK requests use full history.
   */
  previousResponseId?: string
  onRequest?: (info: { serviceTier?: string }) => void
  timing?: SessionTiming.Handle
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
  readonly warm?: LLMWarm.Interface["warm"]
  readonly cancelWarm?: LLMWarm.Interface["cancel"]
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | LLMClientService
  | RuntimeFlags.Service
  | LLMWarm.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service
    const warming = yield* LLMWarm.Service
    const continuation = LLMNativeRuntime.createContinuationState()

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      const l = log
        .clone()
        .tag("providerID", input.model.providerID)
        .tag("modelID", input.model.id)
        .tag("session.id", input.sessionID)
        .tag("small", (input.small ?? false).toString())
        .tag("agent", input.agent.name)
        .tag("mode", input.agent.mode)
      l.info("stream", {
        modelID: input.model.id,
        providerID: input.model.providerID,
      })
      if (!input.small) yield* warming.cancel(input.sessionID)

      const [language, cfg, item, info] = yield* Effect.all(
        [
          // Native OpenAI does not use an AI SDK model. Resolve it only on fallback.
          (flags.experimentalNativeLlm ||
            input.user.model.serviceTier === "ultrafast" ||
            input.model.options.serviceTier === "ultrafast") &&
          input.model.providerID === "openai" &&
          input.model.api.npm === "@ai-sdk/openai"
            ? Effect.succeed(undefined)
            : provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
      })
      const providerOptions = ProviderTransform.providerOptions(input.model, prepared.params.options)
      if (providerOptions.openai?.promptCacheOptions?.prewarm === true)
        throw new Error("Cache prewarming must use a separate API request, not a conversational response")
      const capture = (native: boolean) =>
        input.small
          ? Effect.void
          : warming.capture({
              native,
              toolChoice: input.toolChoice,
              selection: {
                sessionID: input.sessionID,
                parentSessionID: input.parentSessionID,
                providerID: input.model.providerID,
                modelID: input.model.id,
                agent: input.agent.name,
                variant: input.user.model.variant,
                serviceTier: input.user.model.serviceTier,
                upstream: input.user.model.upstream,
              },
              model: input.model,
              provider: item,
              auth: info,
              prepared,
            })
      const tier = providerOptions.openai?.serviceTier ?? providerOptions.bedrock?.serviceTier
      input.timing?.metadata({ requestedTier: typeof tier === "string" ? tier : tier?.type })
      input.timing?.requestPrepared()
      input.onRequest?.({ serviceTier: typeof tier === "string" ? tier : tier?.type })
      const autoNative = LLMNativeRuntime.autoNative({
        model: input.model,
        provider: item,
        auth: info,
        providerOptions: prepared.params.options,
      })

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = prepared.tools[toolName]
          if (!t || !t.execute) {
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const result = await t.execute!(JSON.parse(argsJson), {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const bridge = yield* EffectBridge.make()
        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionID.ascending()
          let unsub: (() => void) | undefined
          try {
            unsub = Bus.subscribe(Permission.Event.Replied, (evt) => {
              if (evt.properties.requestID === id) void evt.properties.reply
            })
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            unsub?.()
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      // Runtime seam: native is an opt-in adapter over @opencode-ai/llm. It
      // either returns a ready LLMEvent stream or a concrete fallback reason.
      if (flags.experimentalNativeLlm || autoNative) {
        const native = LLMNativeRuntime.stream({
          continuation: input.small ? undefined : continuation,
          sessionID: input.sessionID,
          previousResponseId: input.previousResponseId,
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          maxOutputTokens: prepared.params.maxOutputTokens,
          providerOptions: prepared.params.options,
          headers: prepared.headers,
          abort: input.abort,
        })
        if (native.type === "supported") {
          yield* capture(true)
          yield* Effect.logInfo("llm runtime selected").pipe(
            Effect.annotateLogs({
              "llm.runtime": "native",
              "llm.provider": input.model.providerID,
              "llm.model": input.model.id,
            }),
          )
          return {
            type: "native" as const,
            stream: native.stream,
          }
        }
        yield* Effect.logInfo("llm runtime selected").pipe(
          Effect.annotateLogs({
            "llm.runtime": "ai-sdk",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
            "llm.native_unsupported_reason": native.reason,
          }),
        )
        l.info("native runtime unavailable; falling back to ai-sdk", { reason: native.reason })
      }

      yield* Effect.logInfo("llm runtime selected").pipe(
        Effect.annotateLogs({
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
        }),
      )
      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      yield* capture(false)
      const retry =
        !Object.values(prepared.tools).some((tool) => tool.type === "provider") &&
        BedrockRetry.enabled({
          providerID: input.model.providerID,
          npm: input.model.api.npm,
          options: item.options,
          url: input.model.api.url,
        })
      const retryState = input.bedrockRetry ?? BedrockRetry.state()
      return {
        type: "ai-sdk" as const,
        result: streamText({
          onError(error) {
            l.error("stream error", {
              error,
            })
          },
          async experimental_repairToolCall(failed) {
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
              l.info("repairing tool call", {
                tool: failed.toolCall.toolName,
                repaired: lower,
              })
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error: failed.error.message,
              }),
              toolName: "invalid",
            }
          },
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          providerOptions,
          activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          maxOutputTokens: prepared.params.maxOutputTokens,
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: retry ? 0 : (input.retries ?? 0),
          messages: prepared.messages,
          model: wrapLanguageModel({
            model: language ?? (yield* provider.getLanguage(input.model)),
            middleware: [
              {
                specificationVersion: "v3" as const,
                async transformParams(args) {
                  if (args.type === "stream") {
                    // @ts-expect-error
                    args.params.prompt = ProviderTransform.message(
                      args.params.prompt,
                      input.model,
                      prepared.messageTransformOptions,
                    )
                  }
                  return args.params
                },
                wrapStream: retry
                  ? ({ model, params }) => BedrockRetry.stream({ model, params, state: retryState })
                  : undefined,
              },
            ],
          }),
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer: telemetryTracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        }),
      }
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const timing =
              input.timing ??
              SessionTiming.start(
                {
                  sessionID: input.sessionID,
                  messageID: input.user.id,
                  providerID: input.model.providerID,
                  modelID: input.model.id,
                  variant: input.small ? undefined : input.user.model.variant,
                  requestedTier: input.small ? undefined : input.user.model.serviceTier,
                  purpose:
                    input.agent.name === "compaction"
                      ? "compaction"
                      : (input.usageKind ?? (input.small ? "auxiliary" : "assistant")),
                },
                { enabled: !flags.disableTiming },
              )
            if (!input.timing) timing.request()
            let outcome: "completed" | "error" | "incomplete" | "truncated" = "incomplete"
            if (!input.timing) {
              yield* Effect.addFinalizer((exit) =>
                Effect.sync(() =>
                  timing.finish(
                    Exit.isFailure(exit) ? (Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "error") : outcome,
                  ),
                ),
              )
            }
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, timing, abort: ctrl.signal })
            timing.metadata({ runtime: result.type })
            const state = LLMAISDK.adapterState()
            // Both adapters expose the same application-observed semantic milestones.
            const source =
              result.type === "native"
                ? result.stream
                : Stream.fromAsyncIterable(LLMAISDK.fullStream(result.result), (e) =>
                    e instanceof Error ? e : new Error(String(e)),
                  ).pipe(
                    Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
                    Stream.flattenIterable,
                  )
            return source.pipe(
              Stream.tap((event) =>
                Effect.sync(() => {
                  if (event.type === "text-delta" && event.text.length) timing.firstText()
                  if (event.type === "reasoning-delta" && event.text.length) timing.firstReasoning()
                  if (event.type === "tool-input-start") timing.toolInputStart(event.id, event.name)
                  if (event.type === "tool-call") timing.toolReady(event.id, event.name)
                  if (event.type === "provider-error") outcome = "error"
                  if (event.type === "finish" || event.type === "step-finish") {
                    if (outcome !== "error")
                      outcome =
                        event.reason === "unknown"
                          ? "incomplete"
                          : event.reason === "length"
                            ? "truncated"
                            : event.reason === "error" || event.reason === "content-filter"
                              ? "error"
                              : "completed"
                    const openai = event.providerMetadata?.openai
                    const bedrock = event.providerMetadata?.bedrock
                    // Anthropic reports the served speed ("fast" | "standard") in raw
                    // usage. Timing-only: it verifies fast mode without changing pricing.
                    const anthropic = event.providerMetadata?.anthropic
                    const speed =
                      isRecord(anthropic) && isRecord(anthropic.usage) && typeof anthropic.usage.speed === "string"
                        ? anthropic.usage.speed
                        : undefined
                    const tier = openai?.serviceTier ?? bedrock?.serviceTier ?? speed
                    const returnedTier =
                      typeof tier === "string"
                        ? tier
                        : tier && typeof tier === "object" && "type" in tier && typeof tier.type === "string"
                          ? tier.type
                          : undefined
                    timing.metadata({
                      ...(returnedTier !== undefined ? { returnedTier } : {}),
                      ...(typeof openai?.modelId === "string" ? { resolvedModelID: openai.modelId } : {}),
                    })
                  }
                }),
              ),
              Stream.onExit((exit) =>
                Effect.sync(() =>
                  timing.requestOutcome(
                    Exit.isFailure(exit) ? (Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "error") : outcome,
                  ),
                ),
              ),
            )
          }),
        ),
      ).pipe(
        SessionUsage.track({
          sessionID: SessionID.make(input.sessionID),
          kind: input.usageKind ?? (input.small ? "auxiliary" : "assistant"),
          model: input.model,
          serviceTier: input.user.model.serviceTier,
        }),
      )

    return Service.of({ stream, warm: warming.warm, cancelWarm: warming.cancel })
  }),
)

export const layer = live.pipe(Layer.provide([Permission.defaultLayer, LLMWarm.layer]))

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(
      // Use the pooled WebSocket executor so OpenAI's WebSocket Responses mode
      // can actually deliver its latency win. Without pooling, every
      // LLMClient.stream() call would do a fresh TLS+WS handshake and the
      // connection-scoped server cache (the article's biggest optimization)
      // would be cold on every request. See
      // packages/llm/src/route/transport/websocket.ts for the pool's lifetime
      // rules (55-minute maximum reuse age, five-minute idle retention).
      LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.poolLayer()))),
    ),
    Layer.provide(RuntimeFlags.defaultLayer),
  ),
)

export const hasToolCalls = LLMRequestPrep.hasToolCalls

export * as LLM from "./llm"
