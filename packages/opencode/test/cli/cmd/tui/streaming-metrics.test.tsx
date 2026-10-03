/** @jsxImportSource @opentui/solid */
import { describe, expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Event, EventMessagePartDelta, EventMessageUpdated, Part } from "@opencode-ai/sdk/v2"
import { onMount } from "solid-js"
import { ProjectProvider } from "../../../../src/cli/cmd/tui/context/project"
import { SDKProvider, useSDK } from "../../../../src/cli/cmd/tui/context/sdk"
import { StreamingMetricsProvider, useStreamingMetrics } from "../../../../src/cli/cmd/tui/context/streaming-metrics"
import { createFetch, eventSource } from "./sync-fixture"

async function mount() {
  const ready = Promise.withResolvers<{
    metrics: ReturnType<typeof useStreamingMetrics>
    sdk: ReturnType<typeof useSDK>
  }>()

  function Probe() {
    const metrics = useStreamingMetrics()
    const sdk = useSDK()
    onMount(() => ready.resolve({ metrics, sdk }))
    return <box />
  }

  const app = await testRender(() => (
    <SDKProvider url="http://test" fetch={createFetch().fetch} events={eventSource()}>
      <ProjectProvider>
        <StreamingMetricsProvider>
          <Probe />
        </StreamingMetricsProvider>
      </ProjectProvider>
    </SDKProvider>
  ))
  const ctx = await ready.promise
  const clock = spyOn(Date, "now").mockReturnValue(1000)

  return {
    metrics: ctx.metrics,
    emit(payload: Event) {
      ctx.sdk.event.emit("event", { directory: "global", payload })
    },
    async expectRates(time: number, rates: Record<string, number>) {
      clock.mockReturnValue(time)
      const start = performance.now()
      // The provider's real ticker observes the controlled wall clock.
      while (Object.entries(rates).some(([id, rate]) => ctx.metrics.tps(id) !== rate)) {
        if (performance.now() - start > 2000) break
        await Bun.sleep(10)
      }
      expect(Object.fromEntries(Object.keys(rates).map((id) => [id, ctx.metrics.tps(id)]))).toEqual(rates)
    },
    [Symbol.dispose]() {
      app.renderer.destroy()
      clock.mockRestore()
    },
  }
}

function delta(
  sessionID: string,
  messageID: string,
  field: string,
  text: string,
  partID = "prt_text",
): EventMessagePartDelta {
  return {
    id: `evt_${sessionID}_${messageID}_${partID}`,
    type: "message.part.delta",
    properties: { sessionID, messageID, partID, field, delta: text },
  }
}

function message(sessionID: string, id: string, completed?: number): EventMessageUpdated {
  return {
    id: `evt_${sessionID}_${id}`,
    type: "message.updated",
    properties: {
      sessionID,
      info: {
        id,
        sessionID,
        role: "assistant",
        time: { created: 0, completed },
        parentID: "msg_user",
        modelID: "model",
        providerID: "provider",
        mode: "build",
        agent: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 99,
        tokens: { input: 10000, output: 5000, reasoning: 1000, cache: { read: 0, write: 0 } },
      },
    },
  }
}

function snapshot(part: Part): Event {
  return {
    id: `evt_${part.id}`,
    type: "message.part.updated",
    properties: { sessionID: part.sessionID, part, time: 1000 },
  }
}

