export * as WorkflowReport from "./report.js"

import { WorkflowFinding } from "./finding.js"
import { Workflow } from "@opencode/schema/workflow"

export type Cell = {
  unit: string
  pass: string
  agent: string
  sessionID?: string
  text: string
  status: "completed" | "empty" | "malformed" | "partial" | "cancelled" | "error"
  findings?: WorkflowFinding.Finding[]
  error?: string
}

export function coverage(results: readonly Cell[]) {
  const incomplete = results.filter((item) => item.status !== "completed")
  if (!incomplete.length) return `Coverage: complete (${results.length}/${results.length} cells).`
  return [
    `Coverage: INCOMPLETE (${results.length - incomplete.length}/${results.length} cells complete). This is not a clean review.`,
    ...incomplete
      .slice(0, 60)
      .map((item) => `- ${item.unit} / ${item.pass}: ${item.status}${item.error ? ` (${item.error})` : ""}`),
    ...(incomplete.length > 60 ? [`${incomplete.length - 60} additional incomplete cells; see outcomes.json.`] : []),
    "Retained findings and text from incomplete cells are partial evidence, not completed coverage.",
  ].join("\n")
}

export function aggregate(results: readonly Cell[], format: "text" | "findings") {
  if (format === "text") {
    const sections: string[] = []
    let length = 0
    for (const result of results) {
      if (!result.text.trim()) continue
      const block = `### ${result.unit} — ${result.pass}\n${result.text.trim()}`
      if (length + block.length > 120_000) {
        sections.push(`[output truncated: ${results.length} cells exceeded the 120000-char synthesis budget]`)
        break
      }
      sections.push(block)
      length += block.length
    }
    const text = sections.join("\n\n") || "(no results produced)"
    return { prompt: text, fallback: text, findings: undefined }
  }
  const findings = WorkflowFinding.rank(WorkflowFinding.dedupe(results.flatMap((item) => item.findings ?? [])))
  const top = findings.slice(0, 400)
  const prompt = [
    `There are ${findings.length} unique findings. Showing the top ${top.length}, ranked by severity, agreement and confidence.`,
    "Aggregated findings (JSON; sources are review lenses):",
    JSON.stringify(top),
  ].join("\n\n")
  const fallback = findings.length
    ? findings
        .map(
          (item) =>
            `- **${item.severity.toUpperCase()}** ${item.file}${item.line ? `:${item.line}` : ""} [${item.sources.join(", ")}] — ${item.title}${item.recommendation ? `\n  Fix: ${item.recommendation}` : ""}`,
        )
        .join("\n")
    : results.some((item) => item.status !== "completed")
      ? "No valid findings were recovered; coverage is incomplete."
      : "No findings."
  return { prompt, fallback, findings }
}

export function directive(workflow: Workflow.Definition) {
  return [
    "## Your workflow",
    "Determine the work units, then call the workflow tool once for the complete batch. It fans out every unit across every pass and optionally synthesizes the results. Do not process the units yourself.",
    JSON.stringify({
      passes: workflow.passes.map((pass) => ({
        ...pass,
        prompt: pass.prompt ?? `Process {unit_id} for the ${pass.name} pass. {unit_context}`,
      })),
      synthesis: workflow.synthesis
        ? { ...workflow.synthesis, prompt: workflow.synthesis.prompt ?? "Synthesize all results into one report." }
        : undefined,
      format: workflow.format ?? "text",
    }),
    workflow.instructions,
  ]
    .filter(Boolean)
    .join("\n\n")
}
