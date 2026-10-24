import * as Log from "@opencode-ai/core/util/log"
import * as TimingStore from "./timing-store"

const log = Log.create({ service: "session.timing" })

export type Metadata = {
  providerID?: string
  modelID?: string
  resolvedModelID?: string
  variant?: string
  requestedTier?: string
  returnedTier?: string
  runtime?: string
  purpose?: "assistant" | "reviewer" | "steering" | "auxiliary" | "shell" | "subtask" | "compaction"
}

export type Record = Metadata & {
  executionID: string
  sessionID: string
  stepID: string
  requestID?: string
  phase:
    | "execution_start"
    | "preparation"
    | "request_start"
    | "request_prepared"
    | "dispatch"
    | "first_useful"
    | "first_text"
    | "first_reasoning"
    | "tool_input_start"
    | "tool_ready"
    | "tool_start"
    | "tool"
    | "approval_start"
    | "approval"
    | "command_start"
    | "command_first_output"
    | "command"
    | "request"
    | "overall"
  elapsedMs: number
  durationMs?: number
  callID?: string
  tool?: string
  kind?: string
  status?: string
  reason?: string
  approvalID?: string
  commandID?: string
  exitCode?: number | null
  attemptScope?: "logical" | "request" | "wire"
  anchor?: "request_start" | "dispatch"
}

