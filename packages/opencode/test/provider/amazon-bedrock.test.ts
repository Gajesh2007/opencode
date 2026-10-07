import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { unlink } from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import { Env } from "../../src/env"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Provider.defaultLayer, Env.defaultLayer))

const originalEnv = new Map<string, string | undefined>()

const set = (k: string, v: string | undefined) =>
  Effect.gen(function* () {
    if (!originalEnv.has(k)) originalEnv.set(k, process.env[k])
    if (v === undefined) {
      delete process.env[k]
      yield* Env.use.remove(k)
      return
    }
    process.env[k] = v
    yield* Env.use.set(k, v)
  })

afterEach(async () => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
  await disposeAllInstances()
})

const list = Provider.use.list()

const withAuthJson = (contents: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const authPath = path.join(Global.Path.data, "auth.json")
      let original: string | undefined
      try {
        original = await Filesystem.readText(authPath)
      } catch {
        original = undefined
      }
      await Filesystem.write(authPath, contents)
      return { authPath, original }
    }),
    ({ authPath, original }) =>
      Effect.promise(async () => {
        if (original !== undefined) {
          await Filesystem.write(authPath, original)
          return
        }
        await unlink(authPath).catch(() => undefined)
      }),
  )

it.instance(
  "Bedrock: config region takes precedence over AWS_REGION env var",
  () =>
    Effect.gen(function* () {
      yield* set("AWS_REGION", "us-east-1")
      yield* set("AWS_PROFILE", "default")
      const providers = yield* list
      expect(providers[ProviderID.amazonBedrock]).toBeDefined()
      expect(providers[ProviderID.amazonBedrock].options?.region).toBe("eu-west-1")
    }),
  { config: { provider: { "amazon-bedrock": { options: { region: "eu-west-1" } } } } },
)

it.instance("Bedrock: falls back to AWS_REGION env var when no config region", () =>
  Effect.gen(function* () {
    yield* set("AWS_REGION", "eu-west-1")
    yield* set("AWS_PROFILE", "default")
    const providers = yield* list
    expect(providers[ProviderID.amazonBedrock]).toBeDefined()
    expect(providers[ProviderID.amazonBedrock].options?.region).toBe("eu-west-1")
  }),
)

