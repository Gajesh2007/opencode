import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { Agent } from "@/agent/agent"
import type { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { ProviderTransform } from "@/provider/transform"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { LLMRequestPrep } from "@/session/llm/request"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"

test("merges GPT-5.6 Pro mode independently from Gateway reasoning effort", async () => {
  const model = {
    id: ModelID.make("openai/gpt-5-6-sol"),
    providerID: ProviderID.make("vercel"),
    api: {
      id: "openai/gpt-5-6-sol",
      url: "https://ai-gateway.vercel.sh/v3/ai",
      npm: "@ai-sdk/gateway",
    },
    name: "GPT-5.6 Sol",
    family: "gpt",
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 5, output: 30, cache: { read: 0.5, write: 6.25 } },
    limit: { context: 1_050_000, output: 128_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-07-09",
    variants: { high: { reasoningEffort: "high" } },
    serviceTiers: {},
    upstreams: [],
  } satisfies Provider.Model
  const sessionID = SessionID.make("ses_pro_mode")
  const user = {
    id: MessageID.make("msg_pro_mode"),
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: {
      providerID: model.providerID,
      modelID: model.id,
      variant: "high",
      reasoningMode: "pro",
    },
  } satisfies MessageV2.User
  const agent = {
    name: "build",
    mode: "primary",
    permission: [],
    options: {},
  } satisfies Agent.Info
  const provider = {
    id: model.providerID,
    name: "Vercel AI Gateway",
    source: "config",
    env: [],
    options: {},
    models: { [model.id]: model },
  } satisfies Provider.Info

  const prepared = await Effect.runPromise(
    LLMRequestPrep.prepare({
      user,
      sessionID,
      model,
      agent,
      system: [],
      messages: [{ role: "user", content: "hello" }],
      tools: {},
      provider,
      auth: undefined,
      plugin: {
        init: () => Effect.void,
        list: () => Effect.succeed([]),
        trigger: ((_name: unknown, _input: unknown, output: unknown) =>
          Effect.succeed(output)) as Plugin.Interface["trigger"],
      },
      flags: { outputTokenMax: undefined, client: "test" } as RuntimeFlags.Info,
      isWorkflow: false,
    }),
  )

  expect(prepared.params.options).toMatchObject({
    reasoningEffort: "high",
    reasoningMode: "pro",
  })
  expect(ProviderTransform.providerOptions(model, prepared.params.options)).toMatchObject({
    openai: {
      reasoningEffort: "high",
      reasoningMode: "pro",
    },
  })
})

function anthropicRequest(input: {
  providerID?: string
  parentSessionID?: string
  small?: boolean
  options?: Record<string, unknown>
  variant?: string
}) {
  const model = {
    id: ModelID.make("claude-opus-5-5"),
    providerID: ProviderID.make(input.providerID ?? "anthropic"),
    api: { id: "claude-opus-5-5", url: "", npm: "@ai-sdk/anthropic" },
    name: "Claude Opus 5.5",
    family: "claude-opus",
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 4, output: 20, cache: { read: 0.2, write: 5 } },
    limit: { context: 1_000_000, output: 128_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-09-01",
    variants: { max: { thinking: { type: "adaptive", display: "summarized" }, effort: "max" } },
    serviceTiers: {},
    upstreams: [],
  } satisfies Provider.Model
  const sessionID = SessionID.make("ses_cache_ttl")
  return Effect.runPromise(
    LLMRequestPrep.prepare({
      user: {
        id: MessageID.make("msg_cache_ttl"),
        sessionID,
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: model.providerID, modelID: model.id, variant: input.variant },
      },
      sessionID,
      parentSessionID: input.parentSessionID,
      small: input.small,
      model,
      agent: { name: "build", mode: "primary", permission: [], options: {} },
      system: ["stable instructions"],
      messages: [
        { role: "user", content: "inspect" },
        { role: "assistant", content: [{ type: "text", text: "reading" }] },
        { role: "user", content: "continue" },
      ],
      tools: {},
      provider: {
        id: model.providerID,
        name: "Anthropic",
        source: "config",
        env: [],
        options: input.options ?? {},
        models: { [model.id]: model },
      },
      auth: undefined,
      plugin: {
        init: () => Effect.void,
        list: () => Effect.succeed([]),
        trigger: ((_name: unknown, _input: unknown, output: unknown) =>
          Effect.succeed(output)) as Plugin.Interface["trigger"],
      },
      flags: { outputTokenMax: undefined, client: "test" } as RuntimeFlags.Info,
      isWorkflow: false,
    }),
  ).then((prepared) => ({
    prepared,
    // The cache TTL each breakpoint receives once the SDK middleware runs.
    ttls: (ProviderTransform.message(prepared.messages, model, prepared.messageTransformOptions) as any[])
      .map((message) => {
        // Non-Anthropic provider IDs mark the last content part instead of the message.
        const part = Array.isArray(message.content) ? message.content.at(-1) : undefined
        const cache = (message.providerOptions ?? part?.providerOptions)?.anthropic?.cacheControl
        return cache?.ttl ?? cache?.type
      })
      .filter(Boolean),
  }))
}

test("primary Anthropic sessions keep the conversation tail cached for one hour", async () => {
  const { prepared, ttls } = await anthropicRequest({})
  expect(prepared.messageTransformOptions.promptCacheTtl).toBe("1h")
  // System prefix, then the last two conversation messages.
  expect(ttls).toEqual(["1h", "1h", "1h"])
  // The setting is consumed by message caching and never sent as a provider option.
  expect(prepared.params.options.promptCacheTtl).toBeUndefined()
})

test("subagent, auxiliary, and opted-out Anthropic requests keep the 5m tail", async () => {
  for (const input of [
    { parentSessionID: "ses_parent" },
    { small: true },
    { options: { promptCacheTtl: "5m" } },
    { providerID: "openrouter" },
  ]) {
    const { prepared, ttls } = await anthropicRequest(input)
    expect(prepared.messageTransformOptions.promptCacheTtl ?? "5m").toBe("5m")
    // A 1h system prefix may precede 5m breakpoints, never the reverse.
    expect(ttls).toEqual(["1h", "ephemeral", "ephemeral"])
  }
})

test("thinkingDisplay overrides the display pinned by effort variants", async () => {
  const pinned = await anthropicRequest({ variant: "max" })
  expect(pinned.prepared.params.options.thinking).toEqual({ type: "adaptive", display: "summarized" })

  const omitted = await anthropicRequest({ variant: "max", options: { thinkingDisplay: "omitted" } })
  expect(omitted.prepared.params.options.thinking).toEqual({ type: "adaptive", display: "omitted" })
  expect(omitted.prepared.params.options.effort).toBe("max")

  const base = await anthropicRequest({ options: { thinkingDisplay: "omitted" } })
  expect(base.prepared.params.options.thinking).toEqual({ type: "adaptive", display: "omitted" })
})