// Wall-clock timestamps remain in persisted parts. These process-local durations
// must never be reconstructed from those timestamps (or copied session history).
// Existing completion phases retain their meanings; *_start records are markers
// without durations, so an unfinished span still has evidence in storage.
export function start(
  input: { sessionID: string; messageID: string } & Metadata,
  options: { now?: () => number; emit?: (record: Record) => void; enabled?: boolean } = {},
) {
  type Span = {
    start: number
    context: Pick<Record, "requestID" | "callID" | "tool" | "approvalID" | "commandID">
  }
  type Tool = {
    context: Span["context"]
    input?: number
    ready?: boolean
    start?: number
    ended?: boolean
  }
  const clock = options.now ?? (() => performance.now())
  const started = clock()
  let latest = started
  const now = () => (latest = Math.max(latest, clock()))
  const executionID = crypto.randomUUID()
  const emit =
    options.emit ??
    ((timing: Record) => {
      safely(() => log.info("phase", { timing }))
      safely(() => TimingStore.write(timing))
    })
  const metadata: Metadata = {}
  const tools = new Map<string, Tool>()
  const approvals = new Map<string, Span>()
  const commands = new Map<string, Span & { output?: boolean }>()
  let prepared = false
  let finished = false
  let attempt = 0
  let approval = 0
  let command = 0
  let request:
    | {
        id: string
        start: number
        prepared?: boolean
        dispatched?: number
        first_useful?: boolean
        first_text?: boolean
        first_reasoning?: boolean
        outcome?: "completed" | "error" | "interrupted" | "incomplete" | "truncated"
      }
    | undefined
  const updateMetadata = (input: Metadata) => {
    if (finished) return
    for (const key of [
      "providerID",
      "modelID",
      "resolvedModelID",
      "variant",
      "requestedTier",
      "returnedTier",
      "runtime",
    ] as const) {
      if (typeof input[key] === "string") metadata[key] = input[key]
      if (input[key] === undefined && Object.hasOwn(input, key)) delete metadata[key]
    }
    if (typeof input.purpose === "string") metadata.purpose = input.purpose
    if (input.purpose === undefined && Object.hasOwn(input, "purpose")) delete metadata.purpose
  }
  const record = (phase: Record["phase"], start?: number, extra: Partial<Record> = {}, end = now()) => {
    if (options.enabled === false) return
    safely(() =>
      emit({
        executionID,
        sessionID: input.sessionID,
        stepID: input.messageID,
        requestID: request?.id,
        phase,
        elapsedMs: end - started,
        ...(start === undefined ? {} : { durationMs: Math.max(0, end - start) }),
        ...metadata,
        ...extra,
      }),
    )
  }
  const first = (phase: "first_useful" | "first_text" | "first_reasoning", kind?: "text" | "tool") => {
    if (!request || request[phase] || finished) return
    request[phase] = true
    record(phase, request.dispatched ?? request.start, {
      kind,
      attemptScope: "logical",
      anchor: request.dispatched === undefined ? "request_start" : "dispatch",
    })
  }
  const toolState = (callID: string, tool: string) => {
    const existing = tools.get(callID)
    if (existing) return existing
    const state: Tool = { context: { callID, tool, requestID: request?.id } }
    tools.set(callID, state)
    return state
  }
  updateMetadata(input)
  record("execution_start", undefined, {}, started)
  return {
    executionID,
    // Only the selected/served identifiers above are retained, never provider payloads.
    metadata: updateMetadata,
    prepared() {
      if (prepared || finished) return
      prepared = true
      record("preparation", started)
    },
    request() {
      if (finished) return
      const time = now()
      if (request) record("request", request.start, { status: "retry" }, time)
      // Keep served metadata on the closing request, never on its next attempt.
      updateMetadata({ returnedTier: undefined, resolvedModelID: undefined, runtime: undefined })
      request = { id: `${input.messageID}:${++attempt}`, start: time }
      record("request_start", undefined, {}, time)
      return request.id
    },
    // Request assembly is not evidence that anything has reached the transport.
    requestPrepared() {
      if (!request || request.prepared || finished) return
      request.prepared = true
      record("request_prepared", request.start)
    },
    requestOutcome(status: "completed" | "error" | "interrupted" | "incomplete" | "truncated") {
      if (!request || finished) return
      request.outcome = status
    },
    // Call only at an observed wire dispatch, not when preparing a stream.
    dispatched() {
      if (!request || request.dispatched !== undefined || finished) return
      request.dispatched = now()
      record("dispatch", request.start, {}, request.dispatched)
    },
    firstUseful(kind: "text" | "tool") {
      first("first_useful", kind)
    },
    // First nonempty text/reasoning observations are independent per logical request.
    // Their named anchor is explicit; a logical latency is not network TTFT.
    firstText() {
      first("first_text")
    },
    firstReasoning() {
      first("first_reasoning")
    },
    // Observe streamed input and complete arguments, separately from tool execution.
    toolInputStart(callID: string, tool: string) {
      if (finished) return
      const state = toolState(callID, tool)
      if (state.input !== undefined || state.ready) return
      state.input = now()
      record("tool_input_start", undefined, state.context, state.input)
    },
    toolReady(callID: string, tool: string) {
      if (finished) return
      const state = toolState(callID, tool)
      if (state.ready) return
      state.ready = true
      // A non-streamed call has no observed input duration.
      record("tool_ready", state.input, state.context)
    },
    toolStart(callID: string, tool: string) {
      if (finished) return
      const state = toolState(callID, tool)
      if (state.start !== undefined || state.ended) return
      state.start = now()
      record("tool_start", undefined, state.context, state.start)
    },
    toolEnd(callID: string, status: string) {
      const state = tools.get(callID)
      if (state?.start === undefined || state.ended || finished) return
      state.ended = true
      record("tool", state.start, { ...state.context, status })
    },
    // Tokens distinguish concurrent or repeated approval prompts for the same call.
    permissionStart(callID: string) {
      if (finished) return
      const approvalID = `${executionID}:approval:${++approval}`
      const span = {
        start: now(),
        context: { callID, requestID: request?.id, ...tools.get(callID)?.context, approvalID },
      }
      approvals.set(approvalID, span)
      record("approval_start", undefined, span.context, span.start)
      return approvalID
    },
    permissionEnd(token: string | undefined, status = "completed") {
      if (token === undefined || finished) return
      const span = approvals.get(token)
      if (!span) return
      approvals.delete(token)
      record("approval", span.start, { ...span.context, status })
    },
    // One handle per subprocess attempt. Start immediately before spawning and
    // report only actual output; ending an empty command never invents output.
    command(callID: string) {
      const commandID = `${executionID}:command:${++command}`
      let pending = true
      return {
        start() {
          if (!pending || finished) return
          pending = false
          const span = {
            start: now(),
            context: { callID, requestID: request?.id, ...tools.get(callID)?.context, commandID },
          }
          commands.set(commandID, span)
          record("command_start", undefined, span.context, span.start)
        },
        firstOutput() {
          const span = commands.get(commandID)
          if (!span || span.output || finished) return
          span.output = true
          record("command_first_output", span.start, span.context)
        },
        // "running": the call stopped waiting while the command kept going (moved to the background).
        end(result: {
          exitCode?: number | null
          status: "completed" | "error" | "interrupted" | "timeout" | "running"
        }) {
          if (finished) return
          pending = false
          const span = commands.get(commandID)
          if (!span) return
          commands.delete(commandID)
          record("command", span.start, { ...span.context, status: result.status, exitCode: result.exitCode })
        },
      }
    },
    finish(status: string) {
      if (finished) return
      finished = true
      const outcome = status === "completed" ? (request?.outcome ?? status) : status
      const time = now()
      for (const span of approvals.values()) {
        record("approval", span.start, { ...span.context, status: "interrupted" }, time)
      }
      approvals.clear()
      for (const span of commands.values()) {
        record("command", span.start, { ...span.context, status: "interrupted" }, time)
      }
      commands.clear()
      for (const state of tools.values()) {
        if (state.start === undefined || state.ended) continue
        record("tool", state.start, { ...state.context, status: "interrupted" }, time)
      }
      tools.clear()
      if (request) record("request", request.start, { status: outcome }, time)
      record("overall", started, { status: outcome }, time)
      if (options.enabled !== false && !options.emit) safely(() => TimingStore.flush())
    },
  }
}

// Logging and storage failures must never change the task's execution outcome.
function safely(run: () => void) {
  try {
    run()
  } catch {}
}

export type Handle = ReturnType<typeof start>
export * as SessionTiming from "./timing"
