import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect"
import { InvalidProviderOutputReason, LLM, LLMError, LLMEvent, type LLMRequest } from "../src"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { tool } from "../src/tool"
import { ToolRuntime } from "../src/tool-runtime"
import { it } from "./lib/effect"

const request = LLM.request({ model: OpenAIChat.route.model({ id: "test" }), prompt: "Use the tools." })
const call = (id: string, name = "read") => LLMEvent.toolCall({ id, name, input: {} })
const finish = LLMEvent.finish({ reason: "tool-calls" })

describe("eager tool runtime", () => {
  it.live(
    "overlaps reads with generation, emits in completion order, and preserves the follow-up barrier and history",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const fastResult = yield* Deferred.make<void>()
        const generated = yield* Deferred.make<void>()
        const requests: LLMRequest[] = []
        const observed: LLMEvent[] = []
        let settled = false
        const read = tool({
          description: "Read independently.",
          jsonSchema: { type: "object" },
          execution: "eager",
          execute: (_input, context) =>
            Effect.gen(function* () {
              if (context?.id === "fast") return "fast"
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
              settled = true
              return "slow"
            }),
        })
        const fiber = yield* ToolRuntime.stream({
          request,
          tools: { read },
          stopWhen: ToolRuntime.stepCountIs(2),
          stream: (next) => {
            requests.push(next)
            if (requests.length > 1) {
              expect(settled).toBe(true)
              expect(observed.filter(LLMEvent.is.toolResult).map((event) => event.id)).toEqual(["fast", "slow"])
              return Stream.make(LLMEvent.finish({ reason: "stop" }))
            }
            return Stream.make(LLMEvent.textDelta({ id: "text", text: "Tools:" }), call("slow")).pipe(
              Stream.concat(Stream.fromEffect(Deferred.await(started).pipe(Effect.as(call("fast"))))),
              Stream.concat(
                Stream.fromEffect(
                  Deferred.await(fastResult).pipe(
                    Effect.as(LLMEvent.textDelta({ id: "text", text: "Still generating." })),
                  ),
                ),
              ),
              Stream.concat(Stream.make(LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }), finish)),
              Stream.ensuring(Deferred.succeed(generated, undefined)),
            )
          },
        }).pipe(
          Stream.tap((event) =>
            Effect.gen(function* () {
              observed.push(event)
              if (event.type === "tool-result" && event.id === "fast") {
                expect(observed.filter(LLMEvent.is.toolCall).map((event) => event.id)).toEqual(["slow", "fast"])
                expect(
                  observed.some((event) => event.type === "text-delta" && event.text === "Still generating."),
                ).toBe(false)
                yield* Deferred.succeed(fastResult, undefined)
              }
            }),
          ),
          Stream.runDrain,
          Effect.forkScoped,
        )

        yield* Deferred.await(generated)
        expect(requests).toHaveLength(1)
        expect(settled).toBe(false)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(fiber)

        expect(requests[1]?.messages.slice(1)).toMatchObject([
          {
            role: "assistant",
            content: [
              { type: "text", text: "Tools:" },
              { type: "tool-call", id: "slow" },
              { type: "tool-call", id: "fast" },
              { type: "text", text: "Still generating." },
            ],
          },
          { role: "tool", content: [{ id: "slow" }] },
          { role: "tool", content: [{ id: "fast" }] },
        ])
        expect(observed.filter(LLMEvent.is.finish)).toHaveLength(1)
        expect(observed.at(-1)?.type).toBe("finish")
      }).pipe(Effect.timeout("2 seconds")),
  )

  for (const enabled of [false, true]) {
    it.effect(`keeps unclassified tools deferred with eager support ${enabled ? "enabled" : "disabled"}`, () =>
      Effect.gen(function* () {
        let executions = 0
        const mutate = tool({
          description: "Mutate state.",
          jsonSchema: { type: "object" },
          execute: () => Effect.sync(() => ++executions),
        })
        const read = tool({
          description: "An unused safe tool.",
          jsonSchema: { type: "object" },
          execution: "eager",
          execute: () => Effect.die("Unused tool executed"),
        })
        yield* ToolRuntime.stream({
          request,
          tools: enabled ? { mutate, read } : { mutate },
          stream: () =>
            Stream.make(call("mutation", "mutate")).pipe(
              Stream.concat(
                Stream.fromEffect(
                  Effect.sync(() => {
                    expect(executions).toBe(0)
                    return finish
                  }),
                ),
              ),
            ),
        }).pipe(Stream.runDrain)
        expect(executions).toBe(1)
      }),
    )
  }

  for (const barrier of ["mutation", "unknown", "partial-mutation", "partial-delta"] as const) {
    it.live(`stops eager admission at ${barrier} and settles earlier reads before delayed work`, () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const generated = yield* Deferred.make<void>()
        const executions: string[] = []
        let settled = false
        const tools = {
          read: tool({
            description: "Read independently.",
            jsonSchema: { type: "object" },
            execution: "eager",
            execute: (_input, context) =>
              Effect.gen(function* () {
                executions.push(context?.id ?? "missing")
                if (context?.id !== "early") {
                  expect(settled).toBe(true)
                  return "late"
                }
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
                settled = true
                return "early"
              }),
          }),
          mutate: tool({
            description: "Mutate state.",
            jsonSchema: { type: "object" },
            execute: () =>
              Effect.sync(() => {
                expect(settled).toBe(true)
                executions.push("mutation")
                return "written"
              }),
          }),
        }
        const fiber = yield* ToolRuntime.stream({
          request,
          tools,
          stream: () =>
            Stream.make(call("early")).pipe(
              Stream.concat(
                Stream.fromEffect(Deferred.await(started).pipe(Effect.as(LLMEvent.stepStart({ index: 0 })))),
              ),
              Stream.concat(
                Stream.fromIterable<LLMEvent>(
                  barrier === "partial-mutation" || barrier === "partial-delta"
                    ? [
                        barrier === "partial-mutation"
                          ? LLMEvent.toolInputStart({ id: "mutation", name: "mutate" })
                          : LLMEvent.toolInputDelta({ id: "mutation", name: "mutate", text: "{" }),
                        call("late"),
                        call("mutation", "mutate"),
                      ]
                    : [call("mutation", barrier === "unknown" ? "unknown" : "mutate"), call("late")],
                ),
              ),
              Stream.concat(Stream.make(finish)),
              Stream.ensuring(Deferred.succeed(generated, undefined)),
            ),
        }).pipe(Stream.runCollect, Effect.forkScoped)

        yield* Deferred.await(generated)
        expect(executions).toEqual(["early"])
        yield* Deferred.succeed(release, undefined)
        const events = yield* Fiber.join(fiber)
        expect(executions.toSorted()).toEqual(barrier === "unknown" ? ["early", "late"] : ["early", "late", "mutation"])
        expect(events.filter(LLMEvent.is.toolResult)).toHaveLength(3)
        expect(events.at(-1)?.type).toBe("finish")
      }).pipe(Effect.timeout("2 seconds")),
    )
  }

  for (const scenario of [
    { name: "default", concurrency: undefined, limit: 10 },
    { name: "explicit", concurrency: 2, limit: 2 },
    { name: "inherited", concurrency: "inherit", limit: 2 },
  ] as const) {
    it.live(`bounds eager concurrency using the ${scenario.name} limit without blocking generation`, () =>
      Effect.gen(function* () {
        const full = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const generated = yield* Deferred.make<void>()
        let active = 0
        let maximum = 0
        let starts = 0
        const read = tool({
          description: "Wait for all slots to fill.",
          jsonSchema: { type: "object" },
          execution: "eager",
          execute: () =>
            Effect.gen(function* () {
              starts++
              active++
              maximum = Math.max(maximum, active)
              if (active === scenario.limit) yield* Deferred.succeed(full, undefined)
              yield* Deferred.await(release)
              return "read"
            }).pipe(Effect.ensuring(Effect.sync(() => active--))),
        })
        const fiber = yield* ToolRuntime.stream({
          request,
          tools: { read },
          concurrency: scenario.concurrency,
          stream: () =>
            Stream.fromIterable([
              ...Array.from({ length: scenario.limit + 3 }, (_, index) => call(String(index))),
              finish,
            ]).pipe(Stream.ensuring(Deferred.succeed(generated, undefined))),
        }).pipe(Stream.runCollect, Effect.withConcurrency(2), Effect.forkScoped)

        yield* Deferred.await(full)
        yield* Deferred.await(generated)
        expect(starts).toBe(scenario.limit)
        yield* Deferred.succeed(release, undefined)
        const events = yield* Fiber.join(fiber)
        expect(maximum).toBe(scenario.limit)
        expect(active).toBe(0)
        expect(events.filter(LLMEvent.is.toolResult)).toHaveLength(scenario.limit + 3)
        expect(events.at(-1)?.type).toBe("finish")
      }).pipe(Effect.timeout("2 seconds")),
    )
  }

  it.live("ignores partial inputs and validates completed calls before executing", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const executions: string[] = []
      const read = tool({
        description: "Read a validated value.",
        parameters: Schema.Struct({ value: Schema.String }),
        success: Schema.String,
        execution: "eager",
        execute: ({ value }) =>
          Effect.gen(function* () {
            executions.push(value)
            yield* Deferred.succeed(started, undefined)
            return value
          }),
      })
      const events = yield* ToolRuntime.stream({
        request,
        tools: { read },
        stream: () =>
          Stream.make(
            LLMEvent.toolInputStart({ id: "partial", name: "read" }),
            LLMEvent.toolInputDelta({ id: "partial", name: "read", text: '{"value":' }),
            LLMEvent.toolInputEnd({ id: "partial", name: "read" }),
          ).pipe(
            Stream.concat(
              Stream.fromEffect(
                Effect.sync(() => {
                  expect(executions).toEqual([])
                  return LLMEvent.toolCall({ id: "invalid", name: "read", input: { value: 42 } })
                }),
              ),
            ),
            Stream.concat(Stream.make(LLMEvent.toolCall({ id: "valid", name: "read", input: { value: "validated" } }))),
            Stream.concat(Stream.fromEffect(Deferred.await(started).pipe(Effect.as(finish)))),
          ),
      }).pipe(Stream.runCollect)

      expect(executions).toEqual(["validated"])
      expect(
        events
          .filter(LLMEvent.is.toolResult)
          .map((event) => event.id)
          .toSorted(),
      ).toEqual(["invalid", "valid"])
      expect(events.find(LLMEvent.is.toolError)).toMatchObject({
        id: "invalid",
        message: expect.stringContaining("Invalid tool input"),
      })
      expect(events.at(-1)?.type).toBe("finish")
    }).pipe(Effect.timeout("2 seconds")),
  )

  it.effect("settles eager reads before a normal stop even without a tool-calls finish reason", () =>
    Effect.gen(function* () {
      let executions = 0
      const read = tool({
        description: "Read independently.",
        jsonSchema: { type: "object" },
        execution: "eager",
        execute: () => Effect.sync(() => ++executions),
      })
      const events = yield* ToolRuntime.stream({
        request,
        tools: { read },
        stream: () => Stream.make(call("read"), LLMEvent.finish({ reason: "stop" })),
      }).pipe(Stream.runCollect)

      expect(executions).toBe(1)
      expect(events.map((event) => event.type)).toEqual(["tool-call", "tool-result", "finish"])
      expect(events.at(-1)).toMatchObject({ reason: "stop" })
    }),
  )

  it.effect("dispatches each ID once and never locally executes provider-owned IDs", () =>
    Effect.gen(function* () {
      const executions: string[] = []
      const requests: LLMRequest[] = []
      const read = tool({
        description: "Read independently.",
        jsonSchema: { type: "object" },
        execution: "eager",
        execute: (_input, context) => Effect.sync(() => executions.push(context?.id ?? "missing")),
      })
      const mutate = tool({
        description: "Mutate state.",
        jsonSchema: { type: "object" },
        execute: (_input, context) => Effect.sync(() => executions.push(context?.id ?? "missing")),
      })
      const events = yield* ToolRuntime.stream({
        request,
        tools: { read, mutate },
        stopWhen: ToolRuntime.stepCountIs(2),
        stream: (next) => {
          requests.push(next)
          if (requests.length > 1) return Stream.make(LLMEvent.finish({ reason: "stop" }))
          return Stream.make(
            call("one"),
            call("one"),
            LLMEvent.toolCall({ id: "hosted", name: "read", input: {}, providerExecuted: true }),
            LLMEvent.toolResult({
              id: "hosted",
              name: "read",
              result: { type: "text", value: "hosted" },
              providerExecuted: true,
            }),
            call("hosted"),
            call("mutation", "mutate"),
            call("mutation", "mutate"),
            call("two"),
            call("two"),
            finish,
          )
        },
      }).pipe(Stream.runCollect)

      expect(executions.toSorted()).toEqual(["mutation", "one", "two"])
      expect(events.filter(LLMEvent.is.toolCall).map((event) => event.id)).toEqual(["one", "hosted", "mutation", "two"])
      expect(
        events
          .filter(LLMEvent.is.toolResult)
          .map((event) => event.id)
          .toSorted(),
      ).toEqual(["hosted", "mutation", "one", "two"])
      expect(events.filter(LLMEvent.is.toolError)).toEqual([])
      expect(
        requests[1]?.messages[1]?.content.filter((part) => part.type === "tool-call").map((part) => part.id),
      ).toEqual(["one", "hosted", "mutation", "two"])
    }),
  )

  for (const mode of ["eager", "deferred", "none"] as const) {
    it.live(`suppresses completed call and input lifecycle replays in ${mode} mode`, () =>
      Effect.gen(function* () {
        const completed = yield* Deferred.make<void>()
        const requests: LLMRequest[] = []
        let executions = 0
        const read = tool({
          description: "Read once.",
          jsonSchema: { type: "object" },
          execution: mode === "eager" ? "eager" : undefined,
          execute: () => Effect.sync(() => ++executions),
        })
        const inputStart = LLMEvent.toolInputStart({ id: "once", name: "read" })
        const inputDelta = LLMEvent.toolInputDelta({ id: "once", name: "read", text: " " })
        const inputEnd = LLMEvent.toolInputEnd({ id: "once", name: "read" })
        const events = yield* ToolRuntime.stream({
          request,
          tools: { read },
          toolExecution: mode === "none" ? "none" : "auto",
          stopWhen: ToolRuntime.stepCountIs(2),
          stream: (next) => {
            requests.push(next)
            if (requests.length > 1) return Stream.make(LLMEvent.finish({ reason: "stop" }))
            return Stream.make(inputStart, inputStart, inputDelta, inputDelta, inputEnd, inputEnd, call("once")).pipe(
              Stream.concat(Stream.fromEffectDrain(Deferred.await(completed))),
              Stream.concat(Stream.make(inputStart, inputDelta, inputEnd, call("once"), finish)),
            )
          },
        }).pipe(
          Stream.tap((event) =>
            event.type === (mode === "eager" ? "tool-result" : "tool-call")
              ? Deferred.succeed(completed, undefined)
              : Effect.void,
          ),
          Stream.runCollect,
        )

        expect(executions).toBe(mode === "none" ? 0 : 1)
        expect(events.map((event) => event.type)).toEqual([
          "tool-input-start",
          "tool-input-delta",
          "tool-input-delta",
          "tool-input-end",
          "tool-call",
          ...(mode === "none" ? [] : ["tool-result" as const]),
          "finish",
        ])
        if (mode === "none") {
          expect(requests).toHaveLength(1)
          return
        }
        expect(requests[1]?.messages.slice(1)).toMatchObject([
          { role: "assistant", content: [{ type: "tool-call", id: "once" }] },
          { role: "tool", content: [{ id: "once" }] },
        ])
      }).pipe(Effect.timeout("2 seconds")),
    )
  }

  for (const eager of [false, true]) {
    it.live(
      `suppresses provider-owned replays after the result with eager support ${eager ? "enabled" : "disabled"}`,
      () =>
        Effect.gen(function* () {
          const completed = yield* Deferred.make<void>()
          let executions = 0
          const read = tool({
            description: "Must not execute provider-owned calls.",
            jsonSchema: { type: "object" },
            execution: eager ? "eager" : undefined,
            execute: () => Effect.sync(() => ++executions),
          })
          const hostedCall = LLMEvent.toolCall({ id: "hosted", name: "read", input: {}, providerExecuted: true })
          const hostedResult = LLMEvent.toolResult({
            id: "hosted",
            name: "read",
            result: { type: "text", value: "provider result" },
            providerExecuted: true,
          })
          const events = yield* ToolRuntime.stream({
            request,
            tools: { read },
            stream: () =>
              Stream.make(hostedCall, hostedResult).pipe(
                Stream.concat(Stream.fromEffectDrain(Deferred.await(completed))),
                Stream.concat(
                  Stream.make(
                    LLMEvent.toolInputStart({ id: "hosted", name: "read" }),
                    LLMEvent.toolInputDelta({ id: "hosted", name: "read", text: "{}" }),
                    LLMEvent.toolInputEnd({ id: "hosted", name: "read" }),
                    hostedCall,
                    hostedResult,
                    LLMEvent.finish({ reason: "stop" }),
                  ),
                ),
              ),
          }).pipe(
            Stream.tap((event) =>
              event.type === "tool-result" ? Deferred.succeed(completed, undefined) : Effect.void,
            ),
            Stream.runCollect,
          )

          expect(executions).toBe(0)
          expect(events).toEqual([hostedCall, hostedResult, LLMEvent.finish({ reason: "stop" })])
        }).pipe(Effect.timeout("2 seconds")),
    )
  }

  it.live("cancels generation, active reads, and queued work together", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const generating = yield* Deferred.make<void>()
      const executions: string[] = []
      let generationReleased = false
      let readReleased = false
      const tools = {
        read: tool({
          description: "Wait indefinitely.",
          jsonSchema: { type: "object" },
          execution: "eager",
          execute: (_input, context) =>
            Effect.gen(function* () {
              executions.push(context?.id ?? "missing")
              yield* Deferred.succeed(started, undefined)
              return yield* Effect.never
            }).pipe(Effect.ensuring(Effect.sync(() => (readReleased = true)))),
        }),
        mutate: tool({
          description: "Must not execute on cancellation.",
          jsonSchema: { type: "object" },
          execute: () => Effect.sync(() => executions.push("mutation")),
        }),
      }
      const fiber = yield* ToolRuntime.stream({
        request,
        tools,
        concurrency: 1,
        stream: () =>
          Stream.make(call("active"), call("queued"), call("mutation", "mutate")).pipe(
            Stream.concat(
              Stream.fromEffect(Deferred.succeed(generating, undefined).pipe(Effect.andThen(Effect.never))),
            ),
            Stream.ensuring(Effect.sync(() => (generationReleased = true))),
          ),
      }).pipe(Stream.runDrain, Effect.forkScoped)

      yield* Deferred.await(started)
      yield* Deferred.await(generating)
      yield* Fiber.interrupt(fiber)
      expect(executions).toEqual(["active"])
      expect(readReleased).toBe(true)
      expect(generationReleased).toBe(true)
    }).pipe(Effect.timeout("2 seconds")),
  )

  it.live("interrupts pending siblings and generation when the consumer stops at an eager result", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      let readReleased = false
      let generationReleased = false
      const read = tool({
        description: "Complete only the second call.",
        jsonSchema: { type: "object" },
        execution: "eager",
        execute: (_input, context) =>
          context?.id === "fast"
            ? Deferred.await(started).pipe(Effect.as("fast"))
            : Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Effect.sync(() => (readReleased = true))),
              ),
      })
      const events = yield* ToolRuntime.stream({
        request,
        tools: { read },
        stream: () =>
          Stream.make(call("slow"), call("fast")).pipe(
            Stream.concat(Stream.never),
            Stream.ensuring(Effect.sync(() => (generationReleased = true))),
          ),
      }).pipe(Stream.filter(LLMEvent.is.toolResult), Stream.take(1), Stream.runCollect)

      expect(events.map((event) => event.id)).toEqual(["fast"])
      expect(readReleased).toBe(true)
      expect(generationReleased).toBe(true)
    }).pipe(Effect.timeout("2 seconds")),
  )

  for (const ending of [
    "provider-error",
    "truncated",
    "transport-error",
    "error-finish",
    "length-finish",
    "error-step",
    "length-step",
  ] as const) {
    it.live(`cleans up eager work and never dispatches mutations after ${ending}`, () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const cleaned = yield* Deferred.make<void>()
        const executions: string[] = []
        const error = new LLMError({
          module: "test",
          method: "stream",
          reason: new InvalidProviderOutputReason({ message: "Truncated response" }),
        })
        const tools = {
          read: tool({
            description: "Wait indefinitely.",
            jsonSchema: { type: "object" },
            execution: "eager",
            execute: (_input, context) =>
              Effect.gen(function* () {
                executions.push(context?.id ?? "missing")
                yield* Deferred.succeed(started, undefined)
                return yield* Effect.never
              }).pipe(Effect.ensuring(Deferred.succeed(cleaned, undefined))),
          }),
          mutate: tool({
            description: "Must not execute after an unsuccessful response.",
            jsonSchema: { type: "object" },
            execute: () => Effect.sync(() => executions.push("mutation")),
          }),
        }
        const result = yield* ToolRuntime.stream({
          request,
          tools,
          concurrency: 1,
          stream: () =>
            Stream.make(call("active"), call("queued"), call("mutation", "mutate")).pipe(
              Stream.concat(
                Stream.fromEffect(
                  Deferred.await(started).pipe(
                    Effect.as(
                      LLMEvent.stepFinish({
                        index: 0,
                        reason: ending === "error-step" ? "error" : ending === "length-step" ? "length" : "tool-calls",
                      }),
                    ),
                  ),
                ),
              ),
              Stream.concat(
                ending === "transport-error"
                  ? Stream.fail(error)
                  : ending === "truncated"
                    ? Stream.empty
                    : ending === "provider-error"
                      ? Stream.make(LLMEvent.providerError({ message: "Provider failed" })).pipe(
                          Stream.concat(Stream.fromEffect(Deferred.await(cleaned).pipe(Effect.as(finish)))),
                        )
                      : ending === "error-step" || ending === "length-step"
                        ? Stream.make(finish)
                        : Stream.make(LLMEvent.finish({ reason: ending === "error-finish" ? "error" : "length" })),
              ),
            ),
        }).pipe(Stream.runCollect, Effect.exit)

        expect(executions).toEqual(["active"])
        expect(yield* Deferred.isDone(cleaned)).toBe(true)
        if (ending === "transport-error") {
          expect(result).toEqual(Exit.fail(error))
          return
        }
        expect(Exit.isSuccess(result)).toBe(true)
        if (Exit.isFailure(result)) return
        expect(result.value.filter(LLMEvent.is.toolResult)).toEqual([])
        expect(result.value.at(-1)).toMatchObject({
          type: "finish",
          reason:
            ending === "truncated"
              ? "unknown"
              : ending === "length-finish" || ending === "length-step"
                ? "length"
                : "error",
        })
      }).pipe(Effect.timeout("2 seconds")),
    )
  }

  it.live("propagates eager defects and interrupts generation rather than hanging", () =>
    Effect.gen(function* () {
      let generationReleased = false
      const defect = new Error("Read defect")
      const read = tool({
        description: "Fail unexpectedly.",
        jsonSchema: { type: "object" },
        execution: "eager",
        execute: () => Effect.die(defect),
      })
      const result = yield* ToolRuntime.stream({
        request,
        tools: { read },
        stream: () =>
          Stream.make(call("read")).pipe(
            Stream.concat(Stream.never),
            Stream.ensuring(Effect.sync(() => (generationReleased = true))),
          ),
      }).pipe(Stream.runDrain, Effect.exit)

      expect(result).toEqual(Exit.die(defect))
      expect(generationReleased).toBe(true)
    }).pipe(Effect.timeout("2 seconds")),
  )

  for (const toolExecution of ["auto", "none"] as const) {
    it.effect(`does not accumulate streamed text or reasoning in one-step ${toolExecution} runs`, () =>
      Effect.gen(function* () {
        let reads = 0
        let executions = 0
        const read = tool({
          description: "Read independently.",
          jsonSchema: { type: "object" },
          execution: "eager",
          execute: () => Effect.sync(() => ++executions),
        })
        yield* ToolRuntime.stream({
          request,
          tools: { read },
          toolExecution,
          stopWhen: toolExecution === "none" ? ToolRuntime.stepCountIs(2) : undefined,
          stream: () =>
            Stream.range(0, 1000).pipe(
              Stream.map((index) =>
                Object.defineProperty(
                  index % 2 === 0
                    ? LLMEvent.textDelta({ id: "text", text: "text" })
                    : LLMEvent.reasoningDelta({ id: "reasoning", text: "reasoning" }),
                  "text",
                  {
                    get: () => {
                      reads++
                      return "not retained"
                    },
                  },
                ),
              ),
              Stream.concat(Stream.make(call("read"), finish)),
            ),
        }).pipe(Stream.runDrain)

        expect(reads).toBe(0)
        expect(executions).toBe(toolExecution === "auto" ? 1 : 0)
      }),
    )
  }
})
