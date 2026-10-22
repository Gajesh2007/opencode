import { afterEach, expect, mock, spyOn, test } from "bun:test"
import * as Log from "@opencode-ai/core/util/log"
import { SessionTiming } from "../../src/session/timing"

for (const outcome of ["incomplete", "truncated", "error", "interrupted"] as const) {
  test(`a normal processor return does not relabel ${outcome} model output as completed`, () => {
    const records: SessionTiming.Record[] = []
    const timing = SessionTiming.start(
      { sessionID: "session", messageID: "step" },
      { emit: (record) => records.push(record) },
    )
    timing.request()
    timing.requestOutcome(outcome)
    timing.finish("completed")
    expect(records.filter((record) => record.phase === "request" || record.phase === "overall")).toMatchObject([
      { phase: "request", status: outcome },
      { phase: "overall", status: outcome },
    ])
  })
}

test("cleanup failure overrides a completed model outcome", () => {
  const records: SessionTiming.Record[] = []
  const timing = SessionTiming.start(
    { sessionID: "session", messageID: "step" },
    { emit: (record) => records.push(record) },
  )
  timing.request()
  timing.requestOutcome("completed")
  timing.finish("error")
  expect(records.at(-1)).toMatchObject({ phase: "overall", status: "error" })
})
import * as TimingStore from "../../src/session/timing-store"

afterEach(() => mock.restore())

test("phase durations use a monotonic clock and correlate retries and parallel tools", () => {
  let now = 0
  const records: SessionTiming.Record[] = []
  const timing = SessionTiming.start(
    { sessionID: "session", messageID: "step" },
    { now: () => now, emit: (r) => records.push(r) },
  )
  now = 10
  timing.prepared()
  timing.prepared()
  timing.request()
  now = 15
  timing.dispatched()
  timing.dispatched()
  now = 20
  timing.firstUseful("tool")
  timing.firstUseful("text")
  timing.toolStart("a", "bash")
  timing.toolStart("b", "read")
  now = 25
  timing.toolStart("a", "bash")
  timing.toolEnd("b", "completed")
  now = 40
  timing.toolEnd("a", "error")
  timing.toolEnd("a", "error")
  timing.request()
  now = 50
  timing.dispatched()
  now = 60
  timing.toolStart("c", "bash")
  timing.finish("interrupted")
  timing.finish("completed")
  expect(records.filter((r) => r.durationMs !== undefined).map((r) => [r.phase, r.durationMs])).toEqual([
    ["preparation", 10],
    ["dispatch", 5],
    ["first_useful", 5],
    ["tool", 5],
    ["tool", 20],
    ["request", 30],
    ["dispatch", 10],
    ["tool", 0],
    ["request", 20],
    ["overall", 60],
  ])
  expect(records.filter((r) => r.phase.endsWith("_start")).map((r) => [r.phase, r.elapsedMs])).toEqual([
    ["execution_start", 0],
    ["request_start", 10],
    ["tool_start", 20],
    ["tool_start", 20],
    ["request_start", 40],
    ["tool_start", 60],
  ])
  expect(new Set(records.map((r) => r.executionID))).toEqual(new Set([timing.executionID]))
  expect(records.filter((r) => r.phase === "tool").map((r) => r.requestID)).toEqual(["step:1", "step:1", "step:2"])
  expect(records.at(-1)).toMatchObject({ sessionID: "session", stepID: "step", status: "interrupted" })
})

test("empty attempts have no fabricated useful output and contain no prompt payloads", () => {
  let now = 1
  const records: SessionTiming.Record[] = []
  const timing = SessionTiming.start(
    { sessionID: "s", messageID: "m" },
    { now: () => now, emit: (r) => records.push(r) },
  )
  timing.prepared()
  timing.request()
  now = 3
  timing.request()
  now = 4
  timing.finish("error")
  expect(records.some((r) => r.phase.startsWith("first_") || r.phase === "dispatch")).toBe(false)
  expect(records.filter((r) => r.phase === "request").map((r) => r.status)).toEqual(["retry", "error"])
  expect(Object.keys(records[records.length - 1]).sort()).toEqual([
    "durationMs",
    "elapsedMs",
    "executionID",
    "phase",
    "requestID",
    "sessionID",
    "status",
    "stepID",
  ])
})

