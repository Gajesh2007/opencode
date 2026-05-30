import { describe, expect, test } from "bun:test"
import { parseFindings, dedupe, rank, type Finding } from "@/workflow/finding"

describe("workflow.finding", () => {
  test("parseFindings extracts from a fenced ```json block", () => {
    const text = [
      "Here is what I found:",
      "```json",
      '[{"file":"a.ts","line":10,"severity":"high","lens":"security","title":"SQL injection","description":"d"}]',
      "```",
      "Hope that helps.",
    ].join("\n")
    const out = parseFindings(text)
    expect(out.length).toBe(1)
    expect(out[0].file).toBe("a.ts")
    expect(out[0].severity).toBe("high")
  })

  test("parseFindings extracts a raw array and fills defaults", () => {
    const out = parseFindings('[{"line":1,"title":"T","description":"D"}]', { file: "b.ts", lens: "logic" })
    expect(out.length).toBe(1)
    expect(out[0].file).toBe("b.ts")
    expect(out[0].lens).toBe("logic")
    expect(out[0].severity).toBe("info")
  })

  test("parseFindings drops malformed items but keeps valid ones", () => {
    const text = [
      '[{"file":"a.ts","severity":"high","lens":"logic","title":"ok","description":"d"},',
      '{"file":"a.ts","severity":"not-a-severity","lens":"logic","title":"bad","description":"d"},',
      '{"file":"a.ts","lens":"logic"}]', // missing title + description
    ].join("")
    const out = parseFindings(text)
    expect(out.length).toBe(1)
    expect(out[0].title).toBe("ok")
  })

  test("parseFindings returns [] when there is no JSON", () => {
    expect(parseFindings("no findings here")).toEqual([])
  })

  test("dedupe merges the same finding reported by different lenses", () => {
    const findings: Finding[] = [
      { file: "a.ts", line: 5, severity: "high", lens: "security", title: "Same Bug", description: "d1" },
      { file: "a.ts", line: 5, severity: "medium", lens: "logic", title: "same bug", description: "d2" },
    ]
    const agg = dedupe(findings)
    expect(agg.length).toBe(1)
    expect(agg[0].agreement).toBe(2)
    expect([...agg[0].sources].sort()).toEqual(["logic", "security"])
    // base keeps the highest severity of the merged group
    expect(agg[0].severity).toBe("high")
  })

  test("rank orders by severity then agreement", () => {
    const ranked = rank(
      dedupe([
        { file: "z.ts", line: 1, severity: "low", lens: "style", title: "minor", description: "d" },
        { file: "a.ts", line: 2, severity: "critical", lens: "security", title: "rce", description: "d" },
        { file: "m.ts", line: 3, severity: "low", lens: "logic", title: "edge", description: "d" },
      ]),
    )
    expect(ranked[0].severity).toBe("critical")
    expect(ranked[0].file).toBe("a.ts")
  })
})
