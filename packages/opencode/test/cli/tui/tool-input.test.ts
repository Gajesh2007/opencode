import { describe, expect, test } from "bun:test"
import { parseFileToolInput, parseToolInput } from "../../../src/cli/cmd/tui/util/tool-input"

describe("streaming tool input", () => {
  test("previews code before the argument string or object is complete", () => {
    expect(parseToolInput('{"filePath":"src/main.ts","content":"const value = 1;\\n')).toEqual({
      filePath: "src/main.ts",
      content: "const value = 1;\n",
    })
    expect(parseToolInput('{"patchText":"*** Begin Patch\\n*** Add File: main.ts\\n+const')).toEqual({
      patchText: "*** Begin Patch\n*** Add File: main.ts\n+const",
    })
    expect(parseToolInput('{"oldString":"before","newString":"after')).toEqual({
      oldString: "before",
      newString: "after",
    })
  })

  test("handles every chunk boundary including split escapes", () => {
    const input = { content: 'const path = "C:\\tmp";\n\t// \u263a', filePath: "main.ts" }
    const raw = JSON.stringify(input)
    for (let end = 0; end <= raw.length; end++) {
      const partial = parseToolInput(raw.slice(0, end))
      if (typeof partial.content === "string") expect(input.content.startsWith(partial.content)).toBe(true)
    }
    expect(parseToolInput(raw)).toEqual(input)
    expect(parseToolInput('{"content":"hello \\u26')).toEqual({ content: "hello " })
    expect(parseToolInput('{"content":"hello \\u263a')).toEqual({ content: "hello \u263a" })
  })

  test("ignores empty, malformed and non-object inputs", () => {
    for (const raw of ["", " ", "not json", "null", "[]", '"text"', "42"]) {
      expect(parseToolInput(raw)).toEqual({})
    }
  })

  test("only exposes correctly typed file arguments before schema validation", () => {
    expect(parseFileToolInput('{"filePath":123,"content":"hello')).toEqual({ content: "hello" })
    expect(parseFileToolInput('{"patchText":{},"oldString":[],"newString":true,"replaceAll":"yes"}')).toEqual({})
    expect(parseFileToolInput('{"filePath":"main.ts","newString":"hello","replaceAll":true}')).toEqual({
      filePath: "main.ts",
      newString: "hello",
      replaceAll: true,
    })
  })
})
