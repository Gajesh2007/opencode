import path from "node:path"
import os from "node:os"
import { mkdir, mkdtemp, rm } from "node:fs/promises"

// Offline, zero-cost measurement of the local agent-loop overhead on the real
// Anthropic request path (@ai-sdk/anthropic -> processor -> tools -> snapshot).
// A scripted Messages API server answers instantly, so the gap between the end
// of response N and the arrival of request N+1 is pure harness turnaround:
// tool execution, snapshot tracking, persistence, and request preparation.
//
//   bun run script/bench-anthropic-overhead.ts
//   BENCH_REPO=/path/to/repo BENCH_STEPS=12 BENCH_RUNS=3 bun run script/bench-anthropic-overhead.ts
//
// BENCH_REPO clones a local repository (hardlinked) so snapshot costs reflect a
// realistic worktree; otherwise a synthetic repository of BENCH_FILES files is used.

const steps = Number(process.env.BENCH_STEPS ?? 10)
const runs = Number(process.env.BENCH_RUNS ?? 3)
const files = Number(process.env.BENCH_FILES ?? 1000)
const tool = process.env.BENCH_TOOL ?? "read"
const keep = process.env.BENCH_KEEP === "1"
// Simulated time to first token. Live Opus 5.5 fast-mode steps measured about
// 2s p50; overlapping local work only pays off when the model takes time.
const ttft = Number(process.env.BENCH_TTFT_MS ?? 0)

type Sample = { turnaround: number[]; firstRequestMs: number; totalMs: number; requests: number; auxiliary: number }

const sse = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`

function response(step: number, action: { name: string; input: object } | undefined) {
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }
  const start = sse("message_start", {
    message: {
      id: `msg_bench_${step}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  })
  const body = action
    ? sse("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id: `toolu_bench_${step}`, name: action.name, input: {} },
      }) +
      sse("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(action.input) },
      }) +
      sse("content_block_stop", { index: 0 })
    : sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
      sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Done." } }) +
      sse("content_block_stop", { index: 0 })
  const end =
    sse("message_delta", {
      delta: { stop_reason: action ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    }) + sse("message_stop", {})
  return start + body + end
}

async function workspace(directory: string) {
  const target = path.join(directory, "workspace")
  if (process.env.BENCH_REPO) {
    const clone = Bun.spawnSync(["git", "clone", "--quiet", "--local", process.env.BENCH_REPO, target])
    if (clone.exitCode) throw new Error(clone.stderr.toString())
    return target
  }
  await mkdir(path.join(target, "src"), { recursive: true })
  await Promise.all(
    Array.from({ length: files }, (_, i) =>
      Bun.write(path.join(target, "src", `file-${i}.ts`), `export const value${i} = ${i}\n`.repeat(20)),
    ),
  )
  const init = Bun.spawnSync(
    ["sh", "-c", "git init --quiet && git add -A && git -c user.email=b@b -c user.name=b commit --quiet -m init"],
    {
      cwd: target,
    },
  )
  if (init.exitCode) throw new Error(init.stderr.toString())
  return target
}

function action(root: string, step: number) {
  if (tool === "bash") return { name: "bash", input: { command: `echo step-${step}`, description: "Echo step" } }
  if (tool === "glob") return { name: "glob", input: { pattern: "*.md" } }
  // Edits exercise the dirty-snapshot path: every step changes one tracked file.
  if (tool === "write")
    return { name: "write", input: { filePath: path.join(root, `bench-${step % 3}.txt`), content: `step ${step}\n` } }
  return {
    name: "read",
    input: { filePath: path.join(root, process.env.BENCH_REPO ? "README.md" : "src/file-1.ts"), limit: 5 },
  }
}

async function sample(index: number, base: string): Promise<Sample> {
  const directory = await mkdtemp(path.join(base, `run-${index}-`))
  const root = await workspace(directory)
  const home = path.join(directory, "home")
  await mkdir(home, { recursive: true })
  let requests = 0
  let auxiliary = 0
  let lastEnd: number | undefined
  const turnaround: number[] = []
  let first: number | undefined
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const arrived = performance.now()
      const body = (await req.json()) as { tools?: unknown[] }
      // Title and other auxiliary calls carry no tools; answer them without
      // disturbing the main loop's timing.
      if (!body.tools?.length) {
        auxiliary++
        return new Response(response(1000 + auxiliary, undefined), { headers: { "content-type": "text/event-stream" } })
      }
      first ??= arrived
      if (lastEnd !== undefined) turnaround.push(arrived - lastEnd)
      const step = requests++
      // BENCH_DUMP=<file> captures the third main request (system, history, and
      // tool results) to inspect cache breakpoints and headers on the wire.
      if (process.env.BENCH_DUMP && step === 2)
        await Bun.write(
          process.env.BENCH_DUMP,
          JSON.stringify({ headers: Object.fromEntries(req.headers), body }, null, 2),
        )
      const text = response(step, step < steps ? action(root, step) : undefined)
      if (ttft > 0) await Bun.sleep(ttft)
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text))
          lastEnd = performance.now()
          controller.close()
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })
  const config = {
    enabled_providers: ["anthropic"],
    formatter: false,
    lsp: false,
    // BENCH_SNAPSHOT=0 measures the harness floor without git snapshots.
    ...(process.env.BENCH_SNAPSHOT === "0" ? { snapshot: false } : {}),
    agent: { build: { steps: steps + 5 } },
    permission: { "*": "allow" },
    provider: {
      anthropic: {
        npm: "@ai-sdk/anthropic",
        options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${server.port}/v1` },
        models: {
          "claude-opus-5-5": {
            name: "Claude Opus 5.5",
            reasoning: true,
            tool_call: true,
            temperature: false,
            limit: { context: 1000000, output: 128000 },
            cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
          },
        },
      },
    },
  }
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
  }
  const command = [
    process.execPath,
    "run",
    "--conditions=browser",
    path.resolve(import.meta.dir, "../src/index.ts"),
    "run",
    "--format",
    "json",
    "--model",
    "anthropic/claude-opus-5-5",
    `Use the ${tool} tool repeatedly as instructed.`,
  ]
  const started = performance.now()
  const child = Bun.spawn(command, { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const totalMs = performance.now() - started
  await server.stop(true)
  if (code !== 0 || requests !== steps + 1) {
    console.error(stderr.slice(-4000))
    throw new Error(`run ${index} failed: exit=${code} requests=${requests}/${steps + 1}`)
  }
  if (!keep) await rm(directory, { recursive: true, force: true })
  return { turnaround, firstRequestMs: (first ?? started) - started, totalMs, requests, auxiliary }
}

const pct = (xs: number[], p: number) => {
  const sorted = xs.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

const base = path.join(os.tmpdir(), "opencode", "bench-anthropic-overhead")
await mkdir(base, { recursive: true })
const results: Sample[] = []
for (let i = 0; i < runs; i++) results.push(await sample(i, base))
const all = results.flatMap((r) => r.turnaround)
console.log(
  JSON.stringify(
    {
      tool,
      steps,
      runs,
      repo: process.env.BENCH_REPO ?? `synthetic:${files}`,
      turnaroundMs: { p50: +pct(all, 50).toFixed(1), p90: +pct(all, 90).toFixed(1), max: +Math.max(...all).toFixed(1) },
      firstRequestMs: results.map((r) => Math.round(r.firstRequestMs)),
      totalMs: results.map((r) => Math.round(r.totalMs)),
      auxiliary: results.map((r) => r.auxiliary),
    },
    null,
    2,
  ),
)