describe("streaming metrics", () => {
  test("counts mixed text, reasoning, and coalesced tool arguments exactly once", async () => {
    using ctx = await mount()
    ctx.emit(delta("ses_a", "msg_a", "text", "text".repeat(10)))
    ctx.emit(delta("ses_a", "msg_a", "text", "think!!!".repeat(10), "prt_reasoning"))
    ctx.emit(delta("ses_a", "msg_a", "state.raw", '{"code":"', "prt_tool"))
    ctx.emit(delta("ses_a", "msg_a", "state.raw", "a".repeat(109) + '"}', "prt_tool"))
    ctx.emit(message("ses_a", "msg_a"))

    expect(ctx.metrics.active("ses_a")).toBe(true)
    expect(ctx.metrics.messageID("ses_a")).toBe("msg_a")
    expect(ctx.metrics.tps("ses_a")).toBe(0)
    await ctx.expectRates(2000, { ses_a: 60 })
    await ctx.expectRates(3000, { ses_a: 30 })
  })

  test("tool-only generation starts the rate and final snapshots do not inflate it", async () => {
    using ctx = await mount()
    const tool = {
      id: "prt_tool",
      sessionID: "ses_a",
      messageID: "msg_a",
      type: "tool",
      callID: "call_a",
      tool: "bash",
    } as const
    ctx.emit(delta("ses_a", "msg_a", "state.raw", '{"command":"echo hi"}', tool.id))
    ctx.emit(snapshot({ ...tool, state: { status: "pending", input: {}, raw: '{"command":"echo hi"}' } }))
    ctx.emit(
      snapshot({
        ...tool,
        state: {
          status: "completed",
          input: { command: "echo hi" },
          output: "hi".repeat(10000),
          title: "echo hi",
          metadata: {},
          time: { start: 1000, end: 2000 },
        },
      }),
    )
    ctx.emit(delta("ses_a", "msg_a", "state.output", "output".repeat(1000), tool.id))
    ctx.emit(delta("ses_a", "msg_a", "output", "output".repeat(1000), tool.id))

    expect(ctx.metrics.active("ses_a")).toBe(true)
    await ctx.expectRates(2000, { ses_a: 5 })
  })

  test("ignores empty deltas, unrelated fields, and text snapshots before generation", async () => {
    using ctx = await mount()
    ctx.emit(delta("ses_a", "msg_a", "text", ""))
    ctx.emit(delta("ses_a", "msg_a", "state.raw", "", "prt_tool"))
    ctx.emit(delta("ses_a", "msg_a", "state.output", "output"))
    ctx.emit(snapshot({ id: "prt_text", sessionID: "ses_a", messageID: "msg_a", type: "text", text: "old text" }))
    expect(ctx.metrics.active("ses_a")).toBe(false)
    expect(ctx.metrics.messageID("ses_a")).toBeUndefined()
    await ctx.expectRates(5000, { ses_a: 0 })

    ctx.emit(delta("ses_a", "msg_a", "text", "text"))
    ctx.emit(snapshot({ id: "prt_text", sessionID: "ses_a", messageID: "msg_a", type: "text", text: "text" }))
    await ctx.expectRates(6000, { ses_a: 1 })
  })

  test("completion clears the matching message without starting a rate from token usage", async () => {
    using ctx = await mount()
    ctx.emit(message("ses_a", "msg_previous", 500))
    expect(ctx.metrics.active("ses_a")).toBe(false)
    ctx.emit(delta("ses_a", "msg_a", "text", "text".repeat(10)))
    ctx.emit(message("ses_a", "msg_a"))
    ctx.emit(message("ses_a", "msg_previous", 1000))
    await ctx.expectRates(2000, { ses_a: 10 })

    ctx.emit(message("ses_a", "msg_a", 2000))
    expect(ctx.metrics.active("ses_a")).toBe(false)
    expect(ctx.metrics.messageID("ses_a")).toBeUndefined()
    expect(ctx.metrics.tps("ses_a")).toBe(0)

    ctx.emit(delta("ses_a", "msg_b", "state.raw", "tool"))
    ctx.emit(message("ses_a", "msg_a", 2000))
    expect(ctx.metrics.messageID("ses_a")).toBe("msg_b")
    await ctx.expectRates(3000, { ses_a: 1 })
  })

  test("keeps interleaved session rates and their start times independent", async () => {
    using ctx = await mount()
    ctx.emit(delta("ses_a", "msg_a", "text", "text".repeat(10)))
    await ctx.expectRates(2000, { ses_a: 10 })

    ctx.emit(delta("ses_b", "msg_b", "state.raw", "tool".repeat(20)))
    ctx.emit(delta("ses_a", "msg_a", "text", "more".repeat(10), "prt_reasoning"))
    ctx.emit(delta("ses_b", "msg_b", "text", "text".repeat(20)))
    expect(ctx.metrics.messageID("ses_a")).toBe("msg_a")
    expect(ctx.metrics.messageID("ses_b")).toBe("msg_b")
    expect(ctx.metrics.active("ses_other")).toBe(false)
    expect(ctx.metrics.active(undefined)).toBe(false)
    expect(ctx.metrics.messageID(undefined)).toBeUndefined()
    expect(ctx.metrics.tps(undefined)).toBe(0)
    await ctx.expectRates(3000, { ses_a: 10, ses_b: 40, ses_other: 0 })

    ctx.emit(message("ses_b", "msg_b", 3000))
    expect(ctx.metrics.active("ses_a")).toBe(true)
    expect(ctx.metrics.active("ses_b")).toBe(false)
    expect(ctx.metrics.tps("ses_a")).toBe(10)
    expect(ctx.metrics.tps("ses_b")).toBe(0)
  })

  test("a new message resets only its own session", async () => {
    using ctx = await mount()
    ctx.emit(delta("ses_a", "msg_a", "text", "text".repeat(10)))
    ctx.emit(delta("ses_b", "msg_b", "state.raw", "tool".repeat(20)))
    await ctx.expectRates(2000, { ses_a: 10, ses_b: 20 })

    ctx.emit(delta("ses_a", "msg_next", "text", "next"))
    ctx.emit(delta("ses_a", "msg_empty", "text", ""))
    expect(ctx.metrics.messageID("ses_a")).toBe("msg_next")
    expect(ctx.metrics.messageID("ses_b")).toBe("msg_b")
    await ctx.expectRates(3000, { ses_a: 1, ses_b: 10 })
  })

  test("idle clears only the affected session, including the legacy idle event", async () => {
    using ctx = await mount()
    ctx.emit(delta("ses_a", "msg_a", "text", "text"))
    ctx.emit(delta("ses_b", "msg_b", "state.raw", "tool"))
    ctx.emit({ id: "evt_busy", type: "session.status", properties: { sessionID: "ses_a", status: { type: "busy" } } })
    expect(ctx.metrics.active("ses_a")).toBe(true)

    ctx.emit({ id: "evt_idle", type: "session.status", properties: { sessionID: "ses_b", status: { type: "idle" } } })
    expect(ctx.metrics.active("ses_a")).toBe(true)
    expect(ctx.metrics.active("ses_b")).toBe(false)
    expect(ctx.metrics.messageID("ses_b")).toBeUndefined()
    expect(ctx.metrics.tps("ses_b")).toBe(0)

    ctx.emit({ id: "evt_legacy_idle", type: "session.idle", properties: { sessionID: "ses_a" } })
    expect(ctx.metrics.active("ses_a")).toBe(false)
    expect(ctx.metrics.tps("ses_a")).toBe(0)
  })

  test("bounds retained sessions when completion events are missing", async () => {
    using ctx = await mount()
    Array.from({ length: 129 }, (_, i) => {
      ctx.emit(delta(`ses_${i}`, `msg_${i}`, "text", "text"))
    })
    expect(ctx.metrics.active("ses_0")).toBe(false)
    expect(ctx.metrics.messageID("ses_0")).toBeUndefined()
    expect(ctx.metrics.active("ses_1")).toBe(true)
    expect(ctx.metrics.active("ses_128")).toBe(true)

    ctx.emit(message("ses_1", "msg_1", 1000))
    ctx.emit(delta("ses_129", "msg_129", "text", "text"))
    expect(ctx.metrics.active("ses_2")).toBe(true)
    expect(ctx.metrics.active("ses_129")).toBe(true)
    await ctx.expectRates(2000, { ses_0: 0, ses_1: 0, ses_2: 1, ses_128: 1, ses_129: 1 })
  })
})
