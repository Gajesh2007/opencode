import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { LLM, type LLMRequest } from "../src"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "../src/route"
import * as OpenAI from "../src/providers/openai"
import * as OpenAIOptions from "../src/protocols/utils/openai-options"
import { it } from "./lib/effect"
import { dynamicResponse } from "./lib/http"
import { sseEvents } from "./lib/sse"

const completion = { type: "response.completed", response: { id: "resp_parallel" } }

const capture = (request: LLMRequest, transport: "http" | "websocket") =>
  Effect.gen(function* () {
    const sent: unknown[] = []
    const http = dynamicResponse((input) =>
      Effect.sync(() => {
        sent.push(JSON.parse(input.text))
        return input.respond(sseEvents(completion), { headers: { "content-type": "text/event-stream" } })
      }),
    )
    const websocket = LLMClient.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(
            RequestExecutor.Service,
            RequestExecutor.Service.of({ execute: () => Effect.die("unexpected HTTP request") }),
          ),
          Layer.succeed(
            WebSocketExecutor.Service,
            WebSocketExecutor.Service.of({
              open: () =>
                Effect.succeed({
                  sendText: (message) =>
                    Effect.sync(() => {
                      sent.push(JSON.parse(message))
                    }),
                  messages: Stream.make(JSON.stringify(completion)),
                  close: Effect.void,
                }),
            }),
          ),
        ),
      ),
    )
    yield* LLMClient.generate(request).pipe(Effect.provide(transport === "http" ? http : websocket))
    expect(sent).toHaveLength(1)
    return sent[0]
  })

describe("OpenAI Responses parallel tool options", () => {
  for (const transport of ["http", "websocket"] as const) {
    for (const id of ["gpt-6.1-sol", "gpt-6-astra"]) {
      for (const source of ["request", "provider"] as const) {
        for (const value of [undefined, true, false]) {
          it.effect(`${transport} ${id} ${source} parallelToolCalls=${value ?? "omitted"}`, () =>
            Effect.gen(function* () {
              const options = value === undefined ? undefined : { openai: { parallelToolCalls: value } }
              const provider = OpenAI.configure({
                apiKey: "test",
                baseURL: "https://openai.invalid/v1",
                providerOptions: source === "provider" ? options : undefined,
              })
              const request = LLM.request({
                model: transport === "http" ? provider.responses(id) : provider.responsesWebSocket(id),
                prompt: "Look up the weather.",
                tools: [{ name: "lookup", description: "Look up the weather", inputSchema: { type: "object" } }],
                toolChoice: "auto",
                providerOptions: source === "request" ? options : undefined,
              })
              expect(yield* capture(request, transport)).toEqual({
                model: id,
                input: [{ role: "user", content: [{ type: "input_text", text: "Look up the weather." }] }],
                tools: [
                  {
                    type: "function",
                    name: "lookup",
                    description: "Look up the weather",
                    parameters: { type: "object" },
                  },
                ],
                tool_choice: "auto",
                store: false,
                ...(transport === "http" ? { stream: true } : { type: "response.create" }),
                ...(value === undefined ? {} : { parallel_tool_calls: value }),
              })
            }),
          )
        }
      }
    }

    for (const value of [true, false]) {
      it.effect(`${transport} request parallelToolCalls=${value} overrides provider default`, () =>
        Effect.gen(function* () {
          const provider = OpenAI.configure({
            apiKey: "test",
            baseURL: "https://openai.invalid/v1",
            providerOptions: { openai: { parallelToolCalls: !value } },
          })
          expect(
            yield* capture(
              LLM.request({
                model:
                  transport === "http" ? provider.responses("gpt-6.1-sol") : provider.responsesWebSocket("gpt-6.1-sol"),
                prompt: "Hello",
                providerOptions: { openai: { parallelToolCalls: value } },
              }),
              transport,
            ),
          ).toHaveProperty("parallel_tool_calls", value)
        }),
      )
    }

    it.effect(`${transport} ignores non-boolean parallelToolCalls without coercion`, () =>
      Effect.gen(function* () {
        const provider = OpenAI.configure({ apiKey: "test", baseURL: "https://openai.invalid/v1" })
        for (const value of ["true", "false", 0, 1, null, {}, []]) {
          const request = LLM.request({
            model:
              transport === "http" ? provider.responses("gpt-6.1-sol") : provider.responsesWebSocket("gpt-6.1-sol"),
            prompt: "Hello",
            providerOptions: { openai: { parallelToolCalls: value, store: value } },
          })
          expect(OpenAIOptions.parallelToolCalls(request)).toBe(OpenAIOptions.store(request))
          const body = yield* capture(request, transport)
          expect(body).not.toHaveProperty("parallel_tool_calls")
          expect(body).not.toHaveProperty("parallelToolCalls")
        }
      }),
    )
  }

  test("provider options require a boolean parallelToolCalls", () => {
    // @ts-expect-error OpenAI boolean options do not accept strings.
    OpenAI.configure({ providerOptions: { openai: { parallelToolCalls: "true" } } })
    // @ts-expect-error OpenAI boolean options do not accept numbers.
    OpenAI.configure({ providerOptions: { openai: { parallelToolCalls: 1 } } })
  })
})
