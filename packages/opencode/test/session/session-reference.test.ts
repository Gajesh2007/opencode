import { describe, expect, test } from "bun:test"
import { SessionReference } from "@/session/prompt/session-reference"

describe("session reference syntax", () => {
  test("accepts unquoted multi-word Codex and OpenCode titles", () => {
    expect(
      SessionReference.parse(
        "Use this chat:\n@codex:Check machines hitting cache limit\n@opencode:Database lock investigation",
      ).map((item) => [item.provider, item.query]),
    ).toEqual([
      ["codex", "Check machines hitting cache limit"],
      ["opencode", "Database lock investigation"],
    ])
  })

  test("accepts quoted titles inline and preserves source offsets", () => {
    const text = 'Compare @codex:"Check machines hitting cache limit" with @opencode:ses_example'
    const references = SessionReference.parse(text)
    expect(references.map((item) => item.query)).toEqual(["Check machines hitting cache limit", "ses_example"])
    expect(references.every((item) => text.slice(item.source.start, item.source.end) === item.source.value)).toBe(true)
  })

  test("accepts multiple references on one line and escaped quotes", () => {
    expect(
      SessionReference.parse('@codex:"The \\"cache\\" issue" @opencode:Another chat').map((item) => item.query),
    ).toEqual(['The "cache" issue', "Another chat"])
  })

  test("does not expand escaped references, email-like text, or fenced code", () => {
    const text =
      "\\@codex:escaped\nname@opencode:email\n```text\n@codex:example\n```\n~~~\n@opencode:example\n~~~\n`@codex:Actual reference`"
    expect(SessionReference.parse(text).map((item) => item.query)).toEqual(["Actual reference"])
  })

  test("only closes fences at matching delimiters on their own line", () => {
    const text = [
      "````markdown",
      "```text",
      "@codex:Private chat in an example",
      "```",
      "````",
      "```js",
      'const marker = "```"',
      "@opencode:Still inside the code block",
      "```",
      "@opencode:Actual chat",
    ].join("\n")
    expect(SessionReference.parse(text).map((item) => item.query)).toEqual(["Actual chat"])
  })

  test("ignores references in indented, quoted, and unclosed fences", () => {
    const text = [
      "> ~~~~text",
      "> @codex:Quoted private chat",
      "> ~~~",
      "> @opencode:Still quoted",
      "> ~~~~",
      "@codex:Visible chat",
      "    ```text",
      "    @opencode:Never closed",
    ].join("\n")
    expect(SessionReference.parse(text).map((item) => item.query)).toEqual(["Visible chat"])
  })

  test("does not close a top-level fence with quoted or indented backticks", () => {
    const text = [
      "```markdown",
      "> ```",
      "@codex:Private quoted example",
      "    ```",
      "@opencode:Private indented example",
      "```",
      "@opencode:Actual chat",
    ].join("\n")
    expect(SessionReference.parse(text).map((item) => item.query)).toEqual(["Actual chat"])
  })

  test("recognizes fences inside list items", () => {
    const text = [
      "- ```text",
      "  @codex:Private list example",
      "  ```",
      "- - ~~~~text",
      "    @opencode:Private nested list example",
      "    ~~~~",
      "@codex:Actual chat",
    ].join("\n")
    expect(SessionReference.parse(text).map((item) => item.query)).toEqual(["Actual chat"])
  })

  test("keeps ambiguous list continuation boundaries inside the exclusion", () => {
    const text = [
      "- Example:",
      "  ```text",
      "  An indented code block",
      "```",
      "@codex:Private example in a new top-level fence",
      "```",
      "  ```",
      "@opencode:Actual chat",
    ].join("\n")
    expect(SessionReference.parse(text).map((item) => item.query)).toEqual(["Actual chat"])
  })
})
