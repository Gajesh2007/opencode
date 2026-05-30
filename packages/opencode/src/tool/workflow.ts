import * as Tool from "./tool"
import DESCRIPTION from "./workflow.txt"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { SubagentLimit } from "../agent/subagent-limit"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { parseFindings, dedupe, rank, type AggregatedFinding } from "../workflow/finding"
import type { TaskPromptOps } from "./task"
import { EffectBridge } from "@/effect/bridge"
import { Global } from "@opencode-ai/core/global"
import { Effect, Schema } from "effect"
import * as nodePath from "node:path"
import * as nodeFs from "node:fs"

const id = "workflow"

/**
 * Hard ceiling on units x passes for a single run. The engine bounds *concurrency*
 * separately (the shared SubagentLimit semaphore), but a single call still
 * enqueues this many sessions, so we refuse absurd grids outright rather than
 * silently spend a fortune. Reviewing a few thousand files x 3 lenses fits well
 * under this.
 */
const MAX_CELLS = 20000
/** Cap how many ranked findings get handed to the synthesizer so its context stays bounded. */
const SYNTH_FINDING_LIMIT = 400
/** Cap total characters of raw text fed to a text-mode synthesizer. */
const SYNTH_TEXT_LIMIT = 120_000

const Unit = Schema.Struct({
  id: Schema.String.annotate({ description: "Identifier for this work item, e.g. a file path" }),
  context: Schema.optional(Schema.String).annotate({
    description: "Optional extra context passed to each pass for this unit (substituted as {unit_context})",
  }),
})

const Pass = Schema.Struct({
  name: Schema.String.annotate({ description: "Name of this lens/pass, e.g. 'security'" }),
  agent: Schema.String.annotate({ description: "The subagent_type to run for this pass" }),
  prompt: Schema.String.annotate({
    description: "Instruction template for this pass. May contain {unit_id} and {unit_context} placeholders.",
  }),
})

const Synthesis = Schema.Struct({
  agent: Schema.String.annotate({ description: "The subagent_type that reduces all results into the final report" }),
  prompt: Schema.String.annotate({ description: "Instruction for the synthesis/reduce step" }),
})

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-7 words) label for this workflow run" }),
  units: Schema.Array(Unit).annotate({ description: "The work items to fan out over (e.g. one per changed file)" }),
  passes: Schema.Array(Pass).annotate({ description: "The lenses applied to every unit (e.g. security/logic/style)" }),
  synthesis: Schema.optional(Synthesis).annotate({
    description: "Optional single subagent that merges all results into one report",
  }),
  format: Schema.optional(Schema.Literals(["text", "findings"])).annotate({
    description: "'findings' parses+dedupes+ranks JSON findings per cell before synthesis; 'text' (default) keeps raw text",
  }),
  concurrency: Schema.optional(Schema.Finite).annotate({
    description: "Optional max cells in flight for this run (a global cap also applies)",
  }),
})

type CellResult = {
  unit: string
  pass: string
  agent: string
  sessionID: SessionID
  text: string
  error?: string
}

