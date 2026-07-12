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
