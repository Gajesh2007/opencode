import path from "node:path"
import os from "node:os"
import { mkdir, mkdtemp } from "node:fs/promises"
import { parseArgs } from "node:util"
import type { SessionTiming } from "../src/session/timing"

const cases: {
  id: string
  prompt: string
  files: Record<string, string>
  edits: Record<string, string>
  check: string
}[] = [
  {
    id: "small-fix",
    prompt:
      "Fix clamp.ts: clamp values to inclusive min/max, and throw RangeError when min > max. Preserve the signature. Run the tests.",
    files: {
      "clamp.ts":
        "export const clamp = (value: number, min: number, max: number) => Math.max(max, Math.min(min, value))\n",
    },
    edits: {
      "clamp.ts":
        "export const clamp = (value: number, min: number, max: number) => {\n  if (min > max) throw new RangeError('invalid bounds')\n  return Math.max(min, Math.min(max, value))\n}\n",
    },
    check:
      "import { clamp } from './clamp'; test('bounds', () => { expect(clamp(-2, 0, 9)).toBe(0); expect(clamp(3, 0, 9)).toBe(3); expect(clamp(12, 0, 9)).toBe(9); expect(clamp(2, 2, 2)).toBe(2); expect(() => clamp(0, 2, 1)).toThrow(RangeError) })",
  },
  {
    id: "investigation",
    prompt:
      "Investigate why retry(0) becomes 3. Do not modify config.ts. Write diagnosis.json with rootCause equal to the offending expression, file equal to its relative path, and fix equal to the replacement expression. Run tests.",
    files: { "config.ts": "export const retry = (value?: number) => value || 3\n" },
    edits: { "diagnosis.json": '{"file":"config.ts","rootCause":"value || 3","fix":"value ?? 3"}\n' },
    check:
      "test('diagnosis', async () => { const d = await Bun.file(new URL('./diagnosis.json', import.meta.url)).json(); expect(d).toEqual({file:'config.ts', rootCause:'value || 3', fix:'value ?? 3'}); expect(await Bun.file(new URL('./config.ts', import.meta.url)).text()).toBe('export const retry = (value?: number) => value || 3\\n') })",
  },
  {
    id: "tool-chain",
    prompt:
      "Read events.jsonl, calculate total count, sum of amount for status=ok only, and sorted unique names for ok events. Write report.json with count, total, names; do not change input. Use tools to verify your result and run tests.",
    files: {
      "events.jsonl":
        '{"name":"zeta","status":"ok","amount":4}\n{"name":"alpha","status":"failed","amount":100}\n{"name":"beta","status":"ok","amount":-1}\n{"name":"zeta","status":"ok","amount":2}\n',
    },
    edits: { "report.json": '{"count":4,"total":5,"names":["beta","zeta"]}\n' },
    check:
      "test('aggregation', async () => { expect(await Bun.file(new URL('./report.json', import.meta.url)).json()).toEqual({count:4,total:5,names:['beta','zeta']}) })",
  },
  {
    id: "integration",
    prompt:
      "Integrate parse.ts with cli.ts. CLI takes one comma-separated argument and prints the sum as JSON {total:number}. Ignore empty fields, accept negative and decimal numbers, reject other non-numeric fields with nonzero exit. Run tests, including invoking the CLI.",
    files: {
      "parse.ts":
        "export const parse = (text: string) => text.split(',').filter(x => x.trim()).map(x => { const n = Number(x); if (!Number.isFinite(n)) throw new Error('invalid number'); return n })\n",
      "cli.ts": "console.log(JSON.stringify({ total: 0 }))\n",
    },
    edits: {
      "cli.ts":
        "import { parse } from './parse'\nconsole.log(JSON.stringify({ total: parse(process.argv[2] ?? '').reduce((a, b) => a + b, 0) }))\n",
    },
    check:
      "test('CLI integration', () => { for (const [arg,total] of [['1,2,3',6],['-1,2.5,,',1.5],['',0]] as const) { const r=Bun.spawnSync([process.execPath,new URL('./cli.ts',import.meta.url).pathname,arg]); expect(r.exitCode).toBe(0); expect(JSON.parse(r.stdout.toString())).toEqual({total}) } expect(Bun.spawnSync([process.execPath,new URL('./cli.ts',import.meta.url).pathname,'bad']).exitCode).not.toBe(0) })",
  },
]

export type Options = {
  mode: "fixture" | "live"
  binary?: string
  output?: string
  model?: string
  config?: object
  auth?: string
  only?: string
  timeoutMs?: number
  fixtureFailure?: boolean
}

