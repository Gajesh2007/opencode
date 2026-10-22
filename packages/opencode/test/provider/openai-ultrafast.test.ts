import { expect, test } from "bun:test"
import { createBedrockMantle } from "@ai-sdk/amazon-bedrock/mantle"
import { createAzure } from "@ai-sdk/azure"
import { createOpenAI, type OpenAIResponsesProviderOptions } from "@ai-sdk/openai"

test.each([
  ["bedrock-runtime.us-east-1.amazonaws.com", "us-east-1", "bedrock"],
  ["bedrock-runtime.cn-north-1.amazonaws.com.cn", "cn-north-1", "bedrock"],
  ["bedrock-mantle.us-east-1.api.aws", "us-east-1", "bedrock-mantle"],
  ["proxy.example", "us-east-1", "bedrock-mantle"],
  ["bedrock-runtime.us-east-1.amazonaws.com.example", "us-east-1", "bedrock-mantle"],
])("Bedrock Mantle selects the signing scope for %s without changing bearer auth", async (host, region, service) => {
  for (const apiKey of ["", "test-api-key"]) {
    const response = {
      id: "resp_signed",
      created_at: 1,
      model: "us.openai.gpt-6.1-sol",
      service_tier: "ultrafast",
      output: [],
      usage: { input_tokens: 1, output_tokens: 0 },
    }
    const model = createBedrockMantle({
      region,
      apiKey,
      baseURL: `https://${host}/openai/v1`,
      credentialProvider: async () => {
        expect(apiKey).toBe("")
        return { accessKeyId: "TESTACCESSKEY", secretAccessKey: "test-secret", sessionToken: "test-session" }
      },
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init)
          expect(request.url).toBe(`https://${host}/openai/v1/responses`)
          expect(request.method).toBe("POST")
          expect(await request.json()).toMatchObject({ model: response.model, service_tier: "ultrafast" })
          if (apiKey) {
            expect(request.headers.get("authorization")).toBe("Bearer test-api-key")
            expect(request.headers.has("x-amz-security-token")).toBe(false)
            expect(request.headers.has("x-amz-date")).toBe(false)
            return Response.json(response)
          }
          expect(request.headers.get("authorization")).toStartWith("AWS4-HMAC-SHA256 Credential=TESTACCESSKEY/")
          expect(request.headers.get("authorization")).toContain(`/${region}/${service}/aws4_request,`)
          expect(request.headers.get("x-amz-security-token")).toBe("test-session")
          expect(request.headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/)
          return Response.json(response)
        },
        { preconnect() {} },
      ),
    }).responses(response.model)
    const result = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      providerOptions: { openai: { serviceTier: "ultrafast" } },
    })
    expect(model.modelId).toBe(response.model)
    expect(result.response?.modelId).toBe(response.model)
    expect(result.providerMetadata?.openai?.serviceTier).toBe("ultrafast")
  }
})

