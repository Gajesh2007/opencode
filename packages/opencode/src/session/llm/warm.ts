import os from "node:os"
import { createHash } from "node:crypto"
import { asSchema } from "ai"
import { Clock, Context, Effect, Fiber, Layer, Scope, Stream } from "effect"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { ProviderTransform } from "@/provider/transform"
import { isRecord } from "@/util/record"
import { SystemPrompt } from "../system"
import { SessionID } from "../schema"
import { SessionUsage } from "../usage"
import { LLMNativeRuntime } from "./native-runtime"
import { LLMNative } from "./native-request"
import type { LLMRequestPrep } from "./request"

export type Selection = {
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly providerID: string
  readonly modelID: string
  readonly agent?: string
  readonly variant?: string
  readonly serviceTier?: string
  readonly upstream?: string
  readonly context?: boolean
}

export type Result = {
  readonly connection: "warmed" | "skipped" | "failed"
  readonly context: "scheduled" | "fresh" | "skipped" | "busy"
}

export type Capture = {
  readonly native: boolean
  readonly toolChoice?: "auto" | "required" | "none"
  readonly selection: Selection
  readonly model: Provider.Model
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly prepared: LLMRequestPrep.Prepared
}

export interface Interface {
  readonly warm: (selection: Selection) => Effect.Effect<Result>
  readonly capture: (input: Capture) => Effect.Effect<void>
  readonly cancel: (sessionID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLMWarm") {}

const FRESH_MS = 15 * 60 * 1000
const LIMIT = 32
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const selectionKey = (input: Selection) =>
  hash([
    input.sessionID,
    input.parentSessionID ?? null,
    input.providerID,
    input.modelID,
    input.agent ?? null,
    input.variant ?? null,
    input.serviceTier ?? null,
    input.upstream ?? "default",
  ])

function safe(model: Provider.Model, provider: Provider.Info) {
  if (model.providerID !== provider.id || model.api.npm !== "@ai-sdk/openai") return false
  if (provider.id !== ProviderID.openai && provider.id !== ProviderID.openaiCodex) return false
  if (model.options.fetch !== undefined) return false
  if (provider.id === ProviderID.openai && provider.options.fetch !== undefined) return false
  const url = provider.options.baseURL ?? model.api.url ?? "https://api.openai.com/v1"
  if (typeof url !== "string" || !URL.canParse(url)) return false
  const parsed = new URL(url)
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false
  return provider.id === ProviderID.openai
    ? parsed.origin === "https://api.openai.com" && ["/v1", "/v1/"].includes(parsed.pathname)
    : (parsed.origin === "https://api.openai.com" && ["/v1", "/v1/"].includes(parsed.pathname)) ||
        (parsed.origin === "https://chatgpt.com" &&
          ["/backend-api/codex", "/backend-api/codex/"].includes(parsed.pathname))
}

// Direct Anthropic requests go through the AI SDK and Bun's shared fetch pool,
// so a connection opened here is reused by the next real request. Returns the
// exact Messages endpoint the SDK will POST to, or undefined when a plugin
// fetch or non-HTTPS endpoint could route the request elsewhere.
export function anthropicEndpoint(model: Provider.Model, provider: Provider.Info) {
  if (model.providerID !== ProviderID.anthropic || provider.id !== ProviderID.anthropic) return undefined
  if (model.api.npm !== "@ai-sdk/anthropic") return undefined
  if (model.options.fetch !== undefined || provider.options.fetch !== undefined) return undefined
  const base =
    provider.options.baseURL || model.api.url || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1"
  if (typeof base !== "string" || !URL.canParse(base)) return undefined
  const url = new URL(base)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/messages`
}

function headers(selection: Selection, model: Provider.Model) {
  const tier = selection.serviceTier && model.serviceTiers?.[selection.serviceTier]
  return {
    "x-session-affinity": selection.sessionID,
    ...(selection.parentSessionID ? { "x-parent-session-id": selection.parentSessionID } : {}),
    "User-Agent": `opencode/${InstallationVersion}`,
    ...model.headers,
    ...(tier && isRecord(tier.headers) ? tier.headers : {}),
    ...(model.providerID === ProviderID.openaiCodex
      ? {
          originator: "opencode",
          "User-Agent": `opencode/${InstallationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`,
          session_id: selection.sessionID,
        }
      : {}),
  } as Record<string, string>
}

function optionsSafe(options: Record<string, unknown>, sessionID: string) {
  return Object.entries(options).every(([key, value]) => {
    if (value === undefined) return true
    if (key === "promptCacheKey") return value === sessionID
    if (["store", "contextWarming", "responsesContinuation", "parallelToolCalls", "forceReasoning"].includes(key))
      return typeof value === "boolean"
    if (key === "transport") return value === "http" || value === "websocket"
    if (key === "reasoningEffort")
      return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value))
    if (key === "reasoningSummary") return ["auto", "concise", "detailed"].includes(String(value))
    if (key === "textVerbosity") return ["low", "medium", "high"].includes(String(value))
    if (key === "serviceTier") return ["auto", "default", "flex", "priority", "ultrafast"].includes(String(value))
    if (key === "promptCacheRetention") return value === "in-memory" || value === "24h"
    if (key === "include") return Array.isArray(value) && value.every((x) => x === "reasoning.encrypted_content")
    if (key === "promptCacheOptions")
      return (
        isRecord(value) &&
        Object.keys(value).every((x) => x === "mode") &&
        ["explicit", "implicit"].includes(String(value.mode))
      )
    return false
  })
}

// Projection happens before retention: no messages, execution closures, or
// arbitrary provider instructions enter the snapshot map.
export function snapshot(input: Capture) {
  const prefix = input.prepared.warmPrefix
  if (!prefix || prefix !== SystemPrompt.provider(input.model).join("\n")) return undefined
  if (input.prepared.messages[0]?.role !== "system" || input.prepared.messages[0]?.content !== prefix) return undefined
  if (!safe(input.model, input.provider) || input.provider.id !== ProviderID.openai) return undefined
  if (
    input.prepared.params.options.serviceTier !== undefined &&
    input.prepared.params.options.serviceTier !== "default"
  )
    return undefined
  // Only capture a path known to have used this same native serialization.
  // SDK paths differ in system roles, invalid tools, and strict tool options.
  if (
    !input.native ||
    !/^gpt-(?:6[.-]1-sol|6-astra)(?:-\d{4}-\d{2}-\d{2})?$/.test(input.model.api.id) ||
    LLMNativeRuntime.status(input).type !== "supported" ||
    LLMNative.unsupportedCacheOrdering(input.prepared.messages)
  )
    return undefined
  if (!optionsSafe(input.prepared.params.options, input.selection.sessionID)) return undefined
  if (hash(input.prepared.headers) !== hash(headers(input.selection, input.model))) return undefined
  if (Object.values(input.prepared.tools).some((tool) => tool.type === "provider" || tool.strict !== undefined))
    return undefined
  const tools = Object.fromEntries(
    Object.entries(input.prepared.tools).map(([name, tool]) => [
      name,
      {
        description: tool.description,
        inputSchema: asSchema(tool.inputSchema).jsonSchema,
      },
    ]),
  )
  const serialized = JSON.stringify({ prefix, tools })
  // Use a deliberately conservative byte/token estimate; never truncate a prefix or tool table.
  if (Buffer.byteLength(serialized) > 64 * 1024 || Buffer.byteLength(serialized) / 3 > 8000) return undefined
  return JSON.parse(
    JSON.stringify({
      prefix,
      tools,
      toolChoice: input.toolChoice,
      options: input.prepared.params.options,
      headers: input.prepared.headers,
    }),
  ) as {
    prefix: string
    tools: typeof tools
    toolChoice?: Capture["toolChoice"]
    options: Record<string, unknown>
    headers: Record<string, string>
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const client = yield* LLMClient.Service
    // Shared across this layer's instances, rather than two jobs per directory.
    const budget = { active: 0 }
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        const snapshots = new Map<
          string,
          NonNullable<ReturnType<typeof snapshot>> & { key: string; owner: string; time: number; attempt?: number }
        >()
        const jobs = new Map<string, Fiber.Fiber<unknown, unknown>>()
        const guards = new Map<string, symbol>()
        const connections = new Map<string, number>()
        return { scope, snapshots, jobs, guards, connections }
      }),
    )
    const owner = (
      model: Provider.Model,
      item: Provider.Info,
      info: Auth.Info | undefined,
      cfg: Config.Info,
      toolChoice?: Capture["toolChoice"],
    ) =>
      hash({
        model,
        provider: item.options,
        key: item.key,
        auth: Auth.fingerprint(info),
        config: cfg,
        toolChoice: toolChoice ?? null,
      })
    const cancel = Effect.fnUntraced(function* (sessionID: string) {
      const local = yield* InstanceState.get(state)
      const job = local.jobs.get(sessionID)
      if (job) yield* Fiber.interrupt(job).pipe(Effect.forkIn(local.scope))
      local.jobs.delete(sessionID)
      local.guards.delete(sessionID)
      return local
    })
    const capture = Effect.fn("LLMWarm.capture")(
      function* (input: Capture) {
        const local = yield* cancel(input.selection.sessionID)
        local.snapshots.delete(input.selection.sessionID)
        const cfg = yield* config.get()
        if (cfg.plugin?.length) return
        const value = snapshot(input)
        if (!value) return
        if (local.snapshots.size >= LIMIT) {
          const oldest = local.snapshots.keys().next().value
          if (oldest) {
            yield* cancel(oldest)
            local.snapshots.delete(oldest)
          }
        }
        local.snapshots.set(input.selection.sessionID, {
          ...value,
          key: selectionKey(input.selection),
          owner: owner(input.model, input.provider, input.auth, cfg, input.toolChoice),
          time: yield* Clock.currentTimeMillis,
        })
      },
      Effect.catchCause(() => Effect.void),
    )

    const warm = Effect.fn("LLMWarm.warm")(
      function* (selection: Selection) {
        const previous = yield* InstanceState.get(state)
        const [model, item, info, cfg] = yield* Effect.all([
          provider.getModel(ProviderID.make(selection.providerID), ModelID.make(selection.modelID)),
          provider.getProvider(ProviderID.make(selection.providerID)),
          auth.get(selection.providerID),
          config.get(),
        ])
        if (
          previous.jobs.has(selection.sessionID) &&
          previous.snapshots.get(selection.sessionID)?.key === selectionKey(selection) &&
          previous.snapshots.get(selection.sessionID)?.owner ===
            owner(model, item, info, cfg, previous.snapshots.get(selection.sessionID)?.toolChoice)
        )
          return { connection: "skipped", context: "busy" } as const
        const local = yield* cancel(selection.sessionID)
        const now = yield* Clock.currentTimeMillis
        const last = local.connections.get(selection.sessionID)
        if (last !== undefined && now - last < 60_000) return { connection: "skipped", context: "skipped" } as const
        if (local.guards.size >= LIMIT) {
          const oldest = local.guards.keys().next().value
          if (oldest) yield* cancel(oldest)
        }
        const guard = Symbol()
        local.guards.set(selection.sessionID, guard)
        // Publish the scoped child before the caller can be interrupted. A
        // fast child may reach network IO before forkIn returns to its parent.
        const run = <A, E>(job: Effect.Effect<A, E>) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const running = yield* job.pipe(
                Effect.forkIn(local.scope, { uninterruptible: false, startImmediately: false }),
              )
              local.jobs.set(selection.sessionID, running)
              const deadline = yield* Effect.sleep("10 seconds").pipe(
                Effect.andThen(Fiber.interrupt(running)),
                Effect.forkIn(local.scope, { uninterruptible: false }),
              )
              return yield* restore(Fiber.join(running)).pipe(Effect.ensuring(Fiber.interrupt(deadline)))
            }),
          )
        return yield* Effect.gen(function* () {
          const anthropic = anthropicEndpoint(model, item)
          if (!anthropic && (cfg.plugin?.length || !safe(model, item)))
            return { connection: "skipped", context: "skipped" } as const
          if (local.connections.size >= LIMIT) {
            const oldest = local.connections.keys().next().value
            if (oldest) local.connections.delete(oldest)
          }
          local.connections.delete(selection.sessionID)
          local.connections.set(selection.sessionID, now)
          if (anthropic) {
            // Bun 1.3's fetch.preconnect rejects default-port URLs ("Invalid
            // port"), so open the socket with an unauthenticated HEAD instead.
            // It carries no credentials or content and resolves in one round
            // trip; draining the body returns the socket to the shared pool.
            const connection = yield* run(
              Effect.tryPromise((signal) =>
                fetch(anthropic, { method: "HEAD", signal }).then((response) => response.arrayBuffer()),
              ).pipe(
                Effect.as("warmed" as const),
                Effect.catchCause(() => Effect.succeed("failed" as const)),
              ),
            )
            if (local.guards.get(selection.sessionID) === guard) local.jobs.delete(selection.sessionID)
            return { connection, context: "skipped" } as const
          }
          const options: Record<string, unknown> = {
            ...ProviderTransform.options({ model, sessionID: selection.sessionID, providerOptions: item.options }),
            ...model.options,
            ...(selection.variant ? model.variants?.[selection.variant] : {}),
            ...(selection.serviceTier === "default" ? { serviceTier: "default" } : {}),
            ...(selection.serviceTier ? model.serviceTiers?.[selection.serviceTier] : {}),
          }
          const input = {
            model,
            provider: info?.type === "api" && item.options.apiKey === undefined ? { ...item, key: info.key } : item,
            auth: info,
            llmClient: client,
            messages: [],
            tools: {},
            headers: headers(selection, model),
            providerOptions: options,
            abort: new AbortController().signal,
          }
          const connection = yield* run(
            LLMNativeRuntime.preconnect(input).pipe(
              Effect.map((ok) => (ok ? ("warmed" as const) : ("skipped" as const))),
              Effect.catchCause(() => Effect.succeed("failed" as const)),
            ),
          )
          if (local.guards.get(selection.sessionID) !== guard) return { connection, context: "skipped" } as const
          local.jobs.delete(selection.sessionID)
          const saved = local.snapshots.get(selection.sessionID)
          if (
            !saved ||
            saved.key !== selectionKey(selection) ||
            saved.owner !== owner(model, item, info, cfg, saved.toolChoice)
          )
            return { connection, context: "skipped" } as const
          // Live capability checks reject prewarm on Ultrafast (HTTP 400).
          // Standard-tier prewarming did not populate Ultrafast's cache. Never
          // change the selected tier; only explicitly opted-in standard native
          // requests have a verified paid prewarm path.
          if (saved.options.serviceTier !== undefined && saved.options.serviceTier !== "default")
            return { connection, context: "skipped" } as const
          if (
            (options.contextWarming ?? item.options.contextWarming) === false ||
            saved.options.contextWarming !== true
          )
            return { connection, context: "skipped" } as const
          if ((yield* Clock.currentTimeMillis) - saved.time < FRESH_MS) return { connection, context: "fresh" } as const
          if (saved.attempt !== undefined && now - saved.attempt < 60_000)
            return { connection, context: "busy" } as const
          if (budget.active >= 2) return { connection, context: "busy" } as const
          const request = LLMNativeRuntime.warmRequest(
            {
              ...input,
              messages: [
                {
                  role: "system",
                  content: saved.prefix,
                  providerOptions: { openai: { promptCacheBreakpoint: { mode: "explicit" } } },
                },
              ],
              headers: saved.headers,
              toolChoice: saved.toolChoice,
              providerOptions: {
                ...saved.options,
                store: false,
                promptCacheOptions: { mode: "explicit", prewarm: true },
              },
            },
            saved.tools,
          )
          if (!request) return { connection, context: "skipped" } as const
          budget.active++
          saved.attempt = yield* Clock.currentTimeMillis
          const job = Effect.gen(function* () {
            const [latest, freshConfig, freshModel, freshProvider] = yield* Effect.all([
              auth.get(selection.providerID),
              config.get(),
              provider.getModel(ProviderID.make(selection.providerID), ModelID.make(selection.modelID)),
              provider.getProvider(ProviderID.make(selection.providerID)),
            ])
            if (
              owner(freshModel, freshProvider, latest, freshConfig, saved.toolChoice) !== saved.owner ||
              local.guards.get(selection.sessionID) !== guard
            )
              return
            const terminal = { success: false }
            yield* client.stream(request).pipe(
              Stream.provideService(RequestExecutor.RetryLimit, 0),
              SessionUsage.track({
                sessionID: SessionID.make(selection.sessionID),
                kind: "auxiliary",
                model: freshModel,
                serviceTier: "default",
              }),
              Stream.runForEach((event) => {
                if (["step-start", "response-metadata", "step-finish", "finish"].includes(event.type)) {
                  if (event.type === "finish") terminal.success = event.reason === "stop" && !event.usage?.outputTokens
                  return Effect.void
                }
                return Effect.fail(new Error("Unexpected prewarm output"))
              }),
            )
            if (terminal.success) saved.time = yield* Clock.currentTimeMillis
          }).pipe(
            Effect.catchCause(() => Effect.void),
            Effect.ensuring(
              Effect.sync(() => {
                budget.active--
                if (local.guards.get(selection.sessionID) === guard) local.jobs.delete(selection.sessionID)
              }),
            ),
          )
          yield* run(job)
          return { connection, context: "scheduled" } as const
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              if (local.guards.get(selection.sessionID) !== guard) return
              const running = local.jobs.get(selection.sessionID)
              local.jobs.delete(selection.sessionID)
              local.guards.delete(selection.sessionID)
              if (running) yield* Fiber.interrupt(running)
            }),
          ),
        )
      },
      Effect.catchCause(() => Effect.succeed({ connection: "failed", context: "skipped" } as const)),
    )
    return Service.of({
      capture,
      warm,
      cancel: (sessionID) =>
        cancel(sessionID).pipe(
          Effect.tap((local) => Effect.sync(() => local.snapshots.delete(sessionID))),
          Effect.asVoid,
        ),
    })
  }),
)

export * as LLMWarm from "./warm"
