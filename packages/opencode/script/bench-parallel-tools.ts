import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, open, realpath, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { sse } from "./bench-bedrock-report"

// Only this process has provider credentials. The CLI receives a loopback key,
// an isolated home, and a synthetic repository, never the user's configuration.
export const fixtureIDs = ["known-files", "discovery", "dependent-reads", "conflicting-edits"] as const
type FixtureID = (typeof fixtureIDs)[number]
type Model = "gpt-6.1-sol" | "gpt-6-astra"
type Arm = {
  prompt: string
  readMany: boolean
  grepContext?: boolean
  parallelToolCalls?: boolean
  ablation?: "serial"
}
type Action = { tool: string; input: Record<string, unknown> }
type Observation = { file: string; needle: string; kind: "read" | "search" | "context" }
export type Fixture = {
  id: FixtureID
  prompt: string
  files: Record<string, string>
  expected: Record<string, string | number>
  observations: Observation[]
  dependencies: [number, number][]
  finalFiles?: Record<string, string>
}
export type Call = {
  callID?: string
  tool: string
  status?: string
  truncated?: boolean | null
  turn: number
  startMs: number
  endMs: number
  ok: boolean
  reads: { file: string; text: string; ok: boolean; truncated?: boolean | null }[]
  writes: string[]
  output: string
}
export type Caps = {
  calls: number
  callsPerSample: number
  outputTokens: number
  inputTokens: number
  walltimeMs: number
  sampleMs: number
  usd: number
}
type Prices = { input: number; output: number }
export type Options = {
  mode: "offline" | "live"
  allowLive?: boolean
  output?: string
  models?: Model[]
  provider?: "openai" | "amazon-bedrock"
  runtime?: "native" | "ai-sdk"
  tier?: "default" | "priority" | "ultrafast"
  effort?: "low" | "medium" | "high" | "xhigh"
  runs?: number
  only?: FixtureID[]
  arms?: { baseline: Arm; candidate: Arm }
  caps?: Partial<Caps>
  prices?: Prices
  authSource?: "env" | "stored"
  offlineResponse?: (input: { turn: number; response: Response }) => Response | Promise<Response>
}

class BenchError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const compact = (text: string) => text.replace(/\s/g, "")
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
const identifier = (value: unknown) =>
  typeof value === "string" && /^[\w.:/-]{1,128}$/.test(value) ? value : undefined
const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
const canonical = (value: unknown): string =>
  JSON.stringify(
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  )

export function sandboxCommand(command: string[], port: number | undefined) {
  if (process.platform !== "darwin") throw new BenchError("loopback-sandbox-unavailable")
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new BenchError("invalid-sandbox-port")
  return [
    "/usr/bin/sandbox-exec",
    "-p",
    [
      "(version 1)",
      "(allow default)",
      "(deny network*)",
      `(allow network-outbound (remote tcp "localhost:${port}"))`,
      '(deny mach-lookup (global-name "com.apple.mDNSResponder"))',
      '(deny file-read* (subpath "/Library/Managed Preferences") (subpath "/Library/Application Support/opencode"))',
    ].join("\n"),
    ...command,
  ]
}

// Own the upstream reader: pipeThrough's flush is not called on a body error.
// Never expose the upstream exception to Bun's response logger or the client.
export function relay(
  body: ReadableStream<Uint8Array>,
  callbacks: {
    chunk: (value: Uint8Array) => void
    finish: () => void
    stop: (reason: string) => void
  },
) {
  const reader = body.getReader()
  let closed = false
  return new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        const next = await reader.read()
        if (closed) return
        if (next.done) {
          callbacks.finish()
          if (!closed) {
            closed = true
            output.close()
          }
          return
        }
        callbacks.chunk(next.value)
        output.enqueue(next.value)
      } catch {
        if (closed) return
        callbacks.stop("provider-body-error")
        await reader.cancel().catch(() => {})
        if (!closed) {
          closed = true
          output.close()
        }
      }
    },
    async cancel() {
      closed = true
      callbacks.stop("client-disconnected")
      await reader.cancel().catch(() => {})
    },
  })
}

export function fixture(id: FixtureID, trial = 0): Fixture {
  const code = (name: string) => hash(`parallel-tools-v1:${trial}:${name}`).slice(0, 12)
  const names = ["amber", "cobalt", "jade", "plum"]
  const files = Object.fromEntries(
    names.map((name) => [`data/${name}.json`, JSON.stringify({ code: code(name) }) + "\n"]),
  )
  const observations = names.map((name) => ({ file: `data/${name}.json`, needle: code(name), kind: "read" as const }))
  const format = " Return only the requested JSON object, without Markdown. Work only inside this fixture."
  if (id === "known-files")
    return {
      id,
      prompt: `Read data/amber.json, data/cobalt.json, data/jade.json, and data/plum.json. Return their code values keyed by amber, cobalt, jade, plum. Do not edit files.${format}`,
      files: { ...files, "data/unused.json": '{"code":"decoy"}\n' },
      expected: Object.fromEntries(names.map((name) => [name, code(name)])),
      observations,
      dependencies: [],
    }
  if (id === "discovery")
    return {
      id,
      prompt: `Find BENCH_TARGET under src using a content search, inspect its nearby file references, then read the two referenced files. Return their code values keyed by amber and cobalt. Do not guess paths or edit files.${format}`,
      files: {
        ...files,
        "src/routes.ts":
          'export const BENCH_TARGET = true\nexport const files = ["data/amber.json", "data/cobalt.json"]\n',
        "src/decoy.ts": 'export const OTHER_TARGET = ["data/jade.json", "data/plum.json"]\n',
      },
      expected: { amber: code("amber"), cobalt: code("cobalt") },
      observations: [
        { file: "src/routes.ts", needle: "BENCH_TARGET", kind: "search" },
        { file: "src/routes.ts", needle: '["data/amber.json", "data/cobalt.json"]', kind: "context" },
        ...observations.slice(0, 2),
      ],
      dependencies: [
        [0, 1],
        [1, 2],
        [1, 3],
      ],
    }
  if (id === "dependent-reads") {
    const target = `data/stage-${code("path")}.json`
    return {
      id,
      prompt: `Read pointer.json, then read the file it names. Return its code as {"value":"..."}. The second path is not known until the first read completes. Do not edit files.${format}`,
      files: {
        "pointer.json": JSON.stringify({ next: target }) + "\n",
        [target]: JSON.stringify({ code: code("value") }) + "\n",
      },
      expected: { value: code("value") },
      observations: [
        { file: "pointer.json", needle: target, kind: "read" },
        { file: target, needle: code("value"), kind: "read" },
      ],
      dependencies: [[0, 1]],
    }
  }
  return {
    id,
    prompt: `Read counter.json. First add 4 to its value and apply that edit. Read it again to verify the intermediate value, then multiply that verified value by 3 in a second, separate edit. Read it once more and return {"value":21}. These edits conflict: do not combine them or run them concurrently.${format}`,
    files: { "counter.json": '{"value":3}\n' },
    expected: { value: 21 },
    observations: [3, 7, 21].map((value) => ({ file: "counter.json", needle: `"value":${value}`, kind: "read" })),
    dependencies: [
      [0, 1],
      [1, 2],
    ],
    finalFiles: { "counter.json": '{"value":21}\n' },
  }
}

