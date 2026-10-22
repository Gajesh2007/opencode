import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Cause, Context, Effect, Exit, Option, Schema } from "effect"
import { Instruction } from "../session/instruction"
import { Parameters as ReadParameters, ReadTool } from "./read"
import * as Tool from "./tool"
import DESCRIPTION from "./read-many.txt"

const MAX_FILES = 16
const CONCURRENCY = 8
const DEFAULT_LIMIT = 200
const MAX_BYTES = 50 * 1024
const CAPPED = "\n\n[read_many output capped. Use read for this path/range, including any omitted instructions.]"
const OMITTED =
  "\n\n[read_many omitted instructions that exceed the output budget. Use read for this path to load them in full.]"

class ReadInstructions extends Context.Service<
  ReadInstructions,
  { owner: symbol; loaded: { filepath: string; content: string }[] }
>()("@opencode/ReadManyInstructions") {}

export const Parameters = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      ...ReadParameters.fields,
      limit: ReadParameters.fields.limit.annotate({
        description: `The maximum number of lines to read (defaults to ${DEFAULT_LIMIT})`,
      }),
    }),
  )
    .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_FILES))
    .annotate({ description: "Known file or directory paths and optional line ranges, in output order" }),
})

export const ReadManyTool = Tool.define(
  "read_many",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const instruction = yield* Instruction.Service
    // ReadTool only uses readFile for attachments, after its permission checks and MIME sniffing.
    // Reject there instead of loading an unbounded payload or silently discarding an attachment.
    const read = yield* (yield* ReadTool.pipe(
      Effect.provideService(AppFileSystem.Service, {
        ...fs,
        readFile: (filepath) =>
          Effect.die(new Error(`read_many does not support image or PDF attachments: ${filepath}. Use read instead.`)),
      }),
      Effect.provideService(Instruction.Service, {
        ...instruction,
        resolve: (messages, filepath, messageID) =>
          Effect.gen(function* () {
            const current = yield* Effect.serviceOption(ReadInstructions)
            if (Option.isNone(current)) return yield* Effect.die(new Error("Missing read_many instruction scope"))
            current.value.loaded.push(
              ...(yield* instruction.resolve(messages, filepath, messageID, current.value.owner)),
            )
            // Keep structured instructions separate from file text; never parse markers out of user content.
            return []
          }),
      }),
    )).init()

    return {
      description: DESCRIPTION,
      readOnly: true,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const owner = Symbol()
            return {
              owner,
              delivered: new Set<string>(),
              items: params.files.map((file) => ({
                file,
                instructions: ReadInstructions.of({ owner, loaded: [] }),
              })),
            }
          }),
          (batch) =>
            Effect.gen(function* () {
              const budget = Math.floor((MAX_BYTES - (params.files.length - 1) * 2) / params.files.length)
              const abort = Effect.callback<never>((resume) => {
                const cancel = () => resume(Effect.interrupt)
                if (ctx.abort.aborted) {
                  cancel()
                  return
                }
                ctx.abort.addEventListener("abort", cancel, { once: true })
                return Effect.sync(() => ctx.abort.removeEventListener("abort", cancel))
              })
              const exits = yield* Effect.forEach(
                batch.items,
                Effect.fnUntraced(function* (item) {
                  const args = { ...item.file, limit: item.file.limit ?? DEFAULT_LIMIT }
                  return yield* (
                    ctx.abort.aborted
                      ? Effect.interrupt
                      : Effect.raceFirst(
                          read
                            .execute(args, { ...ctx, metadata: () => Effect.void })
                            .pipe(Effect.provideService(ReadInstructions, item.instructions)),
                          abort,
                        )
                  ).pipe(Effect.exit)
                }),
                { concurrency: CONCURRENCY },
              )
              // Deduplicate only after every read settles, so failed or clipped owners cannot hide sibling guidance.
              const results = exits.map((exit, index) => {
                const item = batch.items[index]
                const limit = item.file.limit ?? DEFAULT_LIMIT
                const status = Exit.isSuccess(exit)
                  ? ("success" as const)
                  : Cause.hasInterruptsOnly(exit.cause)
                    ? ("cancelled" as const)
                    : ("error" as const)
                const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
                const body = Exit.isSuccess(exit)
                  ? exit.value.output
                  : status === "cancelled"
                    ? "Read cancelled."
                    : error instanceof Error
                      ? error.message
                      : String(error)
                const label = `[${index + 1}] ${status}: ${JSON.stringify(item.file.filePath)} (offset=${item.file.offset || 1}, limit=${limit})\n`
                const loaded = Exit.isSuccess(exit)
                  ? item.instructions.loaded.filter((entry) => !batch.delivered.has(entry.filepath))
                  : []
                const reminder = loaded.length
                  ? `<system-reminder>\n${loaded.map((entry) => entry.content).join("\n\n")}\n</system-reminder>\n\n`
                  : ""
                const keep = reminder.length > 0 && Buffer.byteLength(label + reminder + CAPPED) <= budget
                const omitted = reminder && !keep ? OMITTED : ""
                const bounded = clip(label + (keep ? reminder : "") + body, budget - Buffer.byteLength(omitted))
                if (keep) loaded.forEach((entry) => batch.delivered.add(entry.filepath))
                return {
                  output: bounded.output + omitted,
                  metadata: {
                    filePath: item.file.filePath,
                    offset: item.file.offset || 1,
                    limit,
                    status,
                    truncated:
                      Boolean(omitted) || bounded.truncated || (Exit.isSuccess(exit) && exit.value.metadata.truncated),
                    loaded: keep ? loaded.map((entry) => entry.filepath) : [],
                  },
                }
              })
              return {
                title: `${params.files.length} reads`,
                output: results.map((result) => result.output).join("\n\n"),
                metadata: {
                  truncated: results.some((result) => result.metadata.truncated),
                  loaded: [...batch.delivered],
                  results: results.map((result) => result.metadata),
                },
              }
            }),
          (batch, exit) =>
            instruction.release(ctx.messageID, batch.owner, Exit.isSuccess(exit) ? [...batch.delivered] : []),
        ),
    }
  }),
)

function clip(output: string, budget: number) {
  const bytes = Buffer.from(output)
  if (bytes.length <= budget) return { output, truncated: false }
  return {
    output: new TextDecoder().decode(bytes.subarray(0, budget - Buffer.byteLength(CAPPED)), { stream: true }) + CAPPED,
    truncated: true,
  }
}
