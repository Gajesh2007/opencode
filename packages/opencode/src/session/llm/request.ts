import type { Auth } from "@/auth"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "../message-v2"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "../system"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Record } from "effect"
import { jsonSchema, tool as aiTool, type ModelMessage, type Tool } from "ai"
import type { Plugin } from "@/plugin"
import { mergeDeep } from "remeda"

const USER_AGENT = `opencode/${InstallationVersion}`

type PrepareInput = {
  readonly user: MessageV2.User
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly permission?: Permission.Ruleset
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly small?: boolean
  readonly tools: Record<string, Tool>
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly plugin: Plugin.Interface
  readonly flags: RuntimeFlags.Info
  readonly isWorkflow: boolean
  readonly previousResponseId?: string
}

export type Prepared = {
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, any>
  }
  readonly messageTransformOptions: Record<string, any>
  readonly headers: Record<string, string>
}

const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  const isOpenaiOauth = input.provider.id === "openai" && input.auth?.type === "oauth"
  const system = [
    [
      ...SystemPrompt.provider(input.model),
      ...(input.agent.prompt ? [input.agent.prompt] : []),
      ...input.system,
      ...(input.user.system ? [input.user.system] : []),
    ]
      .filter((x) => x)
      .join("\n"),
  ]

  const header = system[0]
  yield* input.plugin.trigger(
    "experimental.chat.system.transform",
    { sessionID: input.sessionID, model: input.model },
    { system },
  )
  if (system.length > 2 && system[0] === header) {
    const rest = system.slice(1)
    system.length = 0
    system.push(header, rest.join("\n"))
  }

  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
  const reasoningMode =
    !input.small && ProviderTransform.supportsReasoningMode(input.model, input.user.model.reasoningMode)
      ? { reasoningMode: input.user.model.reasoningMode }
      : {}
  // serviceTier entries may carry a `headers` field for headers the provider
  // requires alongside the body change (e.g. anthropic-beta for fast mode).
  // The @ai-sdk/anthropic provider currently auto-adds the fast-mode beta
  // header on its own when speed === "fast", but explicit headers stay
  // supported for future tiers that don't have SDK auto-injection.
  const tierEntry =
    !input.small && input.model.serviceTiers && input.user.model.serviceTier
      ? input.model.serviceTiers[input.user.model.serviceTier]
      : undefined
  const tierHeaders: Record<string, string> = (tierEntry?.headers as Record<string, string> | undefined) ?? {}
  const tierOptions = tierEntry ? Object.fromEntries(Object.entries(tierEntry).filter(([k]) => k !== "headers")) : {}
  // Upstream pin: when the user pinned a specific provider via /provider
  // (info.model.upstream), translate it to the provider-specific only-array
  // routing knob. Gateway uses providerOptions.gateway.only (Vercel docs);
  // OpenRouter uses providerOptions.openrouter.provider.only (OR docs).
  // For direct-provider routes there's no upstream to pin, so this is a no-op.
  // Merged AFTER the service tier so the tier's `only`/`order` (e.g.
  // sort-tier variants that set gateway.only) can't override an explicit
  // user pin.
  const upstreamOptions = (() => {
    if (input.small) return {}
    const pin = input.user.model.upstream
    if (!pin || pin === "default") return {}
    if (input.model.api.npm === "@ai-sdk/gateway") {
      return { gateway: { only: [pin] } }
    }
    if (input.model.api.npm === "@openrouter/ai-sdk-provider") {
      return { provider: { only: [pin] } }
    }
    return {}
  })()
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: input.provider.options,
      })
  // OpenAI Responses-API continuation. This is intentionally opt-in for now:
  // the provider returns `previous_response_not_found` if the server-side
  // response state cannot be resolved (for example, stale socket cache,
  // Gateway pooled credentials, or cross-account routing). Until we add a
  // robust retry-with-full-history fallback, keep the response-id capture on
  // but only send it when the user explicitly enables it via:
  //   provider.openai.options.responsesContinuation = true
  // or per-model:
  //   provider.openai.models["gpt-5.5"].options.responsesContinuation = true
  const responsesContinuation =
    input.model.options?.responsesContinuation === true || input.provider.options?.responsesContinuation === true
  const previousResponseOptions =
    !input.small && responsesContinuation && input.previousResponseId
      ? { openai: { previousResponseId: input.previousResponseId } }
      : {}
  const options = [
    input.model.options,
    input.agent.options,
    variant,
    reasoningMode,
    tierOptions,
    upstreamOptions,
    previousResponseOptions,
  ].reduce<Record<string, any>>((result, item) => mergeOptions(result, item), base)
  if (isOpenaiOauth) options.instructions = system.join("\n")

  const messages =
    isOpenaiOauth || input.isWorkflow
      ? input.messages
      : [
          ...system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          ),
          ...input.messages,
        ]

  const params = yield* input.plugin.trigger(
    "chat.params",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      temperature: input.model.capabilities.temperature
        ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
        : undefined,
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      maxOutputTokens: ProviderTransform.maxOutputTokens(input.model, input.flags.outputTokenMax),
      options,
    },
  )

  const { headers } = yield* input.plugin.trigger(
    "chat.headers",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      headers: {},
    },
  )

  const tools = resolveTools(input)
  if (
    input.model.providerID.includes("github-copilot") &&
    Object.keys(tools).length === 0 &&
    hasToolCalls(input.messages)
  ) {
    // Copilot needs a tools field when replaying prior tool calls, even if no tools are currently enabled.
    tools["_noop"] = aiTool({
      description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          reason: { type: "string", description: "Unused" },
        },
      }),
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })
  }

  const opencodeProjectID = input.model.providerID.startsWith("opencode")
    ? (yield* InstanceState.context).project.id
    : undefined

  return {
    system,
    messages,
    tools: Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b))),
    params,
    messageTransformOptions: options,
    headers: {
      ...(input.model.providerID.startsWith("opencode")
        ? {
            ...(opencodeProjectID ? { "x-opencode-project": opencodeProjectID } : {}),
            "x-opencode-session": input.sessionID,
            "x-opencode-request": input.user.id,
            "x-opencode-client": input.flags.client,
            "User-Agent": USER_AGENT,
          }
        : {
            "x-session-affinity": input.sessionID,
            ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
            "User-Agent": USER_AGENT,
          }),
      ...input.model.headers,
      ...tierHeaders,
      ...headers,
    },
  }
})

function resolveTools(input: Pick<PrepareInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLMRequestPrep from "./request"
