import { expect, test } from "bun:test"
import { Effect } from "effect"
import { adapterState, toLLMEvents } from "@/session/llm/ai-sdk"

test("finish adapter preserves reported tier without treating SDK fallback model as served", async () => {
  const events = await Effect.runPromise(
    toLLMEvents(adapterState(), {
      type: "finish-step",
      finishReason: "stop",
      rawFinishReason: "stop",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
      },
      response: { id: "response", timestamp: new Date(0), modelId: "selected-model" },
      providerMetadata: { openai: { serviceTier: "default" } },
    }),
  )
  expect(events[0]?.type).toBe("step-finish")
  if (events[0]?.type !== "step-finish") throw new Error("expected step finish")
  expect(events[0].providerMetadata).toEqual({
    openai: { serviceTier: "default" },
  })
})