export async function run(options: Options) {
  if (options.binary !== undefined) {
    if (!path.isAbsolute(options.binary)) throw new Error("--binary must be an absolute file path")
    if (!(await Bun.file(options.binary).exists())) throw new Error(`--binary file does not exist: ${options.binary}`)
  }
  if (options.mode === "live" && (!options.model || !options.config))
    throw new Error("Live mode requires --model and --config")
  const selected = cases.filter((task) => !options.only || task.id === options.only)
  if (!selected.length) throw new Error(`Unknown task: ${options.only}`)
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))
    throw new Error("Timeout must be positive finite milliseconds")
  const base = path.join(os.tmpdir(), "opencode")
  await mkdir(base, { recursive: true })
  const output = options.output ? path.resolve(options.output) : await mkdtemp(path.join(base, "agent-bench-"))
  await mkdir(output, { recursive: true })
  const results = []
  for (const task of selected) {
    // Each sample has fresh working files, home, database, and provider state.
    // Keep every sample, including failed outputs, for postmortem inspection.
    const directory = await mkdtemp(path.join(output, `${task.id}-`))
    const workspace = path.join(directory, "workspace")
    const home = path.join(directory, "home")
    await Promise.all([mkdir(workspace), mkdir(home)])
    await Promise.all(Object.entries(task.files).map(([name, text]) => Bun.write(path.join(workspace, name), text)))
    await Bun.write(path.join(workspace, "acceptance.test.ts"), `import {test,expect} from 'bun:test'\n${task.check}\n`)
    await Bun.write(
      path.join(workspace, "AGENTS.md"),
      "Work only in this disposable fixture. Do not spawn agents, use the network, install dependencies, or edit acceptance.test.ts or AGENTS.md. Complete only the requested task.\n",
    )
    const initial = Bun.spawnSync(["git", "init", "--quiet"], { cwd: workspace })
    if (initial.exitCode) throw new Error(initial.stderr.toString())
    let requests = 0
    let auxiliaryRequests = 0
    const actions = [
      { name: "read", args: { filePath: path.join(workspace, Object.keys(task.files)[0]) } },
      {
        name: "apply_patch",
        args: {
          patchText:
            "*** Begin Patch\n" +
            Object.entries(task.edits)
              .map(
                ([name, text]) =>
                  `${
                    name in task.files
                      ? `*** Update File: ${name}\n@@\n${task.files[name]
                          .trimEnd()
                          .split("\n")
                          .map((line) => `-${line}`)
                          .join("\n")}\n`
                      : `*** Add File: ${name}\n`
                  }${text
                    .trimEnd()
                    .split("\n")
                    .map((line) => `+${line}`)
                    .join("\n")}\n`,
              )
              .join("") +
            "*** End Patch",
        },
      },
      {
        name: "bash",
        args: { command: "bun test acceptance.test.ts", description: "Verify the fixture acceptance checks" },
      },
    ]
    const server =
      options.mode === "fixture"
        ? Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(req) {
              const body = (await req.json()) as { tools?: { function: { name: string } }[] }
              const action = body.tools?.length ? actions[requests++] : undefined
              if (!body.tools?.length) auxiliaryRequests++
              if (action && !body.tools?.some((tool) => tool.function.name === action.name)) {
                return Response.json(
                  { error: { message: `Fixture tool unavailable: ${action.name}` } },
                  { status: 400 },
                )
              }
              const delta =
                action && !(options.fixtureFailure && requests === 2)
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          id: `call_${requests}`,
                          type: "function",
                          function: { name: action.name, arguments: JSON.stringify(action.args) },
                        },
                      ],
                    }
                  : { content: "Task complete." }
              const chunk = (delta: object, finish_reason: string | null) =>
                `data: ${JSON.stringify({ id: `fixture_${requests}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } } : {}) })}\n\n`
              return new Response(
                chunk(delta, null) +
                  chunk({}, action && !(options.fixtureFailure && requests === 2) ? "tool_calls" : "stop") +
                  "data: [DONE]\n\n",
                { headers: { "content-type": "text/event-stream" } },
              )
            },
          })
        : undefined
    const config =
      options.mode === "fixture"
        ? {
            enabled_providers: ["fixture"],
            provider: {
              fixture: {
                npm: "@ai-sdk/openai-compatible",
                options: { apiKey: "fixture", baseURL: `http://127.0.0.1:${server?.port}/v1` },
                models: {
                  "gpt-fixture": {
                    name: "Fixture",
                    limit: { context: 100000, output: 10000 },
                    cost: { input: 0, output: 0 },
                  },
                },
              },
            },
          }
        : options.config
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...config,
        formatter: false,
        lsp: false,
        agent: { build: { steps: 10 } },
        permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow", bash: "allow", edit: "allow" },
      }),
      OPENCODE_AUTH_CONTENT: options.auth ?? "{}",
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOCOMPACT: "1",
    }
    const command = [
      ...(options.binary
        ? [options.binary]
        : [process.execPath, "run", "--conditions=browser", path.resolve(import.meta.dir, "../src/index.ts")]),
      "run",
      "--print-logs",
      "--format",
      "json",
      "--model",
      options.model ?? "fixture/gpt-fixture",
      task.prompt,
    ]
    await Bun.write(
      path.join(directory, "invocation.json"),
      JSON.stringify(
        {
          mode: options.mode,
          model: options.model ?? "fixture/gpt-fixture",
          command,
          timeoutMs: options.timeoutMs ?? 120000,
        },
        null,
        2,
      ),
    )
    const start = performance.now()
    const child = Bun.spawn(command, { cwd: workspace, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, options.timeoutMs ?? 120000)
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    clearTimeout(timer)
    server?.stop(true)
    const durationMs = performance.now() - start
    await Promise.all([
      Bun.write(path.join(directory, "stdout.jsonl"), stdout),
      Bun.write(path.join(directory, "stderr.log"), stderr),
    ])
    const phases = stderr.split("\n").flatMap((line) => {
      const json = line.match(/service=session\.timing .*?timing=(\{.*\}) phase$/)?.[1]
      return json ? [JSON.parse(json) as SessionTiming.Record] : []
    })
    const check = Bun.spawnSync([process.execPath, "test", "acceptance.test.ts"], { cwd: workspace, timeout: 30000 })
    await Bun.write(path.join(directory, "acceptance.log"), check.stdout.toString() + check.stderr.toString())
    const protectedFiles = {
      ...task.files,
      "acceptance.test.ts": `import {test,expect} from 'bun:test'\n${task.check}\n`,
      "AGENTS.md":
        "Work only in this disposable fixture. Do not spawn agents, use the network, install dependencies, or edit acceptance.test.ts or AGENTS.md. Complete only the requested task.\n",
    }
    const unchanged = (
      await Promise.all(
        Object.entries(protectedFiles)
          .filter(([name]) => !(name in task.edits))
          .map(
            async ([name, text]) =>
              (await Bun.file(path.join(workspace, name))
                .text()
                .catch(() => "")) === text,
          ),
      )
    ).every(Boolean)
    let malformedEvents = 0
    const events = stdout
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as { type?: string; part?: unknown }]
        } catch {
          malformedEvents++
          return []
        }
      })
    const coverage = ["preparation", "request_prepared", "first_useful", "tool", "request", "overall"].every((phase) =>
      phases.some((record) => record.phase === phase),
    )
    const accepted =
      !timedOut &&
      exitCode === 0 &&
      check.exitCode === 0 &&
      unchanged &&
      coverage &&
      malformedEvents === 0 &&
      !events.some((event) => event.type === "error")
    const result = {
      task: task.id,
      mode: options.mode,
      accepted,
      timedOut,
      exitCode,
      acceptanceExitCode: check.exitCode,
      protectedFilesUnchanged: unchanged,
      phaseCoverage: coverage,
      malformedEvents,
      durationMs,
      requests: server ? requests : undefined,
      auxiliaryRequests: server ? auxiliaryRequests : undefined,
      usage: events.filter((event) => event.type === "step_finish").map((event) => event.part),
      phases,
      directory,
    }
    results.push(result)
    await Bun.write(path.join(directory, "result.json"), JSON.stringify(result, null, 2))
    await Bun.write(
      path.join(output, "results.json"),
      JSON.stringify(
        { version: 1, results, accepted: results.filter((r) => r.accepted).length, total: selected.length },
        null,
        2,
      ),
    )
    console.log(JSON.stringify({ task: task.id, accepted, durationMs, directory }))
  }
  return { output, results }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "fixture" },
      binary: { type: "string" },
      output: { type: "string" },
      model: { type: "string" },
      config: { type: "string" },
      auth: { type: "string" },
      only: { type: "string" },
      timeout: { type: "string" },
      "fixture-failure": { type: "boolean" },
    },
  })
  if (values.mode !== "fixture" && values.mode !== "live") throw new Error("--mode must be fixture or live")
  const result = await run({
    mode: values.mode,
    binary: values.binary,
    output: values.output,
    model: values.model,
    config: values.config ? await Bun.file(values.config).json() : undefined,
    auth: values.auth ? await Bun.file(values.auth).text() : undefined,
    only: values.only,
    timeoutMs: values.timeout ? Number(values.timeout) : undefined,
    fixtureFailure: values["fixture-failure"],
  })
  console.log(`Artifacts: ${result.output}`)
  process.exitCode = result.results.every((r) => r.accepted) ? 0 : 1
}