for (const entry of [
  {
    name: "Mantle uses configured region over AWS_REGION",
    npm: "@ai-sdk/amazon-bedrock/mantle",
    id: "openai.gpt-6-astra",
    apiID: "openai.gpt-6-astra",
    region: "eu-west-1",
    env: "us-east-1",
    expectedRegion: "eu-west-1",
    serviceTier: undefined,
  },
  {
    name: "Mantle uses AWS_REGION without a configured region",
    npm: "@ai-sdk/amazon-bedrock/mantle",
    id: "us.openai.gpt-6-astra-2026-06-10",
    apiID: "us.openai.gpt-6-astra-2026-06-10",
    region: undefined,
    env: "us-west-2",
    expectedRegion: "us-west-2",
    serviceTier: undefined,
  },
  {
    name: "Mantle uses the default region without AWS_REGION",
    npm: "@ai-sdk/amazon-bedrock/mantle",
    id: "global.openai.gpt-6-astra",
    apiID: "global.openai.gpt-6-astra",
    region: undefined,
    env: undefined,
    expectedRegion: "us-east-1",
    serviceTier: undefined,
  },
  {
    name: "OpenAI preserves the US ultrafast alias service tier",
    npm: "@ai-sdk/openai",
    id: "us.openai.gpt-6-astra-ultrafast",
    apiID: "us.openai.gpt-6-astra",
    region: "us-east-1",
    env: "us-west-2",
    expectedRegion: "us-east-1",
    serviceTier: "ultrafast",
  },
  ...["", "us.", "global."].map((prefix) => ({
    name: `Mantle uses Responses for ${prefix}Sol 6.1`,
    npm: "@ai-sdk/amazon-bedrock/mantle",
    id: `${prefix}openai.gpt-6.1-sol`,
    apiID: `${prefix}openai.gpt-6.1-sol`,
    region: "us-east-1",
    env: "us-west-2",
    expectedRegion: "us-east-1",
    serviceTier: undefined,
  })),
]) {
  it.instance(
    `Bedrock Responses: ${entry.name}`,
    () =>
      Effect.gen(function* () {
        yield* set("AWS_REGION", entry.env)
        yield* set("AWS_BEARER_TOKEN_BEDROCK", "test-bearer-token")
        const provider = yield* Provider.Service
        const info = yield* provider.getProvider(ProviderID.amazonBedrock)
        const requests: Request[] = []
        info.options.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init)
          requests.push(request)
          const response = {
            id: "resp_test",
            created_at: 1,
            model: entry.apiID,
            output: [],
            usage: { input_tokens: 1, output_tokens: 0 },
            service_tier: entry.serviceTier,
          }
          if (!(await request.clone().json()).stream) return Response.json(response)
          return new Response(
            ["response.created", "response.completed"]
              .map((type) => `data: ${JSON.stringify({ type, response })}\n\n`)
              .join(""),
            { headers: { "Content-Type": "text/event-stream" } },
          )
        }
        const model = yield* provider.getModel(ProviderID.amazonBedrock, ModelID.make(entry.id))
        const language = yield* provider.getLanguage(model)
        expect(language.provider).toBe(
          entry.npm === "@ai-sdk/openai" ? "amazon-bedrock.responses" : "bedrock-mantle.responses",
        )
        expect(language.modelId).toBe(entry.apiID)
        yield* Effect.promise(() =>
          language.doGenerate({
            maxOutputTokens: 1024,
            prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
            providerOptions: ProviderTransform.providerOptions(model, {
              ...ProviderTransform.options({ model, sessionID: "ses_bedrock_test" }),
              ...model.options,
              ...model.variants?.max,
            }),
          }),
        )
        expect(requests).toHaveLength(1)
        expect(requests[0].url).toBe(`https://bedrock-mantle.${entry.expectedRegion}.api.aws/v1/responses`)
        expect(requests[0].method).toBe("POST")
        expect(requests[0].headers.get("authorization")).toBe("Bearer test-bearer-token")
        const body = yield* Effect.promise(() => requests[0].json())
        expect(body).toMatchObject({
          model: entry.apiID,
          input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
          reasoning: { effort: "max", summary: "auto" },
          store: false,
          include: ["reasoning.encrypted_content"],
          max_output_tokens: 1024,
        })
        expect(body).not.toHaveProperty("max_tokens")
        expect(body).not.toHaveProperty("max_completion_tokens")
        expect(body.service_tier).toBe(entry.serviceTier)
        expect(Object.keys(model.variants ?? {})).toEqual(["low", "medium", "high", "xhigh", "max"])
        yield* Effect.promise(async () => {
          const result = await language.doStream({
            maxOutputTokens: 1024,
            prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
            providerOptions: ProviderTransform.providerOptions(model, {
              ...ProviderTransform.options({ model, sessionID: "ses_bedrock_test" }),
              ...model.options,
              ...model.variants?.low,
            }),
          })
          const reader = result.stream.getReader()
          const chunks = []
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            chunks.push(chunk.value)
          }
          expect(chunks.filter((chunk) => chunk.type === "error")).toEqual([])
          expect(chunks.at(-1)?.type).toBe("finish")
          expect(requests).toHaveLength(2)
          expect(requests[1].url).toBe(requests[0].url)
          expect(await requests[1].json()).toEqual({
            ...body,
            stream: true,
            reasoning: { effort: "low", summary: "auto" },
          })
        })
      }),
    {
      config: {
        provider: {
          "amazon-bedrock": {
            options: {
              region: entry.region,
              ...(entry.npm === "@ai-sdk/openai" ? { apiKey: "test-bearer-token" } : {}),
            },
            models: {
              [entry.id]: {
                id: entry.apiID,
                reasoning: true,
                provider: {
                  npm: entry.npm,
                  api: "https://bedrock-mantle.${AWS_REGION}.api.aws/v1",
                },
                options: { serviceTier: entry.serviceTier },
              },
            },
          },
        },
      },
    },
  )
}