export const WorkflowTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const sessions = yield* Session.Service
    const limit = yield* SubagentLimit.Service

    const run = Effect.fn("WorkflowTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (params.units.length === 0) return error("workflow received no units to process")
      if (params.passes.length === 0) return error("workflow received no passes to run")
      const cellCount = params.units.length * params.passes.length
      if (cellCount > MAX_CELLS) {
        return error(
          `workflow would spawn ${cellCount} subagents (${params.units.length} units x ${params.passes.length} passes), exceeding the ${MAX_CELLS} limit. Split the run into smaller batches.`,
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [...new Set(params.passes.map((pass) => pass.agent))],
          always: ["*"],
          metadata: { description: params.description, units: params.units.length, passes: params.passes.length },
        })
      }

      // Validate every referenced agent up front so a typo fails fast instead of
      // after spawning hundreds of sessions.
      const agentNames = [...new Set([...params.passes.map((p) => p.agent), ...(params.synthesis ? [params.synthesis.agent] : [])])]
      const agentInfos = new Map<string, Agent.Info>()
      for (const name of agentNames) {
        const info = yield* agent.get(name).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (!info) return yield* Effect.fail(new Error(`Unknown agent type: ${name} is not a valid agent type`))
        agentInfos.set(name, info)
      }

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("WorkflowTool requires promptOps in ctx.extra"))

      const parent = yield* sessions.get(ctx.sessionID)
      const parentAgent = parent.agent
        ? yield* agent.get(parent.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(Effect.orDie)
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const parentUser = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: msg.info.parentID }).pipe(
        Effect.orDie,
      )
      const parentUserModel = parentUser.info.role === "user" ? parentUser.info.model : undefined
      const parentModel = { modelID: msg.info.modelID, providerID: msg.info.providerID }

      // Live progress: the UI reads this metadata reactively, so we re-emit it as
      // cells complete to drive a Claude-style fan-out progress display.
      const baseMeta = {
        units: params.units.length,
        passes: params.passes.length,
        cells: cellCount,
        format: params.format ?? "text",
      }
      let completed = 0
      const emitProgress = () =>
        ctx.metadata({ title: params.description, metadata: { ...baseMeta, completed, phase: "running" } })
      yield* emitProgress()

      // Each spawned session is tracked so an interrupt can cancel in-flight
      // children explicitly (belt-and-suspenders alongside Effect interruption).
      const children = new Set<SessionID>()
      const runCancel = yield* EffectBridge.make()
      const onAbort = () =>
        runCancel.fork(
          Effect.forEach([...children], (cid) => ops.cancel(cid), { concurrency: "unbounded", discard: true }),
        )

      // Run one subagent to completion and return only its final text. Failures
      // are captured (not thrown) so one bad cell never sinks the whole run.
      const runAgent = Effect.fn("WorkflowTool.runAgent")(function* (input: {
        agent: string
        title: string
        prompt: string
      }) {
        const info = agentInfos.get(input.agent)!
        const child = yield* sessions.create({
          parentID: ctx.sessionID,
          title: input.title,
          permission: deriveSubagentSessionPermission({
            parentSessionPermission: parent.permission ?? [],
            parentAgent,
            subagent: info,
          }),
        })
        children.add(child.id)
        const parts = yield* ops.resolvePromptParts(input.prompt)
        const result = yield* limit.withPermit(
          ops.prompt({
            messageID: MessageID.ascending(),
            sessionID: child.id,
            model: info.model ?? parentModel,
            agent: info.name,
            variant: info.variant ?? parentUserModel?.variant,
            serviceTier: info.serviceTier ?? parentUserModel?.serviceTier,
            upstream: parentUserModel?.upstream,
            tools: {
              ...(info.permission.some((rule) => rule.permission === "todowrite") ? {} : { todowrite: false }),
              ...(info.permission.some((rule) => rule.permission === "task") ? {} : { task: false }),
              ...(info.permission.some((rule) => rule.permission === "workflow") ? {} : { workflow: false }),
            },
            parts,
          }),
        )
        children.delete(child.id)
        return { sessionID: child.id, text: result.parts.findLast((p) => p.type === "text")?.text ?? "" }
      })

      const cells = params.units.flatMap((unit) =>
        params.passes.map((pass) => ({
          unit,
          pass,
          prompt: pass.prompt.replace(/\{unit_id\}/g, unit.id).replace(/\{unit_context\}/g, unit.context ?? ""),
        })),
      )

      const runCell = Effect.fn("WorkflowTool.runCell")(function* (cell: (typeof cells)[number]) {
        return yield* runAgent({
          agent: cell.pass.agent,
          title: `${cell.pass.name}: ${cell.unit.id}`,
          prompt: cell.prompt,
        }).pipe(
          Effect.map(
            (res): CellResult => ({
              unit: cell.unit.id,
              pass: cell.pass.name,
              agent: cell.pass.agent,
              sessionID: res.sessionID,
              text: res.text,
            }),
          ),
          Effect.catchCause(
            (cause): Effect.Effect<CellResult> =>
              Effect.succeed({
                unit: cell.unit.id,
                pass: cell.pass.name,
                agent: cell.pass.agent,
                sessionID: SessionID.make("aborted"),
                text: "",
                error: causeText(cause),
              }),
          ),
          Effect.tap(() => {
            completed += 1
            return emitProgress()
          }),
        )
      })

      const cap = yield* limit.cap
      const concurrency = Math.max(1, Math.floor(params.concurrency ?? cap))

      const work = Effect.gen(function* () {
        const results = yield* Effect.forEach(cells, runCell, { concurrency })
        const errors = results.filter((r) => r.error)
        const runDir = nodePath.join(Global.Path.data, "workflow", `${Date.now().toString(36)}-${slugify(params.description)}`)

        const synthesisInput =
          params.format === "findings"
            ? yield* buildFindingsSynthesis(results, runDir)
            : buildTextSynthesis(results, runDir)

        const report = params.synthesis
          ? (yield* runAgent({
              agent: params.synthesis.agent,
              title: `synthesis: ${params.description}`,
              prompt: `${params.synthesis.prompt}\n\n${synthesisInput.prompt}`,
            }).pipe(Effect.map((r) => r.text)))
          : synthesisInput.fallback

        writeArtifact(nodePath.join(runDir, "report.md"), report)

        const output = [
          `workflow: ${params.description}`,
          `cells: ${cellCount} (${params.units.length} units x ${params.passes.length} passes)` +
            (errors.length ? `, ${errors.length} failed` : ""),
          synthesisInput.summary ? synthesisInput.summary : undefined,
          `artifacts: ${runDir}`,
          "",
          "<workflow_report>",
          report || "(workflow completed but produced no report)",
          "</workflow_report>",
        ]
          .filter((line) => line !== undefined)
          .join("\n")

        const meta = {
          ...baseMeta,
          completed: cellCount,
          failed: errors.length,
          phase: "done" as const,
          ...(synthesisInput.findings !== undefined ? { findings: synthesisInput.findings } : {}),
          ...(synthesisInput.counts ? { counts: synthesisInput.counts } : {}),
        }
        return { output, meta }
      })

      const result = yield* Effect.acquireUseRelease(
        Effect.sync(() => ctx.abort.addEventListener("abort", onAbort)),
        () => work,
        () => Effect.sync(() => ctx.abort.removeEventListener("abort", onAbort)),
      )

      return {
        title: params.description,
        metadata: result.meta,
        output: result.output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

/** Findings mode: parse each cell's JSON, dedupe + rank deterministically, persist, and build a bounded synth prompt. */
function buildFindingsSynthesis(results: CellResult[], runDir: string) {
  return Effect.sync(() => {
    const all = results.flatMap((r) => parseFindings(r.text, { file: r.unit, lens: r.pass }))
    const ranked = rank(dedupe(all))
    writeArtifact(nodePath.join(runDir, "findings.json"), JSON.stringify(ranked, null, 2))

    const counts = countSeverities(ranked)
    const summary = `findings: ${ranked.length} unique (${formatCounts(counts)})`
    const top = ranked.slice(0, SYNTH_FINDING_LIMIT)
    const prompt = [
      `Severity counts: ${formatCounts(counts)}.`,
      ranked.length > top.length ? `Showing the top ${top.length} of ${ranked.length} ranked findings.` : undefined,
      "",
      "## Aggregated findings (JSON, pre-ranked; `sources`=lenses that reported it, `agreement`=how many)",
      "```json",
      JSON.stringify(top, null, 0),
      "```",
    ]
      .filter((line) => line !== undefined)
      .join("\n")

    return { prompt, summary, fallback: renderFindingsReport(ranked, counts), findings: ranked.length, counts }
  })
}

/** Text mode: concatenate raw cell outputs (capped) for the synthesizer. */
function buildTextSynthesis(results: CellResult[], _runDir: string) {
  const sections: string[] = []
  let total = 0
  for (const r of results) {
    if (r.error || !r.text.trim()) continue
    const block = `### ${r.unit} — ${r.pass}\n${r.text.trim()}`
    if (total + block.length > SYNTH_TEXT_LIMIT) {
      sections.push(`\n[output truncated: ${results.length} cells exceeded the ${SYNTH_TEXT_LIMIT}-char synthesis budget]`)
      break
    }
    sections.push(block)
    total += block.length
  }
  const body = sections.join("\n\n")
  return {
    prompt: ["## Collected results", body].join("\n\n"),
    summary: undefined as string | undefined,
    findings: undefined as number | undefined,
    counts: undefined as Record<string, number> | undefined,
    fallback: body || "(no results produced)",
  }
}

function renderFindingsReport(ranked: AggregatedFinding[], counts: Record<string, number>) {
  if (ranked.length === 0) return "No findings."
  const lines = [`# Review findings`, "", `Severity counts: ${formatCounts(counts)}.`, ""]
  for (const f of ranked) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file
    const agree = f.agreement > 1 ? ` (agreed by ${f.sources.join(", ")})` : ` [${f.sources.join(", ")}]`
    lines.push(`- **${f.severity.toUpperCase()}** \`${loc}\`${agree} — ${f.title}`)
    if (f.recommendation) lines.push(`  - fix: ${f.recommendation}`)
  }
  return lines.join("\n")
}

function countSeverities(findings: AggregatedFinding[]) {
  const counts: Record<string, number> = {}
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1
  return counts
}

function formatCounts(counts: Record<string, number>) {
  const order = ["critical", "high", "medium", "low", "info"]
  const parts = order.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`)
  return parts.length ? parts.join(", ") : "0 findings"
}

function writeArtifact(file: string, contents: string) {
  try {
    nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true })
    nodeFs.writeFileSync(file, contents)
  } catch {
    // Artifacts are best-effort; never fail the run because the cache dir is unwritable.
  }
}

function error(message: string) {
  return { title: "workflow", metadata: {}, output: message }
}

function causeText(cause: unknown) {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

function slugify(input: string) {
  return (
    input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workflow"
  )
}
