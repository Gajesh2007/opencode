import { expect, test } from "bun:test"
import { createOpenAI, type OpenAIResponsesProviderOptions } from "@ai-sdk/openai"

test.each(["doStream", "doGenerate"] as const)("OpenAI Responses %s supports ultrafast", async (method) => {
  const response = {
    id: "resp_ultrafast",
    created_at: 1,
    model: "gpt-6-astra",
    service_tier: "ultrafast",
    output: [],
    usage: { input_tokens: 1, output_tokens: 0 },
  }
  const model = createOpenAI({
    apiKey: "test-key",
    fetch: Object.assign(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(url).toBe("https://api.openai.com/v1/responses")
        expect(init?.method).toBe("POST")
        const body = JSON.parse(String(init?.body))
        expect(body).toMatchObject({
          model: response.model,
          service_tier: "ultrafast",
          input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
        })
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
  }).responses(response.model)
  const options = {
    prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }],
    providerOptions: {
      openai: { serviceTier: "ultrafast" } satisfies OpenAIResponsesProviderOptions,
    },
  }

  if (method === "doGenerate") {
    const result = await model.doGenerate(options)
    expect(result.providerMetadata?.openai?.serviceTier).toBe("ultrafast")
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
    providerMetadata: { openai: { serviceTier: "ultrafast" } },
  })
})