export function score(
  task: Fixture,
  input: {
    calls: Call[]
    answers: { text: string; ms: number }[]
    files: Record<string, string>
    completed: boolean
  },
) {
  const found = new Map<number, Call>()
  const counts = {
    validUniqueNecessaryReads: 0,
    redundantReads: 0,
    unnecessaryReads: 0,
    incompleteReads: 0,
    readErrors: 0,
    truncatedReads: 0,
  }
  for (const call of input.calls) {
    if (call.tool === "grep" && call.ok) {
      task.observations.forEach((item, i) => {
        if (
          item.kind !== "read" &&
          compact(call.output).includes(compact(item.needle)) &&
          call.output.includes(item.file)
        )
          found.set(i, found.get(i) ?? call)
      })
    }
    for (const read of call.reads) {
      if (read.truncated) counts.truncatedReads++
      if (!read.ok) {
        counts.readErrors++
        continue
      }
      const matched = task.observations.flatMap((item, i) =>
        item.kind !== "search" && item.file === read.file && compact(read.text).includes(compact(item.needle))
          ? [i]
          : [],
      )
      const fresh = matched.filter((i) => !found.has(i))
      if (fresh.length) {
        fresh.forEach((i) => found.set(i, call))
        counts.validUniqueNecessaryReads += fresh.length
        continue
      }
      if (matched.length) {
        counts.redundantReads++
        continue
      }
      if (task.observations.some((item) => item.kind !== "search" && item.file === read.file)) {
        counts.incompleteReads++
        continue
      }
      counts.unnecessaryReads++
    }
  }
  const writes = input.calls.filter((call) => call.writes.length)
  const dependencyViolations = task.dependencies.filter(([before, after]) => {
    const a = found.get(before)
    const b = found.get(after)
    if (a === b && b?.tool === "grep" && task.observations[after].kind === "context") return false
    return b && (!a || a.turn >= b.turn || a.endMs > b.startMs)
  }).length
  const conflictingWritePairs = writes.flatMap((a, i) =>
    writes
      .slice(i + 1)
      .filter(
        (b) =>
          a.writes.some((file) => b.writes.includes(file)) &&
          (a.turn === b.turn || Math.max(a.startMs, b.startMs) < Math.min(a.endMs, b.endMs)),
      ),
  ).length
  const editSequenceValid =
    task.id !== "conflicting-edits" ||
    (writes.length === 2 &&
      writes.every((call) => call.ok) &&
      [0, 1].every((i) => {
        const before = found.get(i)
        const after = found.get(i + 1)
        return (
          before &&
          after &&
          before.turn < writes[i].turn &&
          writes[i].turn < after.turn &&
          before.endMs <= writes[i].startMs &&
          writes[i].endMs <= after.startMs
        )
      }))
  const protectedFilesUnchanged = Object.entries(task.files).every(
    ([name, text]) => name in (task.finalFiles ?? {}) || input.files[name] === text,
  )
  const finalFilesCorrect = Object.entries(task.finalFiles ?? {}).every(
    ([name, text]) => compact(input.files[name] ?? "") === compact(text),
  )
  const last = input.answers.at(-1)
  const answerCorrect = !!last && canonical(parse(last.text.trim())) === canonical(task.expected)
  const correct =
    input.completed &&
    answerCorrect &&
    found.size === task.observations.length &&
    dependencyViolations === 0 &&
    conflictingWritePairs === 0 &&
    editSequenceValid &&
    protectedFilesUnchanged &&
    finalFilesCorrect
  const turns = [...new Set(input.calls.map((call) => call.turn))].sort((a, b) => a - b)
  return {
    correct,
    answerCorrect,
    ...counts,
    necessaryReadStages: task.observations.filter((item) => item.kind === "read").length,
    flexibleContextStages: task.observations.filter((item) => item.kind === "context").length,
    uniqueNecessaryFiles: new Set(
      [...found.keys()]
        .filter((i) => task.observations[i].kind !== "search" && found.get(i)?.tool !== "grep")
        .map((i) => task.observations[i].file),
    ).size,
    missingEvidence: task.observations.length - found.size,
    toolErrors: input.calls.filter((call) => !call.ok).length,
    dependencyViolations,
    conflictingWritePairs,
    editSequenceValid,
    protectedFilesUnchanged,
    finalFilesCorrect,
    batchWidths: turns.map((turn) => input.calls.filter((call) => call.turn === turn).length),
    readBatchWidths: turns.map((turn) =>
      input.calls.filter((call) => call.turn === turn).reduce((n, call) => n + call.reads.length, 0),
    ),
    timeToCorrectFinalAnswerMs: correct ? last?.ms : null,
  }
}

export function budget(caps: Caps, prices: Prices) {
  if (![prices.input, prices.output].every((value) => Number.isFinite(value) && value >= 0))
    throw new BenchError("invalid-price-ceiling")
  if (!Number.isFinite(caps.usd) || caps.usd < 0 || caps.usd > 20) throw new BenchError("invalid-spend-cap")
  const state = { calls: 0, reservedUsd: 0 }
  return {
    state,
    reserve(bytes: number, sampleCalls: number) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(sampleCalls) || sampleCalls < 0)
        throw new BenchError("invalid-reservation")
      if (state.calls >= caps.calls || sampleCalls >= caps.callsPerSample) throw new BenchError("call-cap")
      // UTF-8 bytes plus framing allowance deliberately overcounts input tokens.
      // This is a spend ESTIMATE, not a promise about provider-side billing.
      const input = bytes + 1024
      if (input > caps.inputTokens) throw new BenchError("input-cap")
      const usd = (input * prices.input + caps.outputTokens * prices.output) / 1_000_000
      if (!Number.isFinite(usd) || !Number.isFinite(state.reservedUsd + usd))
        throw new BenchError("invalid-reservation")
      if (state.reservedUsd + usd > caps.usd) throw new BenchError("spend-cap")
      state.calls++
      state.reservedUsd += usd
      return usd
    },
  }
}

export function rewritePrompt(value: unknown, builtin: string, replacement: string) {
  let replaced = 0
  const visit = (value: unknown): unknown => {
    if (typeof value === "string" && value.startsWith(builtin)) {
      replaced++
      return replacement + value.slice(builtin.length)
    }
    if (Array.isArray(value)) return value.map(visit)
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]))
    return value
  }
  const result = visit(value)
  if (replaced !== 1) throw new BenchError("prompt-snapshot-mismatch")
  return result
}

