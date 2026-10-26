export * as ReadManyPlugin from "./read-many.js"

import { ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { ReadTool } from "../tool/plugin/read.js"

export const Plugin = define({
  id: "opencode.read-many",
  effect: Effect.fn("ReadManyPlugin")(function* (ctx) {
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name: "read_many",
          options: { codemode: false },
          description:
            "Read up to 16 known text files or directories concurrently, in input order. Use path, offset and limit as with read. Defaults to 200 lines per file; output is bounded to 50 KiB. Use read for images, PDFs or omitted content.",
          input: Schema.Struct({
            files: Schema.Array(ReadTool.Input).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
          }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const read = (yield* ctx.tool.list()).find((tool) => tool.id === ReadTool.name)
              if (!read) return yield* new ToolFailure({ message: "The read tool is unavailable." })
              const budget = Math.floor((50 * 1024) / input.files.length)
              const parts = yield* Effect.forEach(
                input.files,
                (file) =>
                  read.execute({ ...file, limit: file.limit ?? 200 }, { ...context, progress: () => Effect.void }).pipe(
                    Effect.map((result) => {
                      const content =
                        typeof result.content === "string"
                          ? result.content
                          : (result.content ?? [])
                              .filter((part) => part.type === "text")
                              .map((part) => part.text)
                              .join("\n")
                      const text =
                        Array.isArray(result.content) && result.content.some((part) => part.type === "file")
                          ? "Use read to view this attachment."
                          : content
                      return (
                        file.path +
                        "\n" +
                        (text.length > budget
                          ? text.slice(0, Math.max(0, budget - 100)) +
                            "\n[Output capped. Use read for the omitted content.]"
                          : text)
                      )
                    }),
                    Effect.catch((error) => Effect.succeed(file.path + "\nRead failed: " + error.message)),
                  ),
                { concurrency: 8 },
              )
              return { content: parts.join("\n\n"), metadata: { files: input.files.length } }
            }),
        }),
      )
      .pipe(Effect.orDie)
  }),
})