it.instance(
  "Bedrock: native Claude retains Converse and chat-only Mantle retains Chat Completions",
  () =>
    Effect.gen(function* () {
      yield* set("AWS_BEARER_TOKEN_BEDROCK", "test-bearer-token")
      const provider = yield* Provider.Service
      const info = yield* provider.getProvider(ProviderID.amazonBedrock)
      const requests: Request[] = []
      info.options.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        requests.push(request)
        if (request.url.endsWith("/converse")) {
          return Response.json({
            output: { message: { role: "assistant", content: [{ text: "Hello" }] } },
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          })
        }
        return Response.json({
          id: "chat_test",
          created: 1,
          model: "openai.gpt-oss-safeguard-20b",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      }
      for (const entry of [
        {
          id: "global.anthropic.claude-opus-4-5-20251101-v1:0",
          provider: "amazon-bedrock",
          url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/global.anthropic.claude-opus-4-5-20251101-v1%3A0/converse",
        },
        {
          id: "openai.gpt-oss-safeguard-20b",
          provider: "bedrock-mantle.chat",
          url: "https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions",
        },
      ]) {
        const model = yield* provider.getModel(ProviderID.amazonBedrock, ModelID.make(entry.id))
        const language = yield* provider.getLanguage(model)
        expect(language.provider).toBe(entry.provider)
        expect(language.modelId).toBe(entry.id)
        const result = yield* Effect.promise(() =>
          language.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] }),
        )
        expect(result.content).toEqual([{ type: "text", text: "Hello" }])
        expect(requests.pop()?.url).toBe(entry.url)
      }
    }),
  {
    config: {
      provider: {
        "amazon-bedrock": {
          options: { region: "us-east-1" },
          models: {
            "global.anthropic.claude-opus-4-5-20251101-v1:0": {
              provider: { npm: "@ai-sdk/amazon-bedrock", api: "https://bedrock-runtime.${AWS_REGION}.amazonaws.com" },
            },
            "openai.gpt-oss-safeguard-20b": {
              provider: {
                npm: "@ai-sdk/amazon-bedrock/mantle",
                api: "https://bedrock-mantle.${AWS_REGION}.api.aws/v1",
              },
            },
          },
        },
      },
    },
  },
)

it.instance(
  "Bedrock: loads when bearer token from auth.json is present",
  () =>
    Effect.gen(function* () {
      yield* withAuthJson(JSON.stringify({ "amazon-bedrock": { type: "api", key: "test-bearer-token" } }))
      yield* set("AWS_PROFILE", "")
      yield* set("AWS_ACCESS_KEY_ID", "")
      yield* set("AWS_BEARER_TOKEN_BEDROCK", "")
      const providers = yield* list
      expect(providers[ProviderID.amazonBedrock]).toBeDefined()
      expect(providers[ProviderID.amazonBedrock].options?.region).toBe("eu-west-1")
    }),
  { config: { provider: { "amazon-bedrock": { options: { region: "eu-west-1" } } } } },
)

it.instance(
  "Bedrock: config profile takes precedence over AWS_PROFILE env var",
  () =>
    Effect.gen(function* () {
      yield* set("AWS_PROFILE", "default")
      yield* set("AWS_ACCESS_KEY_ID", "test-key-id")
      const providers = yield* list
      expect(providers[ProviderID.amazonBedrock]).toBeDefined()
      expect(providers[ProviderID.amazonBedrock].options?.region).toBe("us-east-1")
    }),
  {
    config: {
      provider: { "amazon-bedrock": { options: { profile: "my-custom-profile", region: "us-east-1" } } },
    },
  },
)

it.instance(
  "Bedrock: includes custom endpoint in options when specified",
  () =>
    Effect.gen(function* () {
      yield* set("AWS_PROFILE", "default")
      const providers = yield* list
      expect(providers[ProviderID.amazonBedrock]).toBeDefined()
      expect(providers[ProviderID.amazonBedrock].options?.endpoint).toBe(
        "https://bedrock-runtime.us-east-1.vpce-xxxxx.amazonaws.com",
      )
    }),
  {
    config: {
      provider: {
        "amazon-bedrock": {
          options: { endpoint: "https://bedrock-runtime.us-east-1.vpce-xxxxx.amazonaws.com" },
        },
      },
    },
  },
)

it.instance(
  "Bedrock: autoloads when AWS_WEB_IDENTITY_TOKEN_FILE is present",
  () =>
    Effect.gen(function* () {
      yield* set("AWS_WEB_IDENTITY_TOKEN_FILE", "/var/run/secrets/eks.amazonaws.com/serviceaccount/token")
      yield* set("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/my-eks-role")
      yield* set("AWS_PROFILE", "")
      yield* set("AWS_ACCESS_KEY_ID", "")
      const providers = yield* list
      expect(providers[ProviderID.amazonBedrock]).toBeDefined()
      expect(providers[ProviderID.amazonBedrock].options?.region).toBe("us-east-1")
    }),
  { config: { provider: { "amazon-bedrock": { options: { region: "us-east-1" } } } } },
)

// Cross-region inference profile prefix handling.
// Models from models.dev may come with prefixes already (e.g. us., eu., global.).
// These should NOT be double-prefixed when passed to the SDK.