function script(task: Fixture, arm: Arm, directory: string): Action[][] {
  const read = (file: string): Action => ({ tool: "read", input: { filePath: path.join(directory, file) } })
  const batch = (files: string[]) =>
    arm.readMany
      ? [{ tool: "read_many", input: { files: files.map((file) => ({ filePath: path.join(directory, file) })) } }]
      : files.map(read)
  if (task.id === "known-files") {
    const files = task.observations.map((item) => item.file)
    return arm.parallelToolCalls === false ? files.map((file) => [read(file)]) : [batch(files)]
  }
  if (task.id === "discovery")
    return [
      [
        {
          tool: "grep",
          input: {
            pattern: "BENCH_TARGET",
            path: path.join(directory, "src"),
            ...(arm.grepContext ? { context: 2 } : {}),
          },
        },
      ],
      ...(arm.grepContext ? [] : [[read("src/routes.ts")]]),
      ...(arm.parallelToolCalls === false
        ? task.observations.slice(2).map((item) => [read(item.file)])
        : [batch(task.observations.slice(2).map((item) => item.file))]),
    ]
  if (task.id === "dependent-reads") return task.observations.map((item) => [read(item.file)])
  const patch = (before: number, after: number): Action => ({
    tool: "apply_patch",
    input: {
      patchText: `*** Begin Patch\n*** Update File: counter.json\n@@\n-{"value":${before}}\n+{"value":${after}}\n*** End Patch`,
    },
  })
  return [[read("counter.json")], [patch(3, 7)], [read("counter.json")], [patch(7, 21)], [read("counter.json")]]
}