for (const entry of [
  {
    name: "OpenAI",
    create: createOpenAI,
    model: "gpt-6.1-sol",
    url: "https://api.openai.com/v1/responses",
    key: "openai",
  },
  {
    name: "Azure",
    create: createAzure,
    model: "gpt-6.1-sol",
    url: "https://ultrafast.openai.azure.com/openai/v1/responses?api-version=v1",
    key: "azure",
  },
  {
    name: "Bedrock Mantle",
    create: createBedrockMantle,
    model: "openai.gpt-6.1-sol",
    url: "https://bedrock-mantle.us-east-1.api.aws/v1/responses",
    key: "openai",
  },
]) {
  test.each(
    (["doStream", "doGenerate"] as const).flatMap((method) =>
      ["low", "high"].flatMap((effort) =>
        (entry.name === "Bedrock Mantle" ? (["ultrafast"] as const) : (["priority", "ultrafast"] as const)).flatMap(
          (tier) =>
            ["gpt-6.1-sol", "gpt-6-1-sol", "gpt-6-astra", "gpt-6.1-sol-2026-10-01", "gpt-6-astra-2026-09-01"]
              .filter((id) => entry.name !== "Bedrock Mantle" || id !== "gpt-6-1-sol")
              .map((id) => [method, effort, tier, entry.name === "Bedrock Mantle" ? `us.openai.${id}` : id] as const),
        ),
      ),
    ),
  )(`${entry.name} Responses %s preserves %s reasoning and %s for %s`, async (method, effort, tier, id) => {
    const response = {
      id: "resp_ultrafast",
      created_at: 1,
      model: `${id}-served`,
      service_tier: tier,
      output: [],
      usage: { input_tokens: 1, output_tokens: 0 },
    }
    const settings = {
      apiKey: "test-key",
      resourceName: "ultrafast",
      region: "us-east-1",
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init)
          expect(request.url).toBe(entry.url)
          expect(request.method).toBe("POST")
          const body = await request.json()
          expect(body).toMatchObject({
            model: id,
            service_tier: tier,
            reasoning: { effort },
            input: [
              {
                role: "developer",
                content:
                  effort === "high"
                    ? [
                        {
                          type: "input_text",
                          text: "Stable instructions",
                          prompt_cache_breakpoint: { mode: "explicit" },
                        },
                      ]
                    : "Stable instructions",
              },
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "Hello",
                    ...(effort === "high" ? { prompt_cache_breakpoint: { mode: "explicit" } } : {}),
                  },
                ],
              },
            ],
          })
          expect(body.prompt_cache_options).toEqual(
            effort === "high" ? { mode: "explicit", ttl: "30m", prewarm: false } : undefined,
          )
          if (effort === "low") expect(body.input[1].content[0]).not.toHaveProperty("prompt_cache_breakpoint")
          expect(body.stream).toBe(method === "doStream" ? true : undefined)
          if (method === "doGenerate") return Response.json(response)
          return new Response(
            ["response.created", "response.completed"]
              .map((type) => `data: ${JSON.stringify({ type, response })}\n\n`)
              .join(""),
            { headers: { "Content-Type": "text/event-stream" } },
          )
        },
        { preconnect() {} },
      ),
    }
    const model = entry.create(settings).responses(id)
    const options = {
      prompt: [
        {
          role: "system" as const,
          content: "Stable instructions",
          ...(effort === "high"
            ? { providerOptions: { [entry.key]: { promptCacheBreakpoint: { mode: "explicit" } } } }
            : {}),
        },
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: "Hello",
              ...(effort === "high"
                ? { providerOptions: { [entry.key]: { promptCacheBreakpoint: { mode: "explicit" } } } }
                : {}),
            },
          ],
        },
      ],
      providerOptions: {
        [entry.key]: {
          serviceTier: tier,
          reasoningEffort: effort,
          ...(effort === "high"
            ? { promptCacheOptions: { mode: "explicit" as const, ttl: "30m" as const, prewarm: false } }
            : {}),
        } satisfies OpenAIResponsesProviderOptions,
      },
    }

    if (method === "doGenerate") {
      const result = await model.doGenerate(options)
      expect(result.providerMetadata?.[entry.key]?.serviceTier).toBe(tier)
      expect(result.providerMetadata?.[entry.key]?.modelId).toBe(response.model)
      return
    }

    const result = await model.doStream(options)
    const reader = result.stream.getReader()
    const chunks = []
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      chunks.push(chunk.value)
    }
    expect(chunks.filter((chunk) => chunk.type === "error")).toEqual([])
    expect(chunks.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "stop" },
      providerMetadata: { [entry.key]: { serviceTier: tier, modelId: response.model } },
    })
  })

  test.each(["doStream", "doGenerate"] as const)(
    `${entry.name} Chat Completions %s still rejects ultrafast`,
    async (method) => {
      const settings = {
        apiKey: "test-key",
        resourceName: "ultrafast",
        region: "us-east-1",
        fetch: Object.assign(
          async () => {
            throw new Error("Chat Completions must reject ultrafast before sending a request")
          },
          { preconnect() {} },
        ),
      }
      await expect(
        entry
          .create(settings)
          .chat(entry.model)
          [method]({
            prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
            // Chat Completions uses the OpenAI options namespace, including on Azure.
            providerOptions: { openai: { serviceTier: "ultrafast" } },
          }),
      ).rejects.toMatchObject({ name: "AI_InvalidArgumentError", argument: "providerOptions" })
    },
  )

  test.each(["gpt-6-astra-mini", "gpt-6-astra-pro", "gpt-6.1-sol-mini", "gpt-6.1-sol-pro", "other/gpt-6.1-sol"])(
    `${entry.name} does not infer GPT6 capabilities for %s`,
    async (id) => {
      const result = await entry
        .create({
          apiKey: "test-key",
          resourceName: "ultrafast",
          region: "us-east-1",
          fetch: Object.assign(
            async (_input: RequestInfo | URL, init?: RequestInit) => {
              const body = JSON.parse(String(init?.body))
              expect(body).not.toHaveProperty("reasoning")
              expect(body).not.toHaveProperty("service_tier")
              return Response.json({ id: "resp_unknown", output: [], usage: { input_tokens: 1, output_tokens: 0 } })
            },
            { preconnect() {} },
          ),
        })
        .responses(id)
        .doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
          providerOptions: { [entry.key]: { reasoningEffort: "high", serviceTier: "priority" } },
        })
      expect(result.providerMetadata?.[entry.key]).not.toHaveProperty("modelId")
    },
  )

  test.each(["doStream", "doGenerate"] as const)(
    `${entry.name} %s rejects malformed cache opt-ins before fetch`,
    async (method) => {
      const model = entry
        .create({
          apiKey: "test-key",
          resourceName: "ultrafast",
          region: "us-east-1",
          fetch: Object.assign(
            async () => {
              throw new Error("must not fetch")
            },
            { preconnect() {} },
          ),
        })
        .responses(entry.model)
      for (const promptCacheOptions of [{ mode: "other" }, { ttl: "24h" }, { prewarm: "true" }]) {
        await expect(
          model[method]({
            prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
            providerOptions: { [entry.key]: { promptCacheOptions } },
          }),
        ).rejects.toMatchObject({ name: "AI_InvalidArgumentError" })
      }
      await expect(
        model[method]({
          prompt: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Hello",
                  providerOptions: { [entry.key]: { promptCacheBreakpoint: { mode: "implicit" } } },
                },
              ],
            },
          ],
        }),
      ).rejects.toMatchObject({ name: "ZodError" })
    },
  )
}