it.instance(
  "Bedrock: model with us. prefix should not be double-prefixed",
  () =>
    Effect.gen(function* () {
      yield* set("AWS_PROFILE", "default")
      const providers = yield* list
      expect(providers[ProviderID.amazonBedrock]).toBeDefined()
      expect(providers[ProviderID.amazonBedrock].models["us.anthropic.claude-opus-4-5-20251101-v1:0"]).toBeDefined()
    }),
  {
    config: {
      provider: {
        "amazon-bedrock": {
          options: { region: "us-east-1" },
          models: { "us.anthropic.claude-opus-4-5-20251101-v1:0": { name: "Claude Opus 4.5 (US)" } },
        },
      },
    },
  },
)

it.instance(
  "Bedrock: model with global. prefix should not be prefixed",
  () =>
    Effect.gen(function* () {
      yield* set("AWS_PROFILE", "default")
      const providers = yield* list
      expect(providers[ProviderID.amazonBedrock]).toBeDefined()
      expect(providers[ProviderID.amazonBedrock].models["global.anthropic.claude-opus-4-5-20251101-v1:0"]).toBeDefined()
    }),
  {
    config: {
      provider: {
        "amazon-bedrock": {
          options: { region: "us-east-1" },
          models: { "global.anthropic.claude-opus-4-5-20251101-v1:0": { name: "Claude Opus 4.5 (Global)" } },
        },
      },
    },
  },
)

it.instance(
  "Bedrock: model with eu. prefix should not be double-prefixed",
  () =>
    Effect.gen(function* () {
      yield* set("AWS_PROFILE", "default")
      const providers = yield* list
      expect(providers[ProviderID.amazonBedrock]).toBeDefined()
      expect(providers[ProviderID.amazonBedrock].models["eu.anthropic.claude-opus-4-5-20251101-v1:0"]).toBeDefined()
    }),
  {
    config: {
      provider: {
        "amazon-bedrock": {
          options: { region: "eu-west-1" },
          models: { "eu.anthropic.claude-opus-4-5-20251101-v1:0": { name: "Claude Opus 4.5 (EU)" } },
        },
      },
    },
  },
)

it.instance(
  "Bedrock: model without prefix in US region should get us. prefix added",
  () =>
    Effect.gen(function* () {
      yield* set("AWS_PROFILE", "default")
      const providers = yield* list
      expect(providers[ProviderID.amazonBedrock]).toBeDefined()
      expect(providers[ProviderID.amazonBedrock].models["anthropic.claude-opus-4-5-20251101-v1:0"]).toBeDefined()
    }),
  {
    config: {
      provider: {
        "amazon-bedrock": {
          options: { region: "us-east-1" },
          models: { "anthropic.claude-opus-4-5-20251101-v1:0": { name: "Claude Opus 4.5" } },
        },
      },
    },
  },
)

// Direct unit tests for cross-region inference profile prefix detection.
describe("Bedrock cross-region prefix detection", () => {
  const crossRegionPrefixes = ["global.", "us.", "eu.", "jp.", "apac.", "au."]

  test("should detect global. prefix", () => {
    expect(crossRegionPrefixes.some((p) => "global.anthropic.claude-opus-4-5-20251101-v1:0".startsWith(p))).toBe(true)
  })

  test("should detect us. prefix", () => {
    expect(crossRegionPrefixes.some((p) => "us.anthropic.claude-opus-4-5-20251101-v1:0".startsWith(p))).toBe(true)
  })

  test("should detect eu. prefix", () => {
    expect(crossRegionPrefixes.some((p) => "eu.anthropic.claude-opus-4-5-20251101-v1:0".startsWith(p))).toBe(true)
  })

  test("should detect jp. prefix", () => {
    expect(crossRegionPrefixes.some((p) => "jp.anthropic.claude-sonnet-4-20250514-v1:0".startsWith(p))).toBe(true)
  })

  test("should detect apac. prefix", () => {
    expect(crossRegionPrefixes.some((p) => "apac.anthropic.claude-sonnet-4-20250514-v1:0".startsWith(p))).toBe(true)
  })

  test("should detect au. prefix", () => {
    expect(crossRegionPrefixes.some((p) => "au.anthropic.claude-sonnet-4-5-20250929-v1:0".startsWith(p))).toBe(true)
  })

  test("should NOT detect prefix for non-prefixed model", () => {
    expect(crossRegionPrefixes.some((p) => "anthropic.claude-opus-4-5-20251101-v1:0".startsWith(p))).toBe(false)
  })

  test("should NOT detect prefix for amazon nova models", () => {
    expect(crossRegionPrefixes.some((p) => "amazon.nova-pro-v1:0".startsWith(p))).toBe(false)
  })

  test("should NOT detect prefix for cohere models", () => {
    expect(crossRegionPrefixes.some((p) => "cohere.command-r-plus-v1:0".startsWith(p))).toBe(false)
  })
})