function response(actions: Action[], model: string, tier: string, turn: number, answer: object) {
  const events: object[] = [{ type: "response.created", response: { id: `resp_${turn}`, model, created_at: 1 } }]
  const output: object[] = []
  actions.forEach((action, i) => {
    const item = {
      type: "function_call",
      id: `fc_${turn}_${i}`,
      call_id: `call_${turn}_${i}`,
      name: action.tool,
      arguments: JSON.stringify(action.input),
      status: "completed",
    }
    output.push(item)
    events.push(
      { type: "response.output_item.added", output_index: i, item: { ...item, arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", output_index: i, item_id: item.id, delta: item.arguments },
      { type: "response.function_call_arguments.done", output_index: i, item_id: item.id, arguments: item.arguments },
      { type: "response.output_item.done", output_index: i, item },
    )
  })
  if (!actions.length) {
    const text = JSON.stringify(answer)
    const item = {
      type: "message",
      id: `msg_${turn}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }
    output.push(item)
    events.push(
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        item_id: item.id,
        delta: text,
        logprobs: [],
      },
      { type: "response.output_item.done", output_index: 0, item },
    )
  }
  events.push({
    type: "response.completed",
    response: {
      id: `resp_${turn}`,
      model,
      service_tier: tier,
      status: "completed",
      output,
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  })
  return new Response(
    events.map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

type Request = {
  turn: number
  reservedUsd: number
  inputTokenEstimateCeiling: number
  parallelToolCalls?: boolean
  appRequestedTier?: string
  appRequestedEffort?: string
  completed: boolean
  servedModel?: string
  servedTier?: string
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  reasoningTokens?: number
  firstByteMs?: number
  finishedMs?: number
  calls: { id: string; tool: string; advertised: boolean; emittedMs: number; readyMs?: number }[]
}

function callsFromEvents(
  events: Record<string, unknown>[],
  task: Fixture,
  directory: string,
  requests: Request[],
  started: number,
) {
  const relative = (value: unknown) => {
    if (typeof value !== "string") return "<invalid>"
    const file = path.relative(directory, path.resolve(directory, value)).replaceAll("\\", "/")
    return file in task.files ? file : "<outside-fixture>"
  }
  const unique = new Map<string, Call>()
  for (const event of events) {
    if (event.type !== "tool_use") continue
    const part = record(event.part)
    const state = record(part.state)
    const input = record(state.input)
    const time = record(state.time)
    const id = String(part.callID)
    const tool = typeof part.tool === "string" ? part.tool : "unknown"
    const output = typeof state.output === "string" ? state.output : ""
    const ok = state.status === "completed"
    const files =
      tool === "read"
        ? [input.filePath]
        : tool === "read_many" && Array.isArray(input.files)
          ? input.files.map((file) => record(file).filePath)
          : []
    const results = record(state.metadata).results
    const reads = files.map((file, index) => {
      const entry = record(Array.isArray(results) ? results[index] : undefined)
      const text =
        tool === "read"
          ? output
          : (output
              .split(/(?=^\[\d+\] (?:success|error|cancelled):)/m)
              .find((chunk) => chunk.startsWith(`[${index + 1}] `)) ?? "")
      return {
        file: relative(file),
        text,
        truncated:
          typeof entry.truncated === "boolean"
            ? entry.truncated
            : tool === "read" && typeof record(state.metadata).truncated === "boolean"
              ? (record(state.metadata).truncated as boolean)
              : null,
        ok:
          ok &&
          !!text &&
          (tool === "read" || (entry.status === "success" && relative(entry.filePath) === relative(file))),
      }
    })
    const patch = typeof input.patchText === "string" ? input.patchText : ""
    unique.set(id, {
      callID: id,
      tool,
      status: typeof state.status === "string" ? state.status : "unknown",
      truncated:
        typeof record(state.metadata).truncated === "boolean" ? (record(state.metadata).truncated as boolean) : null,
      turn: requests.find((request) => request.calls.some((call) => call.id === id))?.turn ?? -1,
      startMs: (number(time.start) ?? started) - started,
      endMs: (number(time.end) ?? started) - started,
      ok,
      reads,
      writes: [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => relative(match[1])),
      output,
    })
  }
  return [...unique.values()].sort((a, b) => a.startMs - b.startMs)
}

export function toolTelemetry(
  calls: Call[],
  stderr: string,
  requests: Pick<Request, "turn" | "calls">[],
  requestedRuntime: "native" | "ai-sdk",
) {
  const publicID = (value: string) => hash(value).slice(0, 20)
  const name = (value: unknown) =>
    ["read", "read_many", "grep", "glob", "apply_patch", "invalid"].includes(String(value)) ? String(value) : "unknown"
  const timings = stderr.split("\n").flatMap((line) => {
    const timing = record(parse(line.match(/service=session\.timing .*?timing=(\{.*\}) phase$/)?.[1] ?? ""))
    return timing.phase === "tool" && typeof timing.callID === "string"
      ? [
          {
            callID: timing.callID,
            tool: name(timing.tool),
            status: ["completed", "error", "interrupted"].includes(String(timing.status))
              ? String(timing.status)
              : "unknown",
            durationMs: number(timing.durationMs),
            elapsedMs: number(timing.elapsedMs),
            requestID: typeof timing.requestID === "string" ? publicID(timing.requestID) : null,
          },
        ]
      : []
  })
  const emitted = requests.flatMap((request) => request.calls.map((call) => ({ ...call, turn: request.turn })))
  const ids = [
    ...new Set([
      ...emitted.map((call) => call.id),
      ...calls.flatMap((call) => (call.callID ? [call.callID] : [])),
      ...timings.map((timing) => timing.callID),
    ]),
  ]
  const tools = ids.map((id) => {
    const wire = emitted.find((call) => call.id === id)
    const terminal = calls.find((call) => call.callID === id)
    const timing = timings.find((call) => call.callID === id)
    return {
      callID: publicID(id),
      tool: name(wire?.tool ?? terminal?.tool ?? timing?.tool),
      turn: wire?.turn ?? terminal?.turn ?? null,
      emitted: !!wire,
      invoked: timing ? true : null,
      terminalStatus: terminal?.status ?? null,
      invocationStatus: timing?.status ?? null,
      invokedTool: timing?.tool ?? null,
      unknownTool: wire?.advertised === false || terminal?.tool === "invalid",
      emittedMs: wire?.emittedMs ?? null,
      readyMs: wire?.readyMs ?? null,
      truncated: terminal?.truncated ?? null,
      reads: terminal?.reads.map((read) => ({ file: read.file, ok: read.ok, truncated: read.truncated ?? null })) ?? [],
    }
  })
  const selections = stderr.split("\n").filter((line) => line.includes("llm runtime selected"))
  const observed = [
    ...new Set(selections.flatMap((line) => line.match(/llm\.runtime=(native|ai-sdk)(?:\s|$)/)?.[1] ?? [])),
  ]
  const fallbackReasons = selections.flatMap((line) => {
    const reason = line.match(/llm\.native_unsupported_reason=(.*?) llm runtime selected/)?.[1]
    return reason ? [hash(reason)] : []
  })
  return {
    tools,
    emittedToolCalls: emitted.length,
    invokedToolCalls: tools.filter((tool) => tool.invoked).length,
    terminalToolCalls: calls.length,
    unknownToolCalls: tools.filter((tool) => tool.unknownTool).length,
    unknownInvocationToolCalls: tools.filter((tool) => tool.invoked === null).length,
    unobservedEmittedToolCalls: tools.filter((tool) => tool.emitted && tool.invoked === null && !tool.terminalStatus)
      .length,
    emittedBatchWidths: requests.map((request) => request.calls.length),
    terminalBatchWidths: requests.map((request) => calls.filter((call) => call.turn === request.turn).length),
    toolDurations: timings.map((timing) => ({ ...timing, callID: publicID(timing.callID) })),
    runtime: {
      requested: requestedRuntime,
      observed,
      matched: observed.length === 1 && observed[0] === requestedRuntime,
      fallback: fallbackReasons.length > 0 || observed.some((runtime) => runtime !== requestedRuntime),
      fallbackReasonSha256: [...new Set(fallbackReasons)],
    },
  }
}

export function settings(options: Options) {
  if (options.mode !== "offline" && options.mode !== "live") throw new BenchError("invalid-mode")
  if (options.mode === "live" && !options.allowLive) throw new BenchError("live-not-authorized")
  if (
    options.mode === "live" &&
    (!options.arms?.baseline.prompt ||
      options.caps?.usd === undefined ||
      options.caps?.calls === undefined ||
      !options.prices)
  )
    throw new BenchError("live-requires-snapshot-caps-and-prices")
  const caps: Caps = {
    calls: 128,
    callsPerSample: 8,
    outputTokens: 768,
    inputTokens: 65536,
    walltimeMs: 900000,
    sampleMs: 120000,
    usd: options.mode === "offline" ? 0 : 1,
    ...options.caps,
  }
  for (const [name, value, min, max] of [
    ["calls", caps.calls, 1, 128],
    ["calls-per-sample", caps.callsPerSample, 1, 12],
    ["output-tokens", caps.outputTokens, 64, 2048],
    ["input-tokens", caps.inputTokens, 1024, 131072],
    ["walltime", caps.walltimeMs, 1000, 3600000],
    ["sample-time", caps.sampleMs, 1000, 180000],
    ["runs", options.runs ?? 1, 1, 5],
  ] as const)
    if (!Number.isInteger(value) || value < min || value > max) throw new BenchError(`invalid-${name}`)
  const prices = options.mode === "offline" ? { input: 0, output: 0 } : (options.prices ?? { input: 0, output: 0 })
  if (!Number.isFinite(caps.usd) || caps.usd < (options.mode === "offline" ? 0 : 0.000001) || caps.usd > 20)
    throw new BenchError("invalid-spend-cap")
  if (![prices.input, prices.output].every((value) => Number.isFinite(value) && value > 0) && options.mode === "live")
    throw new BenchError("invalid-price-ceiling")
  if (options.mode !== "offline" && options.offlineResponse) throw new BenchError("offline-hook-in-live-mode")
  const models = options.models ?? ["gpt-6.1-sol", "gpt-6-astra"]
  const cases = options.only ?? [...fixtureIDs]
  if (
    !models.length ||
    new Set(models).size !== models.length ||
    models.some((model) => !["gpt-6.1-sol", "gpt-6-astra"].includes(model))
  )
    throw new BenchError("invalid-models")
  if (!cases.length || new Set(cases).size !== cases.length || cases.some((id) => !fixtureIDs.includes(id)))
    throw new BenchError("invalid-fixtures")
  if (options.provider && !["openai", "amazon-bedrock"].includes(options.provider))
    throw new BenchError("invalid-provider")
  if (options.runtime && !["native", "ai-sdk"].includes(options.runtime)) throw new BenchError("invalid-runtime")
  if (options.tier && !["default", "priority", "ultrafast"].includes(options.tier)) throw new BenchError("invalid-tier")
  if (options.effort && !["low", "medium", "high", "xhigh"].includes(options.effort))
    throw new BenchError("invalid-effort")
  if (options.authSource && !["env", "stored"].includes(options.authSource)) throw new BenchError("invalid-auth-source")
  if (
    options.arms &&
    Object.values(options.arms).some(
      (arm) =>
        !arm.prompt.trim() ||
        arm.prompt.length > 65536 ||
        typeof arm.readMany !== "boolean" ||
        (arm.ablation !== undefined && arm.ablation !== "serial") ||
        (arm.grepContext !== undefined && typeof arm.grepContext !== "boolean") ||
        (arm.parallelToolCalls !== undefined && typeof arm.parallelToolCalls !== "boolean"),
    )
  )
    throw new BenchError("invalid-arm")
  if (
    options.arms &&
    Object.values(options.arms).some((arm) => arm.parallelToolCalls === false && arm.ablation !== "serial")
  )
    throw new BenchError("serial-ablation-label-required")
  return {
    caps,
    prices,
    models,
    cases,
    runs: options.runs ?? 1,
    provider: options.provider ?? "openai",
    runtime: options.runtime ?? "native",
    tier: options.tier ?? "default",
    effort: options.effort ?? "low",
  }
}

export async function run(options: Options) {
  const config = settings(options)
  if (!(await Bun.file("/usr/bin/sandbox-exec").exists())) throw new BenchError("loopback-sandbox-unavailable")
  const sandbox = Bun.spawnSync(sandboxCommand(["/usr/bin/true"], 1), {
    stdout: "ignore",
    stderr: "pipe",
    timeout: 3000,
  })
  if (sandbox.exitCode !== 0) throw new BenchError("loopback-sandbox-unavailable")
  if (!Bun.which("rg")) throw new BenchError("rg-required-no-downloads")
  const builtin = await Bun.file(path.join(import.meta.dir, "../src/session/prompt/gpt.txt")).text()
  const sources = Object.fromEntries(
    await Promise.all(
      [
        "script/bench-parallel-tools.ts",
        "src/session/prompt/gpt.txt",
        "src/session/tools.ts",
        "src/session/llm/native-runtime.ts",
        "src/session/llm/tool-execution.ts",
        "src/provider/transform.ts",
        "src/tool/read.ts",
        "src/tool/read-many.ts",
        "src/tool/grep.ts",
        "../llm/src/tool-runtime.ts",
      ].map(async (name) => [
        name,
        await Bun.file(path.resolve(import.meta.dir, "..", name))
          .text()
          .then(hash, () => null),
      ]),
    ),
  )
  const arms = options.arms ?? {
    baseline: { prompt: builtin, readMany: false, grepContext: false },
    candidate: { prompt: builtin, readMany: false, grepContext: true, parallelToolCalls: true },
  }
  // Resolve saved API keys only after explicit live authorization and validation.
  const apiKey = await (async () => {
    if (options.mode === "offline") return undefined
    const env = process.env[config.provider === "openai" ? "OPENAI_API_KEY" : "AWS_BEARER_TOKEN_BEDROCK"]
    if (options.authSource === "env") return env
    const { Effect } = await import("effect")
    const { Auth } = await import("../src/auth")
    const auth = await Effect.runPromise(
      Effect.flatMap(Auth.Service, (service) => service.get(config.provider)).pipe(Effect.provide(Auth.defaultLayer)),
    )
    return auth?.type === "api" ? auth.key : options.authSource === "stored" ? undefined : env
  })()
  if (options.mode === "live" && !apiKey) throw new BenchError("api-key-required")
  const base = path.join(os.tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  const output = options.output
    ? path.resolve(options.output)
    : path.join(await mkdtemp(path.join(base, "parallel-tools-results-")), "results.jsonl")
  const file = await open(output, "wx", 0o600)
  const guard = budget(config.caps, config.prices)
  const runState = { stopReason: "" }
  const began = Date.now()
  const results: Awaited<ReturnType<typeof sample>>[] = []
  const deadline = began + config.caps.walltimeMs
  const plan = Array.from({ length: config.runs }, (_, trial) =>
    config.models.flatMap((_, modelIndex) => {
      const model = config.models[(trial + modelIndex) % config.models.length]
      return config.cases.flatMap((_, caseIndex) => {
        const id = config.cases[(trial + caseIndex) % config.cases.length]
        return (trial + modelIndex + caseIndex) % 2
          ? [
              { trial, model, id, arm: "candidate" as const },
              { trial, model, id, arm: "baseline" as const },
            ]
          : [
              { trial, model, id, arm: "baseline" as const },
              { trial, model, id, arm: "candidate" as const },
            ]
      })
    }),
  ).flat()
  const write = (value: unknown) => file.write(JSON.stringify(value) + "\n")
  try {
    await write({
      type: "manifest",
      version: 2,
      fixtureVersion: 1,
      mode: options.mode,
      ...config,
      sources,
      startedAt: new Date(began).toISOString(),
      arms: Object.fromEntries(
        Object.entries(arms).map(([name, arm]) => [
          name,
          {
            promptSha256: hash(arm.prompt),
            readMany: arm.readMany,
            grepContext: arm.grepContext ?? false,
            parallelToolCalls: arm.parallelToolCalls ?? null,
            ablation: arm.ablation ?? null,
          },
        ]),
      ),
      plan,
      isolation: {
        childNetwork: "macos-seatbelt-proxy-port-only",
        managedConfig: "scratch",
        managedPreferences: "denied",
        dependencyInstall: "local-provisioning-offline",
      },
      limitations: [
        "UTF-8 byte input bound and user-supplied price ceilings are estimates, not a billing guarantee",
        "No cache discounts, taxes, or provider-specific surcharges are assumed",
        "HTTP transport only; isolated cold CLI process per sample",
        "Offline responses are scripted and do not establish model quality",
      ],
    })
    for (const item of plan) {
      if (
        Date.now() >= deadline ||
        !!runState.stopReason ||
        guard.state.calls >= config.caps.calls ||
        (guard.state.reservedUsd >= config.caps.usd && options.mode === "live")
      )
        break
      const result = await sample(item)
      results.push(result)
      await write({ type: "sample", ...result })
      if (runState.stopReason) break
    }
    await write({
      type: "summary",
      samples: results.length,
      plannedSamples: plan.length,
      correct: results.filter((result) => result.correct).length,
      matchedPairs: results.filter(
        (result) =>
          result.arm === "baseline" &&
          results.some(
            (other) =>
              other.arm === "candidate" &&
              other.model === result.model &&
              other.fixture === result.fixture &&
              other.trial === result.trial,
          ),
      ).length,
      ...guard.state,
      stopReason: runState.stopReason || null,
      durationMs: Date.now() - began,
      complete: results.length === plan.length,
    })
  } finally {
    await file.close()
  }
  return { output, results, complete: results.length === plan.length }

  async function sample(item: (typeof plan)[number]) {
    const task = fixture(item.id, item.trial)
    const arm = arms[item.arm]
    const scratch = await realpath(await mkdtemp(path.join(base, "parallel-tools-fixture-")))
    const directory = path.join(scratch, "repo")
    const home = path.join(scratch, "home")
    const started = Date.now()
    const requests: Request[] = []
    const state = { stopReason: "", blockedRequests: 0, malformedEvents: 0, toolSchemaSha256: "" }
    const controller = new AbortController()
    const actions = script(task, arm, directory)
    const selectedModel = config.provider === "amazon-bedrock" ? `us.openai.${item.model}` : item.model
    const key = randomUUID()
    let child: ReturnType<typeof Bun.spawn> | undefined
    const stop = (reason: string) => {
      state.stopReason ||= reason
      runState.stopReason ||= reason
      controller.abort()
      child?.kill("SIGKILL")
    }
    const timer = setTimeout(
      () => stop(Date.now() >= deadline ? "walltime-cap" : "sample-timeout"),
      Math.max(1, Math.min(config.caps.sampleMs, deadline - Date.now())),
    )
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: config.caps.inputTokens,
      async fetch(req) {
        try {
          if (
            req.headers.get("authorization") !== `Bearer ${key}` ||
            new URL(req.url).pathname !== "/v1/responses" ||
            req.method !== "POST"
          )
            throw new BenchError("unexpected-request")
          if (controller.signal.aborted || runState.stopReason || Date.now() >= deadline)
            throw new BenchError(runState.stopReason || "walltime-cap")
          const body = record(rewritePrompt(parse(await req.text()), builtin, arm.prompt))
          if (controller.signal.aborted || runState.stopReason)
            throw new BenchError(runState.stopReason || "sample-stopped")
          if (body.model !== selectedModel || body.stream !== true)
            throw new BenchError("request-model-or-stream-mismatch")
          const tools = Array.isArray(body.tools) ? body.tools.map(record) : []
          const allowed = [
            "read",
            "grep",
            "glob",
            ...(arm.readMany ? ["read_many"] : []),
            ...(task.finalFiles ? ["apply_patch"] : []),
          ]
          // ReadMany shares read permission in the app. Advertise the arm's exact
          // safe tool set rather than relying on a separate permission name.
          body.tools = tools
            .filter((tool) => tool.type === "function" && allowed.includes(String(tool.name)))
            .map((tool) => {
              if (arm.grepContext || tool.name !== "grep") return tool
              const parameters = record(tool.parameters)
              return {
                ...tool,
                parameters: {
                  ...parameters,
                  properties: Object.fromEntries(
                    Object.entries(record(parameters.properties)).filter(([name]) => name !== "context"),
                  ),
                  ...(Array.isArray(parameters.required)
                    ? { required: parameters.required.filter((name) => name !== "context") }
                    : {}),
                },
              }
            })
          state.toolSchemaSha256 ||= hash(JSON.stringify(body.tools))
          if (
            arm.readMany &&
            !tools.some((tool) => tool.name === "read_many" && record(record(tool.parameters).properties).files)
          )
            throw new BenchError("read-many-schema-unavailable")
          if (
            arm.grepContext &&
            !tools.some((tool) => tool.name === "grep" && record(record(tool.parameters).properties).context)
          )
            throw new BenchError("grep-context-schema-unavailable")
          if (
            body.service_tier !== config.tier ||
            record(body.reasoning).effort !== config.effort ||
            (arm.parallelToolCalls !== undefined && body.parallel_tool_calls !== arm.parallelToolCalls)
          )
            throw new BenchError("request-options-mismatch")
          // The proxy is also the last-line cap for SDK retries and auxiliary calls.
          body.max_output_tokens = config.caps.outputTokens
          body.service_tier = config.tier
          body.reasoning = { ...record(body.reasoning), effort: config.effort }
          body.store = false
          const payload = JSON.stringify(body)
          const request: Request = {
            turn: requests.length,
            reservedUsd: guard.reserve(Buffer.byteLength(payload), requests.length),
            inputTokenEstimateCeiling: Buffer.byteLength(payload) + 1024,
            parallelToolCalls: typeof body.parallel_tool_calls === "boolean" ? body.parallel_tool_calls : undefined,
            appRequestedTier: identifier(body.service_tier),
            appRequestedEffort: identifier(record(body.reasoning).effort),
            completed: false,
            calls: [],
          }
          requests.push(request)
          const upstream =
            options.mode === "offline"
              ? await (options.offlineResponse?.({
                  turn: request.turn,
                  response: response(
                    actions[request.turn] ?? [],
                    selectedModel,
                    config.tier,
                    request.turn,
                    task.expected,
                  ),
                }) ?? response(actions[request.turn] ?? [], selectedModel, config.tier, request.turn, task.expected))
              : await fetch(
                  config.provider === "openai"
                    ? "https://api.openai.com/v1/responses"
                    : "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses",
                  {
                    method: "POST",
                    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
                    body: payload,
                    signal: controller.signal,
                    redirect: "error",
                  },
                )
          if (!upstream.ok || !upstream.body) throw new BenchError(`provider-http-${upstream.status}`)
          const accept = sse((event) => {
            const result = record(event.response)
            request.servedModel = identifier(result.model) ?? request.servedModel
            request.servedTier = identifier(result.service_tier) ?? request.servedTier
            if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
              const output = record(event.item)
              if (output.type === "function_call" && typeof output.call_id === "string") {
                const existing = request.calls.find((call) => call.id === output.call_id)
                const call: Request["calls"][number] = existing ?? {
                  id: output.call_id,
                  tool: String(output.name ?? "unknown"),
                  advertised: allowed.includes(String(output.name)) && tools.some((tool) => tool.name === output.name),
                  emittedMs: Date.now() - started,
                }
                if (!existing) request.calls.push(call)
                if (event.type === "response.output_item.done") call.readyMs = Date.now() - started
              }
            }
            if (["response.completed", "response.incomplete", "response.failed"].includes(String(event.type))) {
              const usage = record(result.usage)
              request.completed = event.type === "response.completed"
              request.inputTokens = number(usage.input_tokens)
              request.outputTokens = number(usage.output_tokens)
              request.cachedTokens = number(record(usage.input_tokens_details).cached_tokens)
              request.reasoningTokens = number(record(usage.output_tokens_details).reasoning_tokens)
              request.finishedMs = Date.now() - started
              if (!request.completed) stop("provider-incomplete")
              if (
                (request.outputTokens ?? 0) > config.caps.outputTokens ||
                (request.inputTokens ?? 0) > request.inputTokenEstimateCeiling
              )
                stop("provider-token-cap-violation")
            }
            if (event.type === "error") stop("provider-stream-error")
          })
          const decoder = new TextDecoder()
          let bytes = 0
          return new Response(
            relay(upstream.body, {
              chunk(chunk) {
                bytes += chunk.byteLength
                if (bytes > 2_000_000) {
                  stop("response-byte-cap")
                  throw new BenchError("response-byte-cap")
                }
                request.firstByteMs ??= Date.now() - started
                try {
                  accept(decoder.decode(chunk, { stream: true }))
                } catch {
                  stop("provider-stream-parse")
                  throw new BenchError("provider-stream-parse")
                }
              },
              finish() {
                try {
                  accept(decoder.decode())
                } catch {
                  stop("provider-stream-parse")
                }
                if (!request.completed && !state.stopReason) stop("missing-terminal-event")
              },
              stop(reason) {
                if (reason === "client-disconnected" && request.completed) return
                stop(reason)
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        } catch (error) {
          state.blockedRequests++
          stop(error instanceof BenchError ? error.code : "provider-transport-error")
          return Response.json({ error: { message: "Benchmark stopped by its safety guard" } }, { status: 400 })
        }
      },
      error() {
        stop("proxy-error")
        return Response.json({ error: { message: "Benchmark proxy failed" } }, { status: 500 })
      },
    })
    try {
      await Promise.all([mkdir(directory), mkdir(home)])
      const configDirectory = path.join(home, "config", "opencode")
      const localPlugin = path.resolve(import.meta.dir, "../../plugin")
      const dependencies = { "@opencode-ai/plugin": `file:${localPlugin}` }
      await Promise.all([
        mkdir(path.join(configDirectory, "node_modules", "@opencode-ai"), { recursive: true }),
        mkdir(path.join(scratch, "managed")),
      ])
      await symlink(localPlugin, path.join(configDirectory, "node_modules", "@opencode-ai", "plugin"))
      await Promise.all([
        Bun.write(path.join(configDirectory, "package.json"), JSON.stringify({ private: true, dependencies })),
        Bun.write(
          path.join(configDirectory, "package-lock.json"),
          JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies } } }),
        ),
      ])
      await Promise.all(
        Object.entries(task.files).map(async ([name, text]) => {
          await mkdir(path.dirname(path.join(directory, name)), { recursive: true })
          await Bun.write(path.join(directory, name), text)
        }),
      )
      const instructions =
        "Use only the requested synthetic fixture files. Do not use the network, shell, external paths, subagents, or change AGENTS.md.\n"
      await Bun.write(path.join(directory, "AGENTS.md"), instructions)
      if (Bun.spawnSync(["git", "init", "--quiet"], { cwd: directory }).exitCode)
        throw new BenchError("fixture-git-init")
      const permission = {
        "*": "deny",
        read: "allow",
        grep: "allow",
        glob: "allow",
        read_many: arm.readMany ? "allow" : "deny",
        edit: task.finalFiles ? { "*": "deny", "counter.json": "allow" } : "deny",
        external_directory: "deny",
      }
      if (controller.signal.aborted) throw new BenchError("sample-timeout")
      child = Bun.spawn(
        sandboxCommand(
          [
            process.execPath,
            "run",
            "--conditions=browser",
            path.resolve(import.meta.dir, "../src/index.ts"),
            "run",
            "--print-logs",
            "--format",
            "json",
            "--title",
            "Synthetic parallel tool benchmark",
            "--model",
            `openai/${selectedModel}`,
            task.prompt,
          ],
          server.port,
        ),
        {
          cwd: directory,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            PATH: process.env.PATH,
            HOME: home,
            TMPDIR: scratch,
            PWD: directory,
            OPENCODE_TEST_HOME: home,
            OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(scratch, "managed"),
            XDG_CONFIG_HOME: path.join(home, "config"),
            XDG_DATA_HOME: path.join(home, "data"),
            XDG_STATE_HOME: path.join(home, "state"),
            XDG_CACHE_HOME: path.join(home, "cache"),
            OPENCODE_AUTH_CONTENT: "{}",
            OPENCODE_PURE: "1",
            OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
            OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
            OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
            OPENCODE_DISABLE_PROJECT_CONFIG: "1",
            OPENCODE_DISABLE_AUTOUPDATE: "1",
            OPENCODE_DISABLE_MODELS_FETCH: "1",
            OPENCODE_DISABLE_AUTOCOMPACT: "1",
            OPENCODE_DISABLE_CLAUDE_CODE: "1",
            OPENCODE_EXPERIMENTAL_NATIVE_LLM: config.runtime === "native" ? "1" : "0",
            OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(config.caps.outputTokens),
            npm_config_offline: "true",
            npm_config_registry: "http://127.0.0.1:9",
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              enabled_providers: ["openai"],
              plugin: [],
              mcp: {},
              formatter: false,
              lsp: false,
              share: "disabled",
              permission,
              agent: {
                build: {
                  steps: config.caps.callsPerSample,
                  permission,
                  options: { parallelToolCalls: arm.parallelToolCalls },
                },
              },
              provider: {
                openai: {
                  npm: "@ai-sdk/openai",
                  options: {
                    apiKey: key,
                    baseURL: `http://127.0.0.1:${server.port}/v1`,
                    transport: "http",
                    responsesContinuation: false,
                    contextWarming: false,
                  },
                  models: {
                    [selectedModel]: {
                      name: item.model,
                      id: selectedModel,
                      limit: { context: 200000, output: config.caps.outputTokens },
                      options: {
                        serviceTier: config.tier,
                        reasoningEffort: config.effort,
                        contextWarming: false,
                        responsesContinuation: false,
                        transport: "http",
                      },
                    },
                  },
                },
              },
            }),
          },
        },
      )
      const collect = async (stream: ReadableStream<Uint8Array>, stderr = false) => {
        const chunks: Uint8Array[] = []
        let size = 0
        let suffix = ""
        const reader = stream.getReader()
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > 4_000_000) {
            stop("cli-output-byte-cap")
            await reader.cancel()
            break
          }
          chunks.push(chunk.value)
          if (stderr) {
            const text = suffix + Buffer.from(chunk.value).toString("utf8")
            if (text.includes("reading macOS managed preferences")) stop("managed-preferences-detected")
            suffix = text.slice(-100)
          }
        }
        return Buffer.concat(chunks).toString("utf8")
      }
      const [stdout, stderr, exitCode] = await Promise.all([
        collect(child.stdout as ReadableStream<Uint8Array>),
        collect(child.stderr as ReadableStream<Uint8Array>, true),
        child.exited,
      ])
      const events = stdout
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          const event = parse(line)
          if (!event || typeof event !== "object") {
            state.malformedEvents++
            return []
          }
          return [record(event)]
        })
      const calls = callsFromEvents(events, task, directory, requests, started)
      const files = Object.fromEntries(
        await Promise.all(
          Object.keys(task.files).map(async (name) => [
            name,
            await Bun.file(path.join(directory, name))
              .text()
              .catch(() => ""),
          ]),
        ),
      )
      const answers = events
        .filter((event) => event.type === "text")
        .map((event) => ({
          text: String(record(event.part).text ?? ""),
          ms: (number(event.timestamp) ?? started) - started,
        }))
      const telemetry = toolTelemetry(calls, stderr, requests, config.runtime)
      if (!telemetry.runtime.matched && !state.stopReason) stop("runtime-unverified-or-mismatched")
      const modelMatches = (served?: string) =>
        !!served &&
        new RegExp(`^${item.model.replaceAll(".", "\\.")}(?:-\\d{4}-\\d{2}-\\d{2})?$`).test(
          served.replace(/^(?:(?:us|global)\.)?openai\./, ""),
        )
      const tiersMatch = requests.every(
        (request) =>
          request.servedTier === config.tier || (config.tier === "priority" && request.servedTier === "fast"),
      )
      const routingMatched =
        !!requests.length && requests.every((request) => modelMatches(request.servedModel)) && tiersMatch
      const result = score(task, {
        calls,
        answers,
        files,
        completed:
          !state.stopReason &&
          exitCode === 0 &&
          state.malformedEvents === 0 &&
          !events.some((event) => event.type === "error") &&
          requests.every((request) => request.completed) &&
          calls.every((call) => call.turn >= 0) &&
          routingMatched,
      })
      const instructionsUnchanged =
        (await Bun.file(path.join(directory, "AGENTS.md"))
          .text()
          .catch(() => "")) === instructions
      return {
        fixture: item.id,
        trial: item.trial,
        model: item.model,
        arm: item.arm,
        requestedModel: selectedModel,
        requestedTier: config.tier,
        ablation: arm.ablation ?? null,
        ...result,
        correct: result.correct && instructionsUnchanged,
        protectedFilesUnchanged: result.protectedFilesUnchanged && instructionsUnchanged,
        durationMs: Date.now() - started,
        modelTurns: requests.length,
        routingMatched,
        stopReason: state.stopReason || null,
        exitCode,
        blockedRequests: state.blockedRequests,
        malformedEvents: state.malformedEvents,
        requests: requests.map(({ calls, ...request }) => ({ ...request, toolCalls: calls.length })),
        usageEstimatedUsd:
          requests.length > 0 &&
          requests.every((request) => request.inputTokens !== undefined && request.outputTokens !== undefined)
            ? requests.reduce(
                (total, request) =>
                  total +
                  ((request.inputTokens ?? 0) * config.prices.input +
                    (request.outputTokens ?? 0) * config.prices.output) /
                    1_000_000,
                0,
              )
            : null,
        unknowns: [
          ...(telemetry.unknownInvocationToolCalls ? ["tool-invocation"] : []),
          ...(!telemetry.runtime.observed.length ? ["runtime"] : []),
          ...(!requests.length ||
          requests.some((request) => request.inputTokens === undefined || request.outputTokens === undefined)
            ? ["usage"]
            : []),
          ...(!requests.length || requests.some((request) => !request.servedModel) ? ["served-model"] : []),
          ...(!requests.length || requests.some((request) => !request.servedTier) ? ["served-tier"] : []),
          "provider-billing-extras",
        ],
        ...telemetry,
        toolSchemaSha256: state.toolSchemaSha256 || null,
      }
    } finally {
      clearTimeout(timer)
      controller.abort()
      child?.kill("SIGKILL")
      await server.stop(true)
      await rm(scratch, { recursive: true, force: true })
    }
  }
}

