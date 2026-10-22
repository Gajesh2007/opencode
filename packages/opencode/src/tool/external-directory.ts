import path from "path"
import { constants } from "node:fs"
import { open, realpath } from "node:fs/promises"
import { and, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import * as EffectLogger from "@opencode-ai/core/effect/logger"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { containsPath } from "../project/instance-context"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Database } from "@/storage/db"
import { MessageTable, PartTable } from "@/session/session.sql"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
  readOnly?: boolean
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return

  const full = process.platform === "win32" ? AppFileSystem.normalizePath(target) : target
  const kind = options?.kind ?? "file"
  if (options?.readOnly && kind === "file" && path.isAbsolute(full)) {
    const source = yield* readSessionReference(ctx, full)
    if (source) return source
  }

  if (options?.bypass) return
  const ins = yield* InstanceState.context
  if (containsPath(full, ins)) return

  const dir = kind === "directory" ? full : path.dirname(full)
  const glob =
    process.platform === "win32"
      ? AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  yield* ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: full,
      parentDir: dir,
    },
  })
})

const readSessionReference = Effect.fnUntraced(function* (ctx: Tool.Context, full: string) {
  const hash = /^(codex|opencode)-([a-f0-9]{64})\.md$/.exec(path.basename(full))
  if (!hash) return

  const current = ctx.messages.some(
    (message) =>
      message.info.role === "user" &&
      message.info.sessionID === ctx.sessionID &&
      message.parts.some(
        (part) =>
          part.type === "text" &&
          part.synthetic === true &&
          !part.ignored &&
          part.sessionID === ctx.sessionID &&
          part.messageID === message.info.id &&
          matchesReference(part.metadata?.sessionReference, full, hash[1]),
      ),
  )
  // Compaction trims the model context, not the original user parts. Select only
  // reference metadata through the session index, never arbitrary message bodies.
  const stored =
    current ||
    (yield* Effect.try({
      try: () =>
        Database.use((db) =>
          db
            .select({
              provider: sql<unknown>`json_extract(${PartTable.data}, '$.metadata.sessionReference.provider')`,
              id: sql<unknown>`json_extract(${PartTable.data}, '$.metadata.sessionReference.id')`,
              path: sql<unknown>`json_extract(${PartTable.data}, '$.metadata.sessionReference.path')`,
            })
            .from(PartTable)
            .innerJoin(MessageTable, eq(PartTable.message_id, MessageTable.id))
            .where(
              and(
                eq(PartTable.session_id, ctx.sessionID),
                eq(MessageTable.session_id, ctx.sessionID),
                sql`json_extract(${MessageTable.data}, '$.role') = 'user'`,
                sql`json_extract(${PartTable.data}, '$.type') = 'text'`,
                sql`json_type(${PartTable.data}, '$.synthetic') = 'true'`,
                sql`coalesce(json_extract(${PartTable.data}, '$.ignored'), 0) = 0`,
                sql`json_extract(${PartTable.data}, '$.metadata.sessionReference.provider') = ${hash[1]}`,
              ),
            )
            .all()
            .some((reference) => matchesReference(reference, full, hash[1])),
        ),
      catch: (error) => error,
    }).pipe(Effect.orElseSucceed(() => false)))
  if (!stored) return

  // Capture and hash the opened file once. Callers must consume these bytes,
  // not reopen a pathname that can change while an ordinary permission waits.
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise(() => open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)),
    (file) =>
      Effect.tryPromise(async () => {
        const canonical = await realpath(full)
        if ((process.platform === "win32" ? AppFileSystem.normalizePath(canonical) : canonical) !== full) return
        const info = await file.stat()
        if (!info.isFile()) return
        const bytes = await file.readFile()
        if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== hash[2]) return
        return { path: full, text: bytes.toString("utf8"), mtime: info.mtimeMs }
      }),
    (file) => Effect.tryPromise(() => file.close()).pipe(Effect.ignore),
  ).pipe(Effect.orElseSucceed(() => undefined))
})

function matchesReference(value: unknown, full: string, provider: string) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("provider" in value) ||
    value.provider !== provider ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    !("path" in value) ||
    typeof value.path !== "string"
  )
    return false
  if (process.platform !== "win32") return value.path === full
  // This comparison must not follow symlinks and rebind the stored capability.
  return (
    path.win32.normalize(AppFileSystem.windowsPath(value.path)).toLowerCase() ===
    path.win32.normalize(full).toLowerCase()
  )
}

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options).pipe(Effect.provide(EffectLogger.layer)))
}
