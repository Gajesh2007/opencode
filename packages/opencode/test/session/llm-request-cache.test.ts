import { expect } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { createAzure } from "@ai-sdk/azure"
import { createBedrockMantle } from "@ai-sdk/amazon-bedrock/mantle"
import { LLMClient } from "@opencode-ai/llm/route"
import { generateText, jsonSchema, tool, type ModelMessage } from "ai"
import { Effect, Layer } from "effect"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { ProviderTransform } from "@/provider/transform"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { LLMRequestPrep } from "@/session/llm/request"
import { LLMNative } from "@/session/llm/native-request"
import { MessageID, SessionID } from "@/session/schema"
import { Permission } from "@/permission"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const input = (npm: string, mode?: "explicit" | "implicit") => {
  const model: Provider.Model = {
    id: ModelID.make("gpt-6.1-sol"),
    providerID: ProviderID.openai,
    api: { id: "gpt-6.1-sol", url: "https://api.openai.com/v1", npm },
    name: "GPT-6.1 Sol",
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: true,
      toolcall: true,
      interleaved: false,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128000, output: 32000 },
    status: "active",
    options: mode ? { promptCacheOptions: { mode } } : {},
    headers: {},
    release_date: "2026-01-01",
  }
  const sessionID = SessionID.make("ses_explicit_cache")
  const messages: ModelMessage[] = [
    {
      role: "system",
      content: "Plugin's stable instructions",
      providerOptions: {
        ...ProviderTransform.providerOptions(model, { pluginSetting: "keep" }),
        plugin: { keep: true },
      },
    },
    {
      role: "user",
      content: [{ type: "text", text: "Changing question", providerOptions: { plugin: { keep: true } } }],
    },
  ]
  return {
    sessionID,
    model,
    provider: { id: model.providerID, name: "OpenAI", source: "config", env: [], options: {}, models: {} },
    user: {
      id: MessageID.make("msg_explicit_cache"),
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: model.providerID, modelID: model.id },
    },
    agent: { name: "build", mode: "primary", permission: [], options: {} },
    system: ["Stable application instructions"],
    messages,
    tools: {},
    auth: undefined,
    plugin: {
      init: () => Effect.void,
      list: () => Effect.succeed([]),
      trigger: (_name, _input, output) => Effect.succeed(output),
    },
    flags: { client: "test" } as RuntimeFlags.Info,
    isWorkflow: false,
  } satisfies Parameters<typeof LLMRequestPrep.prepare>[0]
}

const accessCases: {
  name: string
  permission: Parameters<typeof Permission.fromConfig>[0]
  tools: Record<string, boolean>
  expected: string[]
}[] = [
  { name: "read tool toggle", permission: { "*": "allow" }, tools: { read: false }, expected: [] },
  { name: "read permission", permission: { "*": "allow", read: "deny" }, tools: {}, expected: [] },
  { name: "batch-only toggle", permission: { "*": "allow" }, tools: { read_many: false }, expected: ["read"] },
  { name: "read-only agent", permission: { "*": "deny", read: "allow" }, tools: {}, expected: ["read", "read_many"] },
]
for (const entry of accessCases) {
  it.effect(`read_many respects ${entry.name}`, () =>
    Effect.gen(function* () {
      const original = input("@ai-sdk/openai")
      const read = tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => "text" })
      const prepared = yield* LLMRequestPrep.prepare({
        ...original,
        agent: { ...original.agent, permission: Permission.fromConfig(entry.permission) },
        user: { ...original.user, tools: entry.tools },
        tools: { read, read_many: read },
      })
      expect(Object.keys(prepared.tools)).toEqual([...entry.expected])
    }),
  )
}

