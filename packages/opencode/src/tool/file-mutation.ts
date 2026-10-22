import { Effect, Semaphore } from "effect"
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Bom from "@/util/bom"

const locks = new Map<string, Semaphore.Semaphore>()

export function withLocks<A, E, R>(paths: string[], effect: Effect.Effect<A, E, R>) {
  return Effect.suspend(() => {
    const targets = paths.map(canonical)
    // All names come before all inode locks, with deterministic ordering in each phase.
    return withKeys(
      targets.map((target) => `path:${target}`),
      Effect.suspend(() => {
        // A queued creation can gain an inode while waiting for its name lock.
        const sources = paths.map(inspect)
        return withKeys(
          sources.flatMap((source) => (source.identity === undefined ? [] : [`inode:${source.identity}`])),
          Effect.suspend(() => {
            const changed = paths.findIndex((filePath, index) => {
              const current = inspect(filePath)
              return current.target !== targets[index] || current.identity !== sources[index].identity
            })
            if (changed !== -1) {
              return Effect.die(new Error(`File target changed while waiting for a mutation lock: ${paths[changed]}`))
            }
            return effect
          }),
        )
      }),
    )
  })
}

function withKeys<A, E, R>(keys: string[], effect: Effect.Effect<A, E, R>) {
  return [...new Set(keys)].sort().reduceRight((effect, key) => {
    const lock = locks.get(key) ?? Semaphore.makeUnsafe(1)
    locks.set(key, lock)
    return lock.withPermit(effect)
  }, effect)
}

function inspect(filePath: string) {
  const target = canonical(filePath)
  const stats = statSync(target, { bigint: true, throwIfNoEntry: false })
  return { target, identity: stats ? `${stats.dev}:${stats.ino}` : undefined }
}

function canonical(filePath: string, links = 0): string {
  const resolved = AppFileSystem.windowsPath(filePath)
  const parent = path.dirname(resolved)
  if (parent === resolved) return realpathSync.native(resolved)
  // Bun's realpath can return a different hard-link name; only resolve symlinks.
  const name = path.join(canonical(parent, links), path.basename(resolved))
  if (!lstatSync(name, { throwIfNoEntry: false })?.isSymbolicLink()) return name
  if (links >= 40) throw new Error(`Too many symbolic links in mutation path: ${filePath}`)
  const link = readlinkSync(name)
  const target = canonical(path.isAbsolute(link) ? link : `${path.dirname(name)}${path.sep}${link}`, links + 1)
  lstatSync(target)
  return target
}

export const read = Effect.fn("FileMutation.read")(function* (fs: AppFileSystem.Interface, filePath: string) {
  const source = inspect(filePath)
  const bytes = yield* fs
    .readFile(filePath)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
  return {
    filePath,
    ...source,
    bytes,
    ...Bom.split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)),
  }
})

export type Snapshot = Effect.Success<ReturnType<typeof read>>

export const assertUnchanged = Effect.fn("FileMutation.assertUnchanged")(function* (
  fs: AppFileSystem.Interface,
  before: Snapshot,
) {
  const current = yield* read(fs, before.filePath)
  if (
    before.target !== current.target ||
    before.identity !== current.identity ||
    before.bytes?.length !== current.bytes?.length ||
    before.bytes?.some((byte, index) => byte !== current.bytes?.[index])
  ) {
    return yield* Effect.fail(
      new Error(`File changed while waiting for permission: ${before.filePath}. Read it again before retrying.`),
    )
  }
})

export * as FileMutation from "./file-mutation"
