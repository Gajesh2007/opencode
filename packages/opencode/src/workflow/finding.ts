import { Option, Schema } from "effect"

/**
 * Structured finding contract for the fan-out workflow engine's "findings" mode.
 *
 * Reviewer subagents emit a JSON array of these; the engine parses them
 * tolerantly (LLM output is messy), de-duplicates across lenses, and ranks them
 * deterministically so the synthesizer only ever sees a bounded, ordered set —
 * which is what lets review scale to thousands of files without overflowing the
 * synthesizer's context.
 */
export const Severity = Schema.Literals(["critical", "high", "medium", "low", "info"])
export type Severity = Schema.Schema.Type<typeof Severity>

const FindingFields = {
  file: Schema.String,
  line: Schema.optional(Schema.Finite),
  endLine: Schema.optional(Schema.Finite),
  severity: Severity,
  lens: Schema.String,
  title: Schema.String,
  description: Schema.String,
  recommendation: Schema.optional(Schema.String),
  confidence: Schema.optional(Schema.Finite),
  code: Schema.optional(Schema.String),
}

export const Finding = Schema.Struct(FindingFields).annotate({ identifier: "Finding" })
export type Finding = Schema.Schema.Type<typeof Finding>

/** A finding after cross-lens aggregation: carries which lenses reported it and how many agreed. */
export const AggregatedFinding = Schema.Struct({
  ...FindingFields,
  id: Schema.String,
  sources: Schema.mutable(Schema.Array(Schema.String)),
  agreement: Schema.Finite,
}).annotate({ identifier: "AggregatedFinding" })
export type AggregatedFinding = Schema.Schema.Type<typeof AggregatedFinding>

export function severityWeight(severity: Severity): number {
  switch (severity) {
    case "critical":
      return 5
    case "high":
      return 4
    case "medium":
      return 3
    case "low":
      return 2
    case "info":
      return 1
  }
}

const decodeFinding = Schema.decodeUnknownOption(Finding)

/**
 * Tolerantly extract findings from an LLM's (possibly chatty) text output.
 * Pulls the first JSON array (or fenced ```json block, or a lone object),
 * fills missing severity/lens/file from `defaults`, validates each item against
 * the schema, and silently drops anything malformed. Returns [] on no match.
 */
export function parseFindings(text: string, defaults?: { file?: string; lens?: string }): Finding[] {
  const raw = extractJson(text)
  if (raw === undefined) return []
  // JSON.parse on untrusted LLM text is the one place a try/catch is warranted.
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  return items.flatMap((item) => {
    if (typeof item !== "object" || item === null) return []
    const withDefaults = {
      severity: "info",
      lens: defaults?.lens ?? "general",
      file: defaults?.file ?? "unknown",
      ...item,
    }
    const decoded = decodeFinding(withDefaults)
    return Option.isSome(decoded) ? [decoded.value] : []
  })
}

/** Collapse findings that point at the same file:line:title, merging the lenses that reported them. */
export function dedupe(findings: Finding[]): AggregatedFinding[] {
  const groups = new Map<string, Finding[]>()
  for (const finding of findings) {
    const key = `${finding.file}:${finding.line ?? ""}:${finding.title.trim().toLowerCase()}`
    const existing = groups.get(key)
    if (existing) existing.push(finding)
    else groups.set(key, [finding])
  }
  return [...groups.entries()].map(([key, members]) => {
    const base = members.reduce((a, b) => (severityWeight(b.severity) > severityWeight(a.severity) ? b : a))
    const sources = [...new Set(members.map((member) => member.lens))]
    const confidence = members.reduce<number | undefined>(
      (max, member) =>
        member.confidence === undefined ? max : max === undefined ? member.confidence : Math.max(max, member.confidence),
      base.confidence,
    )
    return { ...base, confidence, id: hashKey(key), sources, agreement: sources.length }
  })
}

/** Order findings by severity, then cross-lens agreement, then confidence, then file. Pure (no mutation). */
export function rank(items: AggregatedFinding[]): AggregatedFinding[] {
  return [...items].sort((a, b) => {
    const severity = severityWeight(b.severity) - severityWeight(a.severity)
    if (severity !== 0) return severity
    const agreement = b.agreement - a.agreement
    if (agreement !== 0) return agreement
    const confidence = (b.confidence ?? 0) - (a.confidence ?? 0)
    if (confidence !== 0) return confidence
    return a.file.localeCompare(b.file)
  })
}

/** Human/LLM-readable description of the finding shape, for embedding in reviewer prompts. */
export function renderForPrompt(): string {
  return [
    "Output ONLY a JSON array of findings. No prose. Return [] if you find nothing.",
    "Each finding is an object with these fields:",
    "- file (string, required): path to the file.",
    "- line (number, optional): starting line.",
    "- endLine (number, optional): ending line.",
    '- severity (required): one of "critical", "high", "medium", "low", "info".',
    "- lens (string, required): your review lens.",
    "- title (string, required): short imperative title.",
    "- description (string, required): what the issue is and why it matters.",
    "- recommendation (string, optional): concrete fix.",
    "- confidence (number 0.0-1.0, optional): how sure you are.",
    "- code (string, optional): the offending snippet.",
    "",
    "Example:",
    '[{"file":"src/a.ts","line":42,"severity":"high","lens":"security","title":"...","description":"...","recommendation":"...","confidence":0.8}]',
  ].join("\n")
}

function extractJson(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  const arrayStart = candidate.indexOf("[")
  const arrayEnd = candidate.lastIndexOf("]")
  if (arrayStart !== -1 && arrayEnd > arrayStart) return candidate.slice(arrayStart, arrayEnd + 1)
  const objectStart = candidate.indexOf("{")
  const objectEnd = candidate.lastIndexOf("}")
  if (objectStart !== -1 && objectEnd > objectStart) return candidate.slice(objectStart, objectEnd + 1)
  return undefined
}

// Deterministic, dependency-free djb2 hash → base36, for stable finding ids.
function hashKey(key: string): string {
  let hash = 5381
  for (let i = 0; i < key.length; i++) hash = (((hash << 5) + hash) + key.charCodeAt(i)) | 0
  return (hash >>> 0).toString(36)
}