for (const entry of [
  { npm: "@ai-sdk/openai", key: "openai", create: createOpenAI },
  { npm: "@ai-sdk/azure", key: "azure", create: createAzure },
  { npm: "@ai-sdk/amazon-bedrock/mantle", key: "openai", create: createBedrockMantle },
]) {
  for (const mode of ["explicit", "implicit", undefined] as const) {
    it.effect(`${entry.npm} ${mode ?? "default"} config preserves messages and marks only explicit system prefix`, () =>
      Effect.gen(function* () {
        const original = input(entry.npm, mode)
        const prepared = yield* LLMRequestPrep.prepare(original)
        expect(prepared.messages[0].providerOptions).toBeUndefined()
        expect(prepared.messages[1]).toMatchObject(original.messages[0])
        expect(prepared.messages[2]).toBe(original.messages[1])
        expect(original.messages[0].providerOptions?.[entry.key]).not.toHaveProperty("promptCacheBreakpoint")
        if (mode === "explicit") {
          expect(prepared.messages[1].providerOptions?.[entry.key]).toEqual({
            pluginSetting: "keep",
            promptCacheBreakpoint: { mode: "explicit" },
          })
          if (entry.key === "azure")
            expect(prepared.messages[1].providerOptions?.openai).toMatchObject({
              promptCacheBreakpoint: { mode: "explicit" },
            })
        } else expect(prepared.messages[1]).toBe(original.messages[0])

        const bodies: unknown[] = []
        yield* Effect.promise(() =>
          generateText({
            model: entry
              .create({
                apiKey: "test-key",
                resourceName: "cache-test",
                region: "us-east-1",
                fetch: Object.assign(
                  async (url: RequestInfo | URL, init?: RequestInit) => {
                    bodies.push(await new Request(url, init).json())
                    return Response.json({
                      id: "resp_cache",
                      created_at: 1,
                      model: "gpt-6.1-sol",
                      output: [
                        {
                          type: "message",
                          id: "msg_1",
                          role: "assistant",
                          content: [{ type: "output_text", text: "ok", annotations: [] }],
                        },
                      ],
                      usage: { input_tokens: 10, output_tokens: 1 },
                    })
                  },
                  { preconnect() {} },
                ),
              })
              .responses("gpt-6.1-sol"),
            messages: prepared.messages,
            providerOptions: ProviderTransform.providerOptions(original.model, prepared.params.options),
            maxRetries: 0,
          }),
        )
        expect(bodies).toHaveLength(1)
        expect(bodies[0]).toMatchObject({
          input: [
            { role: "developer" },
            {
              role: "developer",
              content:
                mode === "explicit"
                  ? [
                      {
                        type: "input_text",
                        text: "Plugin's stable instructions",
                        prompt_cache_breakpoint: { mode: "explicit" },
                      },
                    ]
                  : "Plugin's stable instructions",
            },
            { role: "user", content: [{ type: "input_text", text: "Changing question" }] },
          ],
        })
        if (mode) expect(bodies[0]).toHaveProperty("prompt_cache_options.mode", mode)
        else expect(bodies[0]).not.toHaveProperty("prompt_cache_options")
      }),
    )
  }
}

for (const kind of ["codex", "workflow", "unsupported", "no-system"] as const) {
  it.effect(`does not insert an automatic cache marker for ${kind}`, () =>
    Effect.gen(function* () {
      const original = input(kind === "unsupported" ? "@ai-sdk/openai-compatible" : "@ai-sdk/openai", "explicit")
      if (kind === "codex") {
        original.provider.id = ProviderID.openaiCodex
        original.model.providerID = ProviderID.openaiCodex
      }
      const prepared = yield* LLMRequestPrep.prepare({
        ...original,
        isWorkflow: kind === "workflow",
        ...(kind === "no-system"
          ? {
              plugin: {
                ...original.plugin,
                trigger: (_name, _input, output) => {
                  if (
                    typeof output === "object" &&
                    output !== null &&
                    "system" in output &&
                    Array.isArray(output.system)
                  )
                    output.system.length = 0
                  return Effect.succeed(output)
                },
              },
              messages: [original.messages[1]],
            }
          : {}),
      })
      expect(JSON.stringify(prepared.messages)).not.toContain("promptCacheBreakpoint")
      if (kind === "workflow") expect(prepared.messages).toBe(original.messages)
    }),
  )
}

it.effect("marks generated system instructions without a plugin and preserves the native wire boundary", () =>
  Effect.gen(function* () {
    const original = input("@ai-sdk/openai", "explicit")
    const prepared = yield* LLMRequestPrep.prepare({ ...original, messages: [original.messages[1]] })
    expect(prepared.messages[0]).toMatchObject({
      role: "system",
      providerOptions: { openai: { promptCacheBreakpoint: { mode: "explicit" } } },
    })
    const native = yield* LLMClient.prepare(
      LLMNative.request({
        model: original.model,
        apiKey: "test-key",
        messages: prepared.messages,
        providerOptions: ProviderTransform.providerOptions(original.model, prepared.params.options),
      }),
    )
    expect(native.body).toMatchObject({
      prompt_cache_options: { mode: "explicit" },
      input: [
        { role: "developer", content: [{ type: "input_text", prompt_cache_breakpoint: { mode: "explicit" } }] },
        { role: "user", content: [{ type: "input_text", text: "Changing question" }] },
      ],
    })
  }),
)

it.effect("preserves explicit breakpoints already supplied by plugins", () =>
  Effect.gen(function* () {
    const original = input("@ai-sdk/openai", "explicit")
    const message: ModelMessage = {
      role: "system",
      content: "Plugin boundary",
      providerOptions: { openai: { promptCacheBreakpoint: { mode: "explicit" }, pluginSetting: "keep" } },
    }
    const prepared = yield* LLMRequestPrep.prepare({ ...original, messages: [message, original.messages[1]] })
    expect(prepared.messages[1]).toEqual(message)
  }),
)
