import { mkdir, realpath, rename, stat } from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"

const parse = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

// Incremental SSE framing; retain only the unfinished event, never the response body.
export function sse(accept: (event: Record<string, unknown>) => void) {
  let pending = ""
  return (text: string) => {
    pending += text
    if (pending.length > 4_000_000) throw new Error("SSE event too large")
    const frames = pending.split(/\r?\n\r?\n/)
    pending = frames.pop() ?? ""
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
      if (data && data !== "[DONE]") accept(record(parse(data)))
    }
  }
}

type RequestSample = {
  phase: "report" | "ack"
  startMs: number
  requestedModel: string
  requestedTier: string
  headersMs?: number
  firstByteMs?: number
  firstVisibleMs?: number
  firstTextMs?: number
  firstToolArgumentMs?: number
  firstReasoningMs?: number
  lastVisibleMs?: number
  completedMs?: number
  finishedMs?: number
  httpStatus?: number
  returnedModel?: string
  returnedTier?: string
  finishStatus?: string
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
  toolNames: string[]
  chunks: { ms: number; bytes: number }[]
}

async function main() {
  const model = process.env.BENCH_MODEL ?? "gpt-6-astra"
  if (model !== "gpt-6-astra" && model !== "gpt-6.1-sol")
    throw new Error("BENCH_MODEL must be gpt-6-astra or gpt-6.1-sol")
  const mantleRegion = model === "gpt-6.1-sol" ? "us-east-1" : "us-west-2"
  const runs = Number(process.env.BENCH_RUNS ?? 3)
  const tokens = Number(process.env.BENCH_OUTPUT_TOKENS ?? 3072)
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("BENCH_RUNS must be between 1 and 10")
  if (!Number.isInteger(tokens) || tokens < 256 || tokens > 8192)
    throw new Error("BENCH_OUTPUT_TOKENS must be between 256 and 8192")
  if (!process.env.BENCH_DIR || !process.env.BENCH_CONTEXT)
    throw new Error(
      "BENCH_DIR and BENCH_CONTEXT must name an existing temporary output directory and sanitized Markdown brief",
    )
  const directory = await realpath(process.env.BENCH_DIR)
  const context = await realpath(process.env.BENCH_CONTEXT)
  if (!(await stat(directory)).isDirectory() || !(await stat(context)).isFile())
    throw new Error("Invalid benchmark directory or brief")
  const brief = await Bun.file(context).text()
  if (!brief.trim()) throw new Error("BENCH_CONTEXT is empty")
  const executable = Bun.which("opencode") ?? ""
  if (!executable) throw new Error("Installed opencode executable not found on PATH")
  if (!Bun.which("rg")) throw new Error("Install rg on PATH before benchmarking to avoid a runtime download")
  const matrix = ["us-east-1", "us-west-2"]
    .flatMap((region) =>
      ["us", "global"].flatMap((prefix) =>
        (model === "gpt-6.1-sol" ? ["default"] : ["default", "ultrafast"]).map((tier) => ({
          name: `runtime-${region}-${prefix}-${tier}`,
          region,
          model: `${prefix}.openai.${model}`,
          tier,
          baseURL: `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`,
        })),
      ),
    )
    .concat([
      {
        name: `mantle-${mantleRegion}-default`,
        region: mantleRegion,
        model: `openai.${model}`,
        tier: "default",
        baseURL: `https://bedrock-mantle.${mantleRegion}.api.aws/openai/v1`,
      },
    ])
  const filter = process.env.BENCH_PATHS?.split(",").map((name) => name.trim())
  if (filter?.some((name) => !matrix.some((entry) => entry.name === name)))
    throw new Error(`BENCH_PATHS must select from: ${matrix.map((entry) => entry.name).join(",")}`)
  const paths = matrix.filter((entry) => !filter || filter.includes(entry.name))
  const output = path.join(directory, "results.json")
  for (const file of [
    output,
    `${output}.tmp`,
    ...paths.flatMap((entry) =>
      Array.from({ length: runs }, (_, index) => path.join(directory, `${entry.name}-${index + 1}`)),
    ),
  ]) {
    if (
      (await Bun.file(file).exists()) ||
      (await stat(file).then(
        () => true,
        () => false,
      ))
    )
      throw new Error("Benchmark output already exists; use a fresh BENCH_DIR")
  }
  const { Auth } = await import("../src/auth")
  const apiKey =
    process.env.AWS_BEARER_TOKEN_BEDROCK ??
    (await Effect.runPromise(
      Effect.flatMap(Auth.Service, (service) => service.get("amazon-bedrock")).pipe(Effect.provide(Auth.defaultLayer)),
    ).then((auth) => (auth?.type === "api" ? auth.key : undefined)))
  if (!apiKey) throw new Error("Configure a Bedrock API key before running this billable benchmark")
  const sections = [
    "Executive Summary",
    "Repository Structure",
    "Runtime and Request Flow",
    "Providers and Models",
    "Tools and Permissions",
    "Testing and Quality",
    "Risks and Recommendations",
  ]
  const prompt = `Using only the attached sanitized repository brief, write a 900-1100 word Markdown repository report. This is a brief-based report, not an independent repository audit. Use exactly these seven level-two headings, in this order: ${sections.join("; ")}. Distinguish documented facts from recommendations. Make exactly one apply_patch call with an Add File operation creating report.md in the current directory. Do not read, search, explore, execute commands, or touch any other file. Put the entire report in that patch, not in chat. After the tool successfully writes report.md, tool use is forbidden: respond with exactly REPORT_SAVED and nothing else. Do not acknowledge success before the tool result.`
  const startedAt = new Date().toISOString()

  async function measure(entry: (typeof matrix)[number], trial: number) {
    const dir = path.join(directory, `${entry.name}-${trial}`)
    const report = path.join(dir, "report.md")
    const errors: string[] = []
    const requests: RequestSample[] = []
    const callIDs = new Set<string>()
    const cli = {
      events: 0,
      stepFinishes: 0,
      toolSuccesses: 0,
      savedMs: undefined as number | undefined,
      text: "",
      stderrBytes: 0,
    }
    const token = crypto.randomUUID()
    let attempts = 0
    let start = performance.now()
    await mkdir(dir, { mode: 0o700 })
    await mkdir(path.join(dir, "tmp"))
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 240,
      maxRequestBodySize: 4_000_000,
      async fetch(request) {
        const received = performance.now()
        const url = new URL(request.url)
        const reject = (reason: string) => {
          errors.push(reason)
          return Response.json(
            { error: { message: "Benchmark request rejected", type: "invalid_request_error" } },
            { status: 400 },
          )
        }
        if (
          request.headers.get("authorization") !== `Bearer ${token}` ||
          request.method !== "POST" ||
          url.pathname !== "/openai/v1/responses" ||
          url.search
        )
          return reject("Proxy authorization, method, or route mismatch")
        attempts++
        if (attempts > 3 || requests.length >= 2 || errors.length)
          return reject("Unexpected extra request or retry blocked")
        const body = await request.text()
        const input = record(
          await Promise.resolve()
            .then(() => parse(body))
            .catch(() => undefined),
        )
        if (
          input.model !== entry.model ||
          input.service_tier !== entry.tier ||
          record(input.reasoning).effort !== "low" ||
          input.store !== false ||
          input.stream !== true ||
          input.max_output_tokens !== tokens
        )
          return reject("Posted model, tier, reasoning, storage, stream, or token cap mismatch")
        const tools = Array.isArray(input.tools) ? input.tools.map(record) : []
        if (tools.some((tool) => tool.type !== "function" || tool.name !== "apply_patch") || !tools.length)
          return reject("Unexpected tool inventory")
        const results = Array.isArray(input.input)
          ? input.input.map(record).filter((item) => item.type === "function_call_output")
          : []
        if (requests.length === 0 && results.length) return reject("Unexpected initial tool results")
        if (
          requests.length === 1 &&
          (requests[0].finishStatus !== "completed" ||
            !requests[0].finishedMs ||
            results.length !== 1 ||
            !callIDs.has(String(results[0].call_id)) ||
            !(await Bun.file(report).exists()))
        )
          return reject("Retry or acknowledgment without a successful report blocked")
        const sample: RequestSample = {
          phase: requests.length ? "ack" : "report",
          startMs: received - start,
          requestedModel: entry.model,
          requestedTier: entry.tier,
          toolNames: [],
          chunks: [],
        }
        if (requests.length >= 2 || errors.length) return reject("Concurrent extra request blocked")
        requests.push(sample)
        const elapsed = () => performance.now() - received
        const observe = sse((event) => {
          const now = elapsed()
          const type = event.type
          const item = record(event.item)
          if (type === "response.output_item.added" && item.type === "function_call") {
            sample.toolNames.push(typeof item.name === "string" ? item.name : "unknown")
            if (typeof item.call_id === "string") callIDs.add(item.call_id)
            if (sample.phase !== "report" || item.name !== "apply_patch" || sample.toolNames.length !== 1) {
              errors.push("Unexpected generated tool call")
              throw new Error("Unexpected tool call")
            }
          }
          if (type === "response.function_call_arguments.done") {
            const patch = record(parse(event.arguments)).patchText
            const operations =
              typeof patch === "string"
                ? patch.match(/^\*\*\* (?:Add File:|Update File:|Delete File:|Move to:).*$/gm)
                : []
            if (sample.phase !== "report" || operations?.length !== 1 || operations[0] !== "*** Add File: report.md") {
              errors.push("Patch must only create relative report.md")
              throw new Error("Unexpected patch target")
            }
          }
          if (typeof event.delta === "string" && event.delta.length) {
            if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta")
              sample.firstReasoningMs ??= now
            if (type === "response.output_text.delta" || type === "response.function_call_arguments.delta") {
              sample.firstVisibleMs ??= now
              sample.lastVisibleMs = now
              if (type === "response.output_text.delta") sample.firstTextMs ??= now
              if (type === "response.function_call_arguments.delta") sample.firstToolArgumentMs ??= now
            }
          }
          if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
            const response = record(event.response)
            const usage = record(response.usage)
            sample.completedMs = now
            sample.finishStatus = typeof response.status === "string" ? response.status : "unknown"
            sample.returnedModel = typeof response.model === "string" ? response.model : undefined
            sample.returnedTier = typeof response.service_tier === "string" ? response.service_tier : undefined
            sample.inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined
            sample.outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined
            const reasoning = record(usage.output_tokens_details).reasoning_tokens
            const cached = record(usage.input_tokens_details).cached_tokens
            sample.reasoningTokens = typeof reasoning === "number" ? reasoning : undefined
            sample.cachedInputTokens = typeof cached === "number" ? cached : undefined
            if (sample.finishStatus !== "completed" || sample.returnedTier !== entry.tier)
              errors.push("Upstream finish status or returned tier mismatch")
          }
          if (type === "error" || type === "response.error") errors.push("Upstream SSE error")
        })
        try {
          const response = await fetch(`${entry.baseURL}/responses`, {
            method: "POST",
            body,
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(180_000)]),
            redirect: "error",
          })
          sample.headersMs = elapsed()
          sample.httpStatus = response.status
          if (!response.ok) errors.push(`Upstream HTTP ${response.status}`)
          if (!response.body) return reject("Upstream body missing")
          const decoder = new TextDecoder()
          return new Response(
            response.body.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  const ms = elapsed()
                  sample.firstByteMs ??= ms
                  sample.chunks.push({ ms, bytes: chunk.byteLength })
                  if (response.ok) {
                    try {
                      observe(decoder.decode(chunk, { stream: true }))
                    } catch {
                      errors.push("Invalid upstream SSE")
                      sample.finishedMs = elapsed()
                      controller.error(new Error("Invalid benchmark stream"))
                      return
                    }
                  }
                  controller.enqueue(chunk)
                },
                flush() {
                  try {
                    if (response.ok) observe(decoder.decode())
                  } catch {
                    errors.push("Invalid final SSE")
                  }
                  sample.finishedMs = elapsed()
                },
              }),
            ),
            {
              status: response.status,
              headers: { "Content-Type": response.headers.get("content-type") ?? "text/event-stream" },
            },
          )
        } catch {
          sample.finishedMs = elapsed()
          return reject("Upstream transport failure or timeout")
        }
      },
      error() {
        errors.push("Proxy processing failure")
        return new Response("Benchmark proxy failure", { status: 400 })
      },
    })
    const options = {
      forceReasoning: true,
      reasoningEffort: "low",
      reasoningSummary: "auto",
      include: ["reasoning.encrypted_content"],
      store: false,
      serviceTier: entry.tier,
      parallelToolCalls: false,
    }
    const config = {
      model: `amazon-bedrock/${entry.model}`,
      default_agent: "report-bench",
      enabled_providers: ["amazon-bedrock"],
      snapshot: false,
      share: "disabled",
      autoupdate: false,
      plugin: [],
      mcp: {},
      formatter: false,
      lsp: false,
      compaction: { auto: false, prune: false },
      permission: {
        "*": "deny",
        edit: { [path.relative("/", report)]: "allow", [report]: "allow", "report.md": "allow" },
        external_directory: { [`${dir}/*`]: "allow" },
      },
      agent: {
        title: { disable: true },
        summary: { disable: true },
        compaction: { disable: true },
        "report-bench": { mode: "primary", prompt, options, mcpServers: [], skills: [] },
      },
      provider: {
        "amazon-bedrock": {
          npm: "@ai-sdk/openai",
          env: [],
          whitelist: [entry.model],
          options: {
            apiKey: token,
            baseURL: `${server.url}openai/v1`,
            region: entry.region,
            timeout: 180_000,
            responsesContinuation: false,
          },
          models: {
            [entry.model]: {
              id: entry.model,
              name: entry.model,
              reasoning: true,
              temperature: false,
              tool_call: true,
              limit: { context: 128_000, output: tokens },
              modalities: { input: ["text"], output: ["text"] },
              options,
              variants: { low: { reasoningEffort: "low" } },
            },
          },
        },
      },
    }
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PWD: dir,
      TMPDIR: path.join(dir, "tmp"),
      OPENCODE_TEST_HOME: dir,
      OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(dir, "managed"),
      OPENCODE_AUTH_CONTENT: "{}",
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_DATA_HOME: path.join(dir, "data"),
      XDG_STATE_HOME: path.join(dir, "state"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
      OPENCODE_DB: path.join(dir, "session.db"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_MODELS_PATH: process.env.OPENCODE_MODELS_PATH,
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_DISABLE_CLAUDE_CODE: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
      OPENCODE_DISABLE_AUTOCOMPACT: "true",
      OPENCODE_DISABLE_PRUNE: "true",
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
      OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(tokens),
      npm_config_offline: "true",
      npm_config_audit: "false",
      npm_config_cache: path.join(dir, "npm-cache"),
      npm_config_userconfig: path.join(dir, "user.npmrc"),
      npm_config_globalconfig: path.join(dir, "global.npmrc"),
    }
    let exitCode: number | undefined
    start = performance.now()
    try {
      const child = Bun.spawn(
        [
          executable,
          "run",
          "--pure",
          "--format",
          "json",
          "--agent",
          "report-bench",
          "--model",
          `amazon-bedrock/${entry.model}`,
          "--variant",
          "low",
          "--title",
          "Repository report benchmark",
          "--file",
          context,
          "--",
          prompt,
        ],
        { cwd: dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      )
      const timeout = setTimeout(() => {
        errors.push("CLI timeout")
        child.kill("SIGKILL")
      }, 420_000)
      try {
        await Promise.all([
          (async () => {
            let pending = ""
            const decoder = new TextDecoder()
            const line = (text: string) => {
              if (!text.trim()) return
              try {
                const event = record(parse(text))
                cli.events++
                const part = record(event.part)
                if (event.type === "error") errors.push("CLI JSON error event")
                if (event.type === "step_finish") cli.stepFinishes++
                if (event.type === "text" && typeof part.text === "string") cli.text += part.text
                if (event.type === "tool_use") {
                  if (part.tool !== "apply_patch" || record(part.state).status !== "completed")
                    errors.push("CLI tool failure or unexpected tool")
                  else {
                    cli.toolSuccesses++
                    cli.savedMs = performance.now() - start
                  }
                }
              } catch {
                errors.push("Invalid CLI JSON output")
              }
            }
            await child.stdout.pipeTo(
              new WritableStream<Uint8Array>({
                write(chunk) {
                  pending += decoder.decode(chunk, { stream: true })
                  const lines = pending.split("\n")
                  pending = lines.pop() ?? ""
                  lines.forEach(line)
                },
                close() {
                  line(pending + decoder.decode())
                },
              }),
            )
          })(),
          child.stderr.pipeTo(
            new WritableStream<Uint8Array>({
              write(chunk) {
                cli.stderrBytes += chunk.byteLength
              },
            }),
          ),
          child.exited.then((code) => {
            exitCode = code
          }),
        ])
      } finally {
        clearTimeout(timeout)
        if (child.exitCode === null) {
          child.kill("SIGKILL")
          await child.exited
        }
      }
    } catch {
      errors.push("CLI launch or output failure")
    } finally {
      await server.stop(true)
    }
    const wallMs = performance.now() - start
    const markdown = await Bun.file(report)
      .text()
      .catch(() => "")
    const words = markdown.match(/\S+/g)?.length ?? 0
    if (exitCode !== 0) errors.push("CLI exited unsuccessfully")
    if (cli.toolSuccesses !== 1 || cli.text.trim() !== "REPORT_SAVED" || cli.stepFinishes !== 2)
      errors.push("Expected one successful patch, two finished steps, and exact REPORT_SAVED")
    if (
      words < 700 ||
      JSON.stringify(markdown.split(/\r?\n/).filter((line) => line.startsWith("## "))) !==
        JSON.stringify(sections.map((section) => `## ${section}`))
    )
      errors.push("Report missing, too short, or missing required sections")
    if (requests.length !== 2 || attempts !== 2) errors.push("Expected exactly report and acknowledgment requests")
    for (const request of requests) {
      if (
        request.httpStatus !== 200 ||
        request.finishStatus !== "completed" ||
        request.returnedTier !== entry.tier ||
        request.returnedModel?.replace(/^(us|global)\./, "") !== `openai.${model}` ||
        !request.outputTokens ||
        request.reasoningTokens === undefined ||
        request.cachedInputTokens === undefined ||
        !request.finishedMs
      )
        errors.push("Incomplete request metrics or wrong returned tier")
    }
    const generation = requests.find((request) => request.phase === "report")
    if (generation?.firstToolArgumentMs === undefined || generation.toolNames.length !== 1)
      errors.push("Missing report-generation tool argument timing")
    const visible =
      generation?.outputTokens === undefined || generation.reasoningTokens === undefined
        ? undefined
        : generation.outputTokens - generation.reasoningTokens
    const total = generation?.finishedMs
    const first = generation?.firstVisibleMs
    return {
      path: entry.name,
      trial,
      status: errors.length ? "failed" : "ok",
      errors: [...new Set(errors)],
      exitCode,
      attempts,
      requests,
      metrics: {
        processToFirstApiMs: requests[0]?.startMs,
        firstReportArgumentMs: generation?.firstToolArgumentMs,
        reportGenerationTotalMs: total,
        reportOutputTokens: generation?.outputTokens,
        reportReasoningTokens: generation?.reasoningTokens,
        visibleOutputTokens: visible,
        endToEndTokensPerSecond: visible !== undefined && total ? (visible * 1000) / total : undefined,
        postFirstVisibleTokensPerSecond:
          visible !== undefined && total && first !== undefined && total > first
            ? (visible * 1000) / (total - first)
            : undefined,
        reportWordsPerSecond: total ? (words * 1000) / total : undefined,
        reportSavedMs: cli.savedMs,
        cliWallMs: wallMs,
        reportWords: words,
        reportCharacters: markdown.length,
      },
      cli: {
        events: cli.events,
        stepFinishes: cli.stepFinishes,
        toolSuccesses: cli.toolSuccesses,
        stderrBytes: cli.stderrBytes,
      },
      report,
    }
  }

  const samples: Awaited<ReturnType<typeof measure>>[] = []
  const metadata = {
    startedAt,
    model,
    executable,
    context,
    contextSHA256: new Bun.CryptoHasher("sha256").update(brief).digest("hex"),
    prompt,
    paths,
    trialsPerPath: runs,
    outputTokenCap: tokens,
    reasoningEffort: "low",
    forceReasoning: true,
    store: false,
    concurrency: 1,
    warmups: 0,
    freshCLI: true,
    maxUpstreamRequests: 2,
    requestTimeoutMs: 180_000,
    cliTimeoutMs: 420_000,
    notes: [
      "Regions identify entry endpoints, not the undisclosed inference backend region.",
      "Report-generation timings exclude acknowledgment; request times are relative to proxy receipt, startMs to CLI launch.",
      "Visible tokens include patch/JSON framing; post-first-visible delivery rates can be inflated by buffering.",
      "Request bodies are forwarded unchanged; tool use after the report is forbidden by instruction and validated, not removed from the tool schema.",
      "No raw headers, request bodies, stderr, or generated arguments are retained in metrics.",
    ],
  }
  async function save(finished = false) {
    const summary = paths.map((entry) => {
      const selected = samples.filter((sample) => sample.path === entry.name)
      const successful = selected.filter((sample) => sample.status === "ok")
      const metrics = Object.keys(successful[0]?.metrics ?? {}).map((key) => {
        const values = successful
          .flatMap((sample) =>
            Object.entries(sample.metrics)
              .filter(([name, value]) => name === key && typeof value === "number")
              .map(([, value]) => Number(value)),
          )
          .toSorted((a, b) => a - b)
        return [
          key,
          values.length
            ? {
                median: (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2,
                min: values[0],
                max: values.at(-1),
              }
            : null,
        ]
      })
      return {
        path: entry.name,
        samples: selected.length,
        successful: successful.length,
        failed: selected.length - successful.length,
        metrics: Object.fromEntries(metrics),
      }
    })
    await Bun.write(
      `${output}.tmp`,
      JSON.stringify(
        { ...metadata, finishedAt: finished ? new Date().toISOString() : null, summary, samples },
        null,
        2,
      ) + "\n",
    )
    await rename(`${output}.tmp`, output)
    if (finished) console.log(JSON.stringify({ output, summary }, null, 2))
  }
  await save()
  for (let trial = 1; trial <= runs; trial++) {
    for (let offset = 0; offset < paths.length; offset++) {
      const sample = await measure(paths[(trial - 1 + offset) % paths.length], trial)
      samples.push(sample)
      await save()
      console.log(
        JSON.stringify({ path: sample.path, trial, status: sample.status, errors: sample.errors, ...sample.metrics }),
      )
    }
  }
  await save(true)
  if (samples.some((sample) => sample.status !== "ok")) process.exitCode = 1
}

if (import.meta.main)
  await main().catch(() => {
    console.error(
      "Benchmark failed before completion; check required inputs, credentials, and results.json. No raw error details are logged.",
    )
    process.exitCode = 1
  })
