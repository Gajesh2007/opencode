import path from "path"
import { Schema } from "effect"
import { Effect, Option } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Ripgrep } from "../file/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import * as Tool from "./tool"
import { Reference } from "@/reference/reference"
import { MAX_BYTES, MAX_LINES } from "./truncate"

const MAX_LINE_LENGTH = 2000

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The regex pattern to search for in file contents" }),
  path: Schema.optional(Schema.String).annotate({
    description: "The directory to search in. Defaults to the current working directory.",
  }),
  include: Schema.optional(Schema.String).annotate({
    description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
  }),
  context: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 }))).annotate({
    description:
      "Lines of context before and after each match (0-10). Defaults to 0; positive values enable bounded search.",
  }),
})

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const rg = yield* Ripgrep.Service
    const reference = yield* Reference.Service

    return {
      description: DESCRIPTION,
      readOnly: true,
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const empty = {
            title: params.pattern,
            metadata: { matches: 0, truncated: false },
            output: "No files found",
          }
          if (!params.pattern) {
            throw new Error("pattern is required")
          }

          yield* ctx.ask({
            permission: "grep",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
              include: params.include,
              ...(params.context ? { context: params.context } : {}),
            },
          })

          const ins = yield* InstanceState.context
          const requested = path.isAbsolute(params.path ?? ins.directory)
            ? (params.path ?? ins.directory)
            : path.join(ins.directory, params.path ?? ".")
          yield* reference.ensure(requested)
          const requestedInfo = yield* fs.stat(requested).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const source = yield* assertExternalDirectoryEffect(ctx, requested, {
            bypass: yield* reference.contains(requested),
            kind: requestedInfo?.type === "Directory" ? "directory" : "file",
            readOnly: true,
          })

          const search = source?.path ?? AppFileSystem.resolve(requested)
          const info = source ? undefined : yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const cwd = source ? ins.directory : info?.type === "Directory" ? search : path.dirname(search)
          const file = source || info?.type === "Directory" ? undefined : [path.relative(cwd, search)]

          const result = yield* rg.search({
            cwd,
            pattern: params.pattern,
            glob: params.include ? [params.include] : undefined,
            file,
            stdin: source?.text,
            signal: ctx.abort,
            context: params.context,
          })
          if (result.items.length === 0 && !params.context) return empty

          const rows = [
            { items: result.items, match: true },
            { items: result.context ?? [], match: false },
          ].flatMap((group) =>
            group.items.map((item) => ({
              path:
                source?.path ??
                AppFileSystem.resolve(
                  path.isAbsolute(item.path.text) ? item.path.text : path.join(cwd, item.path.text),
                ),
              line: item.line_number,
              text: item.lines.text,
              match: group.match,
            })),
          )
          const times = source
            ? new Map([[source.path, source.mtime]])
            : new Map(
                (yield* Effect.forEach(
                  [...new Set(rows.map((row) => row.path))],
                  Effect.fnUntraced(function* (file) {
                    const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
                    if (!info || info.type === "Directory") return undefined
                    return [
                      file,
                      info.mtime.pipe(
                        Option.map((time) => time.getTime()),
                        Option.getOrElse(() => 0),
                      ) ?? 0,
                    ] as const
                  }),
                  { concurrency: 16 },
                )).filter((entry): entry is readonly [string, number] => Boolean(entry)),
              )
          const found = rows.flatMap((row) => {
            const mtime = times.get(row.path)
            if (mtime === undefined) return []
            return [{ ...row, mtime }]
          })
          const matches = params.context ? found.filter((row) => row.match) : found

          matches.sort((a, b) => b.mtime - a.mtime)

          const limit = 100
          const truncated = matches.length > limit || !!result.truncated
          const final = truncated ? matches.slice(0, limit) : matches

          const context = params.context
          if (context) {
            if (final.length === 0 && !truncated && !result.partial) return empty
            const order = new Map(final.map((match, index) => [match.path, index]))
            const lines = found
              .filter((row) =>
                final.some(
                  (match) =>
                    match.path === row.path &&
                    (row.match ? row.line === match.line : Math.abs(row.line - match.line) <= context),
                ),
              )
              .sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0) || a.line - b.line)
            const notice =
              "(Results truncated: matches or context may be incomplete, and line text may be clipped. Narrow the path or pattern.)"
            const skipped = "(Some paths were inaccessible or could not be decoded and were skipped)"
            const body: string[] = []
            // Reserve the longest heading and both notices so the complete result stays bounded.
            let bytes = Buffer.byteLength(
              `Found at least ${matches.length} matches (showing ${limit})\n\n${notice}\n\n${skipped}`,
            )
            let count = 6
            let current = ""
            let shown = 0
            let clipped = truncated
            for (const row of lines) {
              const text = row.text.replace(/\r?\n$/, "")
              const line = `  Line ${row.line}${row.match ? "" : " (context)"}: ${text.length > MAX_LINE_LENGTH ? text.slice(0, MAX_LINE_LENGTH) + "..." : text}`
              const entry = current === row.path ? line : `${body.length ? "\n" : ""}${row.path}:\n${line}`
              const size = Buffer.byteLength(entry) + 1
              const added = entry.split("\n").length
              if (bytes + size > MAX_BYTES || count + added > MAX_LINES) {
                clipped = true
                break
              }
              body.push(entry)
              bytes += size
              count += added
              current = row.path
              if (row.match) shown++
              if (text.length > MAX_LINE_LENGTH) clipped = true
            }
            const heading =
              result.truncated && matches.length === 0
                ? "Search truncated before any matches could be returned"
                : `Found ${result.truncated ? "at least " : ""}${matches.length} matches${shown < matches.length ? ` (showing ${shown})` : ""}`
            const output = [heading, ...body]
            if (clipped) output.push("", notice)
            if (result.partial) output.push("", skipped)
            return {
              title: params.pattern,
              metadata: { matches: matches.length, truncated: clipped },
              output: output.join("\n"),
            }
          }

          if (final.length === 0) return empty

          const total = matches.length
          const output = [`Found ${total} matches${truncated ? ` (showing first ${limit})` : ""}`]

          let current = ""
          for (const match of final) {
            if (current !== match.path) {
              if (current !== "") output.push("")
              current = match.path
              output.push(`${match.path}:`)
            }
            const text =
              match.text.length > MAX_LINE_LENGTH ? match.text.substring(0, MAX_LINE_LENGTH) + "..." : match.text
            output.push(`  Line ${match.line}: ${text}`)
          }

          if (truncated) {
            output.push("")
            output.push(
              `(Results truncated: showing ${limit} of ${total} matches (${total - limit} hidden). Consider using a more specific path or pattern.)`,
            )
          }

          if (result.partial) {
            output.push("")
            output.push("(Some paths were inaccessible and skipped)")
          }

          return {
            title: params.pattern,
            metadata: {
              matches: total,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