test("each execution has a fresh UUID even when its session and step are reused", () => {
  const records: SessionTiming.Record[] = []
  const input = { sessionID: "s", messageID: "m" }
  const options = { emit: (record: SessionTiming.Record) => records.push(record) }
  const first = SessionTiming.start(input, options)
  const second = SessionTiming.start(input, options)
  expect(first.executionID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(second.executionID).not.toBe(first.executionID)
  expect(first.request()).toBe(second.request())
  first.finish("completed")
  second.finish("completed")
  expect(new Set(records.map((record) => record.executionID)).size).toBe(2)
})

test("preparation is not dispatch and first observations are independent per logical request", () => {
  let now = 0
  const records: SessionTiming.Record[] = []
  const timing = SessionTiming.start(
    { sessionID: "s", messageID: "m" },
    { now: () => now, emit: (record) => records.push(record) },
  )
  timing.requestPrepared()
  timing.dispatched()
  timing.firstText()
  timing.firstReasoning()
  timing.firstUseful("text")
  now = 10
  timing.request()
  now = 15
  timing.requestPrepared()
  timing.requestPrepared()
  now = 20
  timing.firstReasoning()
  timing.firstReasoning()
  now = 25
  timing.firstUseful("tool")
  now = 30
  timing.firstText()
  timing.firstText()
  timing.firstUseful("text")
  expect(records.some((record) => record.phase === "dispatch")).toBe(false)
  now = 40
  timing.request()
  now = 50
  timing.requestPrepared()
  now = 60
  timing.dispatched()
  timing.dispatched()
  now = 70
  timing.firstText()
  now = 80
  timing.firstReasoning()
  now = 90
  timing.firstUseful("text")
  timing.finish("completed")
  expect(
    records
      .filter((record) => record.phase.startsWith("first_"))
      .map((record) => ({
        phase: record.phase,
        duration: record.durationMs,
        request: record.requestID,
        anchor: record.anchor,
        scope: record.attemptScope,
      })),
  ).toEqual([
    { phase: "first_reasoning", duration: 10, request: "m:1", anchor: "request_start", scope: "logical" },
    { phase: "first_useful", duration: 15, request: "m:1", anchor: "request_start", scope: "logical" },
    { phase: "first_text", duration: 20, request: "m:1", anchor: "request_start", scope: "logical" },
    { phase: "first_text", duration: 10, request: "m:2", anchor: "dispatch", scope: "logical" },
    { phase: "first_reasoning", duration: 20, request: "m:2", anchor: "dispatch", scope: "logical" },
    { phase: "first_useful", duration: 30, request: "m:2", anchor: "dispatch", scope: "logical" },
  ])
  expect(records.filter((record) => record.phase === "request_prepared").map((record) => record.durationMs)).toEqual([
    5, 10,
  ])
  expect(records.filter((record) => record.phase === "dispatch").map((record) => record.durationMs)).toEqual([20])
})

test("tool input, readiness, and execution remain distinct and retain the originating request", () => {
  let now = 0
  const records: SessionTiming.Record[] = []
  const timing = SessionTiming.start(
    { sessionID: "s", messageID: "m" },
    { now: () => now, emit: (record) => records.push(record) },
  )
  timing.request()
  now = 1
  timing.toolInputStart("a", "bash")
  timing.toolInputStart("a", "bash")
  now = 2
  timing.toolReady("b", "read")
  timing.toolReady("b", "read")
  timing.toolInputStart("b", "read")
  now = 3
  timing.toolReady("a", "bash")
  now = 4
  timing.toolStart("a", "bash")
  timing.toolStart("a", "bash")
  timing.toolStart("b", "read")
  now = 6
  timing.request()
  now = 7
  timing.toolEnd("a", "completed")
  timing.toolEnd("a", "completed")
  now = 9
  timing.toolEnd("b", "error")
  timing.finish("completed")
  expect(records.filter((record) => record.phase === "tool_input_start")).toHaveLength(1)
  expect(records.filter((record) => record.phase === "tool_ready")).toMatchObject([
    { callID: "b", elapsedMs: 2 },
    { callID: "a", elapsedMs: 3, durationMs: 2 },
  ])
  expect(records.find((record) => record.phase === "tool_ready" && record.callID === "b")).not.toHaveProperty(
    "durationMs",
  )
  expect(records.filter((record) => record.phase === "tool_start")).toHaveLength(2)
  expect(records.filter((record) => record.phase === "tool")).toMatchObject([
    { callID: "a", tool: "bash", requestID: "m:1", status: "completed", durationMs: 3 },
    { callID: "b", tool: "read", requestID: "m:1", status: "error", durationMs: 5 },
  ])
  expect(records.some((record) => record.phase.startsWith("first_"))).toBe(false)
})

test("approval tokens distinguish overlapping waits and finish interrupts only open spans", () => {
  let now = 0
  const records: SessionTiming.Record[] = []
  const timing = SessionTiming.start(
    { sessionID: "s", messageID: "m" },
    { now: () => now, emit: (record) => records.push(record) },
  )
  timing.request()
  timing.toolStart("a", "bash")
  now = 2
  const first = timing.permissionStart("a")
  now = 3
  const second = timing.permissionStart("a")
  const third = timing.permissionStart("b")
  expect(new Set([first, second, third]).size).toBe(3)
  now = 5
  timing.permissionEnd(first)
  timing.permissionEnd(first, "error")
  timing.permissionEnd(undefined)
  now = 8
  timing.permissionEnd(second, "error")
  now = 10
  timing.finish("completed")
  timing.permissionEnd(third)
  timing.toolEnd("a", "completed")
  expect(timing.permissionStart("a")).toBeUndefined()
  expect(records.filter((record) => record.phase === "approval_start")).toHaveLength(3)
  expect(records.filter((record) => record.phase === "approval")).toMatchObject([
    { approvalID: first, callID: "a", tool: "bash", requestID: "m:1", durationMs: 3, status: "completed" },
    { approvalID: second, callID: "a", tool: "bash", requestID: "m:1", durationMs: 5, status: "error" },
    { approvalID: third, callID: "b", requestID: "m:1", durationMs: 7, status: "interrupted" },
  ])
  expect(records.filter((record) => record.phase === "tool")).toMatchObject([
    { callID: "a", durationMs: 10, status: "interrupted" },
  ])
})

test("command handles record actual first output once and distinguish attempts for the same call", () => {
  let now = 0
  const records: SessionTiming.Record[] = []
  const timing = SessionTiming.start(
    { sessionID: "s", messageID: "m" },
    { now: () => now, emit: (record) => records.push(record) },
  )
  timing.request()
  timing.toolStart("a", "bash")
  const first = timing.command("a")
  const second = timing.command("a")
  const unstarted = timing.command("a")
  first.firstOutput()
  unstarted.end({ status: "error" })
  unstarted.start()
  now = 2
  first.start()
  now = 3
  first.start()
  second.start()
  now = 5
  first.firstOutput()
  now = 6
  first.firstOutput()
  now = 8
  second.end({ status: "error", exitCode: null })
  now = 10
  first.end({ status: "completed", exitCode: 0 })
  first.start()
  first.firstOutput()
  first.end({ status: "timeout" })
  timing.toolEnd("a", "completed")
  timing.finish("completed")
  const starts = records.filter((record) => record.phase === "command_start")
  expect(starts).toHaveLength(2)
  expect(starts[0].commandID).not.toBe(starts[1].commandID)
  expect(starts.every((record) => record.durationMs === undefined)).toBe(true)
  expect(records.filter((record) => record.phase === "command_first_output")).toMatchObject([
    { commandID: starts[0].commandID, callID: "a", tool: "bash", requestID: "m:1", durationMs: 3 },
  ])
  expect(records.filter((record) => record.phase === "command")).toMatchObject([
    { commandID: starts[1].commandID, durationMs: 5, status: "error", exitCode: null },
    { commandID: starts[0].commandID, durationMs: 8, status: "completed", exitCode: 0 },
  ])
})

for (const status of ["completed", "error", "interrupted", "timeout"] as const) {
  test(`empty ${status} commands do not fabricate first output`, () => {
    let now = 0
    const records: SessionTiming.Record[] = []
    const timing = SessionTiming.start(
      { sessionID: "s", messageID: "m" },
      { now: () => now, emit: (record) => records.push(record) },
    )
    const command = timing.command("a")
    command.start()
    now = 2
    command.end({ status })
    timing.finish(status)
    expect(records.some((record) => record.phase === "command_first_output")).toBe(false)
    expect(records.filter((record) => record.phase === "command")).toMatchObject([{ status, durationMs: 2 }])
  })
}

test("finish interrupts running commands without inventing output or exit codes and ignores late hooks", () => {
  let now = 0
  const records: SessionTiming.Record[] = []
  const timing = SessionTiming.start(
    { sessionID: "s", messageID: "m" },
    { now: () => now, emit: (record) => records.push(record) },
  )
  timing.request()
  timing.toolStart("a", "bash")
  const command = timing.command("a")
  now = 2
  command.start()
  now = 5
  timing.finish("error")
  const count = records.length
  timing.finish("completed")
  timing.prepared()
  timing.request()
  timing.requestPrepared()
  timing.dispatched()
  timing.firstUseful("text")
  timing.firstText()
  timing.firstReasoning()
  timing.toolInputStart("a", "bash")
  timing.toolReady("a", "bash")
  timing.toolStart("b", "read")
  timing.toolEnd("a", "completed")
  command.firstOutput()
  command.end({ status: "completed", exitCode: 0 })
  timing.command("b").start()
  expect(records).toHaveLength(count)
  expect(records.filter((record) => record.phase === "command")).toMatchObject([
    { callID: "a", tool: "bash", requestID: "m:1", status: "interrupted", durationMs: 3 },
  ])
  expect(records.find((record) => record.phase === "command")).not.toHaveProperty("exitCode")
  expect(records.some((record) => record.phase === "command_first_output")).toBe(false)
  expect(records.at(-1)).toMatchObject({ phase: "overall", status: "error", durationMs: 5 })
})

test("metadata merges only known scalar fields into subsequent records", () => {
  const records: SessionTiming.Record[] = []
  const input = {
    sessionID: "s",
    messageID: "m",
    providerID: "provider",
    modelID: "selected",
    variant: "high",
    requestedTier: "priority",
    runtime: "sdk",
    purpose: "assistant" as const,
    providerMetadata: { prompt: "secret" },
  }
  const timing = SessionTiming.start(input, { emit: (record) => records.push(record) })
  timing.request()
  expect(records.at(-1)).not.toHaveProperty("runtime")
  const metadata = {
    resolvedModelID: "served",
    returnedTier: "default",
    runtime: "native",
    purpose: "reviewer" as const,
    sessionID: "wrong-session",
    executionID: "wrong-execution",
    prompt: "secret",
    providerMetadata: { credentials: "secret" },
  }
  timing.metadata(metadata)
  timing.requestPrepared()
  const served = records.at(-1)
  timing.metadata({})
  timing.prepared()
  expect(records.at(-1)).toMatchObject({ resolvedModelID: "served", returnedTier: "default", purpose: "reviewer" })
  const cleared = {
    providerID: undefined,
    modelID: undefined,
    resolvedModelID: undefined,
    variant: undefined,
    requestedTier: undefined,
    returnedTier: undefined,
    runtime: undefined,
    purpose: undefined,
  }
  timing.metadata(cleared)
  timing.finish("completed")
  expect(records[0]).toMatchObject({
    providerID: "provider",
    modelID: "selected",
    variant: "high",
    requestedTier: "priority",
    runtime: "sdk",
    purpose: "assistant",
  })
  expect(records[0]).not.toHaveProperty("returnedTier")
  expect(served).toMatchObject({
    sessionID: "s",
    executionID: timing.executionID,
    providerID: "provider",
    modelID: "selected",
    resolvedModelID: "served",
    variant: "high",
    requestedTier: "priority",
    returnedTier: "default",
    runtime: "native",
    purpose: "reviewer",
  })
  for (const key of Object.keys(cleared)) expect(records.at(-1)).not.toHaveProperty(key)
  expect(JSON.stringify(records)).not.toContain("secret")
})

test("a failed retry does not inherit served metadata or fabricate a wire dispatch", () => {
  let now = 0
  const records: SessionTiming.Record[] = []
  const selected = {
    providerID: "provider",
    modelID: "selected",
    variant: "high",
    requestedTier: "priority",
    purpose: "assistant" as const,
  }
  const timing = SessionTiming.start(
    { sessionID: "s", messageID: "m", ...selected },
    { now: () => now, emit: (record) => records.push(record) },
  )
  now = 10
  timing.request()
  now = 15
  timing.requestPrepared()
  now = 20
  timing.metadata({ resolvedModelID: "served", returnedTier: "default", runtime: "native" })
  timing.firstText()
  now = 25
  timing.request()
  now = 30
  timing.requestPrepared()
  now = 35
  timing.finish("error")
  expect(records.find((record) => record.phase === "request" && record.requestID === "m:1")).toMatchObject({
    ...selected,
    resolvedModelID: "served",
    returnedTier: "default",
    runtime: "native",
    durationMs: 15,
  })
  const retry = records.filter((record) => record.requestID === "m:2")
  expect(retry.map((record) => record.phase)).toEqual(["request_start", "request_prepared", "request", "overall"])
  for (const record of retry) {
    expect(record).toMatchObject(selected)
    expect(record).not.toHaveProperty("resolvedModelID")
    expect(record).not.toHaveProperty("returnedTier")
    expect(record).not.toHaveProperty("runtime")
  }
  expect(retry.at(-1)).toMatchObject({ status: "error" })
  expect(records.find((record) => record.phase === "first_text")).toMatchObject({
    requestID: "m:1",
    modelID: "selected",
    resolvedModelID: "served",
    durationMs: 10,
    attemptScope: "logical",
    anchor: "request_start",
  })
  expect(records.some((record) => record.phase === "dispatch")).toBe(false)
})

test("elapsed times never move backwards and durations match their start markers", () => {
  let now = 100
  const records: SessionTiming.Record[] = []
  const timing = SessionTiming.start(
    { sessionID: "s", messageID: "m" },
    { now: () => now, emit: (record) => records.push(record) },
  )
  now = 105
  timing.request()
  now = 102
  timing.toolStart("a", "bash")
  now = 110
  timing.firstText()
  now = 90
  timing.finish("interrupted")
  expect(records.map((record) => record.elapsedMs)).toEqual([0, 5, 5, 10, 10, 10, 10])
  expect(records.filter((record) => record.durationMs !== undefined).map((record) => record.durationMs)).toEqual([
    5, 5, 5, 10,
  ])
})

test("default emission logs, writes, and flushes while custom emitters and disabled collectors stay pure", () => {
  const records: SessionTiming.Record[] = []
  const log = spyOn(Log.create({ service: "session.timing" }), "info").mockImplementation(() => {})
  const write = spyOn(TimingStore, "write").mockImplementation((record) => records.push(record))
  const flush = spyOn(TimingStore, "flush").mockImplementation(() => {})
  const timing = SessionTiming.start({ sessionID: "s", messageID: "m" })
  timing.request()
  timing.finish("completed")
  timing.finish("completed")
  expect(records.map((record) => record.phase)).toEqual(["execution_start", "request_start", "request", "overall"])
  expect(log).toHaveBeenCalledTimes(records.length)
  expect(flush).toHaveBeenCalledTimes(1)
  const pure: SessionTiming.Record[] = []
  const custom = SessionTiming.start({ sessionID: "s", messageID: "m" }, { emit: (record) => pure.push(record) })
  custom.request()
  custom.finish("completed")
  expect(pure).toHaveLength(4)
  for (const emit of [undefined, (record: SessionTiming.Record) => pure.push(record)]) {
    const disabled = SessionTiming.start({ sessionID: "s", messageID: "m" }, { enabled: false, emit })
    disabled.request()
    disabled.toolStart("a", "bash")
    disabled.permissionEnd(disabled.permissionStart("a"))
    const command = disabled.command("a")
    command.start()
    command.firstOutput()
    command.end({ status: "completed", exitCode: 0 })
    disabled.finish("completed")
  }
  expect(pure).toHaveLength(4)
  expect(log).toHaveBeenCalledTimes(4)
  expect(write).toHaveBeenCalledTimes(4)
  expect(flush).toHaveBeenCalledTimes(1)
})

test("logging, storage, flushing, and custom emitter failures never escape the collector", () => {
  const log = spyOn(Log.create({ service: "session.timing" }), "info").mockImplementation(() => {
    throw new Error("log unavailable")
  })
  const write = spyOn(TimingStore, "write").mockImplementation(() => {
    throw new Error("store unavailable")
  })
  const flush = spyOn(TimingStore, "flush").mockImplementation(() => {
    throw new Error("flush unavailable")
  })
  expect(() => {
    const timing = SessionTiming.start({ sessionID: "s", messageID: "m" })
    timing.request()
    timing.toolStart("a", "bash")
    timing.permissionStart("a")
    timing.command("a").start()
    timing.finish("interrupted")
    timing.finish("completed")
    const custom = SessionTiming.start(
      { sessionID: "s", messageID: "m" },
      {
        emit: () => {
          throw new Error("emitter unavailable")
        },
      },
    )
    custom.request()
    custom.finish("completed")
  }).not.toThrow()
  expect(log).toHaveBeenCalledTimes(10)
  expect(write).toHaveBeenCalledTimes(10)
  expect(flush).toHaveBeenCalledTimes(1)
})