if (import.meta.main) {
  const main = async () => {
    const { values } = parseArgs({
      options: {
        mode: { type: "string", default: "offline" },
        output: { type: "string" },
        arms: { type: "string" },
        only: { type: "string" },
      },
    })
    const arms = values.arms ? record(await Bun.file(values.arms).json()) : undefined
    if (values.mode === "live" && !record(arms?.baseline).prompt && !record(arms?.baseline).promptFile)
      throw new BenchError("live-baseline-snapshot-required")
    const loadArm = async (value: unknown): Promise<Arm> => {
      const arm = record(value)
      if (
        Object.keys(arm).some(
          (key) => !["prompt", "promptFile", "readMany", "grepContext", "parallelToolCalls", "ablation"].includes(key),
        ) ||
        (arm.readMany !== undefined && typeof arm.readMany !== "boolean") ||
        (arm.grepContext !== undefined && typeof arm.grepContext !== "boolean") ||
        (arm.parallelToolCalls !== undefined && typeof arm.parallelToolCalls !== "boolean") ||
        (arm.ablation !== undefined && arm.ablation !== "serial")
      )
        throw new BenchError("invalid-arm")
      const text =
        typeof arm.prompt === "string"
          ? arm.prompt
          : typeof arm.promptFile === "string"
            ? await Bun.file(arm.promptFile).text()
            : await Bun.file(path.join(import.meta.dir, "../src/session/prompt/gpt.txt")).text()
      return {
        prompt: text,
        readMany: arm.readMany === true,
        grepContext: arm.grepContext === true,
        ...(arm.ablation === "serial" ? { ablation: "serial" as const } : {}),
        ...(typeof arm.parallelToolCalls === "boolean" ? { parallelToolCalls: arm.parallelToolCalls } : {}),
      }
    }
    const env = (name: string) => process.env[`BENCH_${name}`]
    const caps = Object.fromEntries(
      [
        ["calls", env("MAX_CALLS")],
        ["callsPerSample", env("MAX_CALLS_PER_SAMPLE")],
        ["outputTokens", env("OUTPUT_TOKENS")],
        ["inputTokens", env("INPUT_TOKENS")],
        ["walltimeMs", env("WALLTIME_MS")],
        ["sampleMs", env("SAMPLE_MS")],
        ["usd", env("MAX_USD")],
      ]
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => [name, Number(value)]),
    )
    const result = await run({
      mode: values.mode as Options["mode"],
      allowLive: env("ALLOW_LIVE") === "1",
      output: values.output,
      models: env("MODELS")?.split(",") as Model[] | undefined,
      only: values.only?.split(",") as FixtureID[] | undefined,
      provider: env("PROVIDER") as Options["provider"],
      runtime: env("RUNTIME") as Options["runtime"],
      tier: env("TIER") as Options["tier"],
      effort: env("EFFORT") as Options["effort"],
      authSource: env("AUTH_SOURCE") as Options["authSource"],
      runs: env("RUNS") === undefined ? undefined : Number(env("RUNS")),
      caps,
      prices:
        env("INPUT_USD_PER_MILLION") !== undefined && env("OUTPUT_USD_PER_MILLION") !== undefined
          ? { input: Number(env("INPUT_USD_PER_MILLION")), output: Number(env("OUTPUT_USD_PER_MILLION")) }
          : undefined,
      arms: arms ? { baseline: await loadArm(arms.baseline), candidate: await loadArm(arms.candidate) } : undefined,
    })
    console.log(
      JSON.stringify({
        samples: result.results.length,
        correct: result.results.filter((sample) => sample.correct).length,
        complete: result.complete,
        outputFile: path.basename(result.output),
      }),
    )
    process.exitCode = result.complete && result.results.every((sample) => sample.correct) ? 0 : 1
  }
  await main().catch((error: unknown) => {
    // SDK and filesystem errors may contain credentials, prompts, and private paths.
    console.error(error instanceof BenchError ? error.code : "parallel-tool-benchmark-failed")
    process.exitCode = 1
  })
}
