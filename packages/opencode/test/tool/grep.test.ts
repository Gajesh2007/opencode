import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { GrepTool } from "../../src/tool/grep"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Ripgrep } from "../../src/file/ripgrep"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { testEffect } from "../lib/effect"
import { Reference } from "@/reference/reference"
import { RepositoryCache } from "@/reference/repository-cache"
import { Permission } from "../../src/permission"
import type * as Tool from "../../src/tool/tool"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Git } from "@/git"
import { Filesystem } from "@/util/filesystem"

const referenceLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Reference.layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(RepositoryCache.defaultLayer),
    Layer.provide(RuntimeFlags.layer(flags)),
  )

const toolLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Ripgrep.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    Git.defaultLayer,
    referenceLayer(flags),
  )

const it = testEffect(toolLayer())
const scout = testEffect(toolLayer({ experimentalScout: true }))

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const root = path.join(__dirname, "../..")
const full = (p: string) => (process.platform === "win32" ? Filesystem.normalizePath(p) : p)

const githubBase = <A, E, R>(url: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = url
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous) process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = previous
        else delete process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      }),
  )

const git = Effect.fn("GrepToolTest.git")(function* (cwd: string, args: string[]) {
  return yield* Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`)
    return stdout.trim()
  })
})

describe("tool.grep", () => {
  it.live("basic search", () =>
    Effect.gen(function* () {
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* provideInstance(root)(
        grep.execute(
          {
            pattern: "export",
            path: path.join(root, "src/tool"),
            include: "*.ts",
          },
          ctx,
        ),
      )
      expect(result.metadata.matches).toBeGreaterThan(0)
      expect(result.output).toContain("Found")
    }),
  )

  it.instance("no matches returns correct output", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "test.txt"), "hello world"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "xyznonexistentpatternxyz123",
          path: test.directory,
        },
        ctx,
      )
      expect(result.metadata.matches).toBe(0)
      expect(result.output).toBe("No files found")
    }),
  )

  it.instance("finds matches in tmp instance", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "test.txt"), "line1\nline2\nline3"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "line",
          path: test.directory,
        },
        ctx,
      )
      expect(result.metadata.matches).toBeGreaterThan(0)
    }),
  )

  it.instance("supports exact file paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "test.txt")
      yield* Effect.promise(() => Bun.write(file, "line1\nline2\nline3"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "line2",
          path: file,
        },
        ctx,
      )
      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain(file)
      expect(result.output).toContain("Line 2: line2")
    }),
  )

  describe("context", () => {
    it.instance("zero context preserves the exact default output and search result", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "test.txt")
        yield* Effect.promise(() => Bun.write(file, "before\nneedle\nafter"))
        const grep = yield* (yield* GrepTool).init()
        const original = yield* grep.execute({ pattern: "needle", path: file }, ctx)
        const zero = yield* grep.execute({ pattern: "needle", path: file, context: 0 }, ctx)
        expect(zero).toEqual(original)
        expect(original.output).toBe(`Found 1 matches\n${full(file)}:\n  Line 2: needle\n`)
        expect(original.metadata).toEqual({ matches: 1, truncated: false })

        const rg = yield* Ripgrep.Service
        const search = yield* rg.search({ cwd: test.directory, pattern: "needle" })
        expect(yield* rg.search({ cwd: test.directory, pattern: "needle", context: 0 })).toEqual(search)
        expect(Object.keys(search).sort()).toEqual(["items", "partial"])
        const contextual = yield* rg.search({ cwd: test.directory, pattern: "needle", context: 1 })
        expect(contextual.items).toEqual(search.items)
        expect(contextual.context?.map((item) => item.line_number)).toEqual([1, 3])
        expect(contextual.truncated).toBe(false)
        expect((yield* grep.execute({ pattern: "absent", path: file, context: 1 }, ctx)).output).toBe("No files found")
      }),
    )

    it.instance("clips context at file boundaries without including unrelated lines", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "boundaries.txt")
        yield* Effect.promise(() => Bun.write(file, "first\nleft\nunrelated\nright\nlast"))
        const grep = yield* (yield* GrepTool).init()
        const result = yield* grep.execute({ pattern: "first|last", path: file, context: 1 }, ctx)
        expect(result.output).toBe(
          [
            "Found 2 matches",
            `${full(file)}:`,
            "  Line 1: first",
            "  Line 2 (context): left",
            "  Line 4 (context): right",
            "  Line 5: last",
          ].join("\n"),
        )
        expect(result.metadata).toEqual({ matches: 2, truncated: false })
      }),
    )

    it.instance("merges overlapping context without duplicating or relabeling matches", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "overlap.txt")
        yield* Effect.promise(() =>
          Bun.write(file, "unrelated\nbefore\nneedle one\nbetween\nneedle two\nafter\nunrelated"),
        )
        const grep = yield* (yield* GrepTool).init()
        const result = yield* grep.execute({ pattern: "needle", path: file, context: 2 }, ctx)
        expect(result.metadata).toEqual({ matches: 2, truncated: false })
        expect(result.output.match(/^  Line 4 \(context\): between$/gm)).toHaveLength(1)
        expect(result.output.match(/^  Line [35]: needle/gm)).toHaveLength(2)
        expect(result.output.match(/^  Line \d+/gm)).toHaveLength(7)
        expect(result.output).not.toContain("Line 3 (context)")
        expect(result.output).not.toContain("Line 5 (context)")
      }),
    )

    it.instance("accepts ten context lines and preserves CRLF and final-line boundaries", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "maximum.txt")
        yield* Effect.promise(() =>
          Bun.write(
            file,
            Array.from({ length: 21 }, (_, i) => (i === 10 ? "needle" : `neighbor ${i + 1}`)).join("\r\n"),
          ),
        )
        const grep = yield* (yield* GrepTool).init()
        const result = yield* grep.execute({ pattern: "needle", path: file, context: 10 }, ctx)
        expect(result.metadata).toEqual({ matches: 1, truncated: false })
        expect(result.output.match(/^  Line \d+/gm)).toHaveLength(21)
        expect(result.output).toContain("Line 1 (context): neighbor 1\n")
        expect(result.output).toContain("Line 11: needle\n")
        expect(result.output).toEndWith("Line 21 (context): neighbor 21")
        expect(result.output).not.toContain("\r")
      }),
    )

    it.instance("sorts files by modification time and keeps context in source order", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const older = path.join(test.directory, "older.txt")
        const newer = path.join(test.directory, "newer.txt")
        yield* Effect.promise(() => Bun.write(older, "older before\nneedle older\nolder after"))
        yield* Effect.promise(() => Bun.write(newer, "newer before\nneedle newer\nnewer after"))
        yield* Effect.promise(() => fs.utimes(older, 1000, 1000))
        yield* Effect.promise(() => fs.utimes(newer, 2000, 2000))
        const grep = yield* (yield* GrepTool).init()
        const result = yield* grep.execute({ pattern: "needle", context: 1 }, ctx)
        expect(result.output).toBe(
          [
            "Found 2 matches",
            `${full(newer)}:`,
            "  Line 1 (context): newer before",
            "  Line 2: needle newer",
            "  Line 3 (context): newer after",
            "",
            `${full(older)}:`,
            "  Line 1 (context): older before",
            "  Line 2: needle older",
            "  Line 3 (context): older after",
          ].join("\n"),
        )
      }),
    )

    it.instance("rejects invalid context before requesting permission", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const grep = yield* (yield* GrepTool).init()
        const requests: string[] = []
        for (const context of [-1, 11, 1.5, NaN, Infinity]) {
          const exit = yield* grep
            .execute(
              { pattern: "needle", path: test.directory, context },
              {
                ...ctx,
                ask: (request) =>
                  Effect.sync(() => {
                    requests.push(request.permission)
                  }),
              },
            )
            .pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("context")
        }
        expect(requests).toEqual([])
      }),
    )

    it.instance("retains relative paths, include filters, and grep permission metadata", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "selected.ts")
        yield* Effect.promise(() => Bun.write(file, "before\nneedle\nafter"))
        yield* Effect.promise(() => Bun.write(path.join(test.directory, "ignored.txt"), "needle ignored"))
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        const grep = yield* (yield* GrepTool).init()
        const result = yield* grep.execute(
          { pattern: "needle", path: ".", include: "*.ts", context: 1 },
          {
            ...ctx,
            ask: (request) =>
              Effect.sync(() => {
                requests.push(request)
              }),
          },
        )
        expect(result.metadata).toEqual({ matches: 1, truncated: false })
        expect(result.output).toContain(full(file))
        expect(result.output).toContain("Line 1 (context): before")
        expect(result.output).not.toContain("ignored")
        expect(requests).toHaveLength(1)
        expect(requests[0]?.permission).toBe("grep")
        expect(requests[0]?.metadata).toEqual({ pattern: "needle", path: ".", include: "*.ts", context: 1 })
      }),
    )

    it.instance("still requires external-directory permission", () =>
      Effect.gen(function* () {
        yield* TestInstance
        const directory = yield* tmpdirScoped()
        yield* Effect.promise(() => Bun.write(path.join(directory, "test.txt"), "before\nneedle\nafter"))
        const requests: string[] = []
        const denied = new Error("external directory denied")
        const grep = yield* (yield* GrepTool).init()
        const exit = yield* grep
          .execute(
            { pattern: "needle", path: directory, context: 1 },
            {
              ...ctx,
              ask: (request) =>
                Effect.suspend(() => {
                  requests.push(request.permission)
                  return request.permission === "external_directory" ? Effect.die(denied) : Effect.void
                }),
            },
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(denied)
        expect(requests).toEqual(["grep", "external_directory"])
      }),
    )

    it.instance("preserves cancellation reasons", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => Bun.write(path.join(test.directory, "test.txt"), "before\nneedle\nafter"))
        const cancelled = new Error("cancel contextual search")
        const grep = yield* (yield* GrepTool).init()
        const exit = yield* grep
          .execute({ pattern: "needle", context: 1 }, { ...ctx, abort: AbortSignal.abort(cancelled) })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(cancelled)
      }),
    )

    it.instance("discards matches and context from binary files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => Bun.write(path.join(test.directory, "binary.dat"), "needle\n\0hidden\n"))
        yield* Effect.promise(() => Bun.write(path.join(test.directory, "text.txt"), "before\nneedle\nafter"))
        const grep = yield* (yield* GrepTool).init()
        const result = yield* grep.execute({ pattern: "needle", context: 1 }, ctx)
        expect(result.metadata).toEqual({ matches: 1, truncated: false })
        expect(result.output).toContain("text.txt")
        expect(result.output).not.toContain("binary.dat")
        expect(result.output).not.toContain("hidden")
      }),
    )

    it.instance("skips undecodable context instead of failing the whole search", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "encoded.dat"),
            new Uint8Array([110, 101, 101, 100, 108, 101, 10, 255, 10]),
          ),
        )
        yield* Effect.promise(() => Bun.write(path.join(test.directory, "text.txt"), "before\nneedle\nafter"))
        const grep = yield* (yield* GrepTool).init()
        const result = yield* grep.execute({ pattern: "needle", context: 1 }, ctx)
        expect(result.metadata.matches).toBe(1)
        expect(result.output).not.toContain("encoded.dat")
        expect(result.output).toContain("could not be decoded")
      }),
    )

    it.instance("reports clipping of both match and context line text", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          Bun.write(path.join(test.directory, "long.txt"), `${"x".repeat(3000)}\nneedle${"y".repeat(3000)}\nafter`),
        )
        const grep = yield* (yield* GrepTool).init()
        const result = yield* grep.execute({ pattern: "needle", context: 1 }, ctx)
        expect(result.metadata).toEqual({ matches: 1, truncated: true })
        expect(result.output).toContain(`Line 1 (context): ${"x".repeat(2000)}...`)
        expect(result.output).toContain(`Line 2: needle${"y".repeat(1994)}...`)
        expect(result.output).not.toContain("x".repeat(2001))
        expect(result.output).toContain("Results truncated")
        const original = yield* grep.execute({ pattern: "needle" }, ctx)
        expect(original.metadata).toEqual({ matches: 1, truncated: false })
        expect(original.output).toContain(`Line 2: needle${"y".repeat(1994)}...`)
      }),
    )

    it.instance("distinguishes exactly 100 matches from a truncated dense search", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "dense.txt")
        const grep = yield* (yield* GrepTool).init()
        for (const count of [100, 10000]) {
          yield* Effect.promise(() => Bun.write(file, "needle\n".repeat(count)))
          const result = yield* grep
            .execute({ pattern: "needle", path: file, context: 1 }, ctx)
            .pipe(Effect.timeout("5 seconds"))
          expect(result.metadata.truncated).toBe(count > 100)
          expect(result.output.match(/^  Line \d+:/gm)).toHaveLength(100)
          if (count > 100) {
            // rg can also report matches in the final after-context window.
            expect(result.metadata.matches).toBeGreaterThan(100)
            expect(result.metadata.matches).toBeLessThanOrEqual(102)
            expect(result.output).toContain(`Found at least ${result.metadata.matches} matches`)
          }
          if (count === 100) {
            expect(result.metadata.matches).toBe(100)
            expect(result.output).not.toContain("truncated")
          }
        }
        const original = yield* grep.execute({ pattern: "needle", path: file }, ctx)
        expect(original.metadata).toEqual({ matches: 10000, truncated: true })
        expect(original.output).toStartWith("Found 10000 matches (showing first 100)")
      }),
    )

    it.instance("bounds total UTF-8 output bytes and reports omitted context", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "bytes.txt"),
            `${"\u754c".repeat(1000)}\nneedle\n${"\u754c".repeat(1000)}\n`.repeat(60),
          ),
        )
        const grep = yield* (yield* GrepTool).init()
        const result = yield* grep.execute({ pattern: "needle", context: 1 }, ctx)
        expect(result.metadata).toEqual({ matches: 60, truncated: true })
        expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(50 * 1024)
        expect(result.output).toContain("Results truncated")
        expect(result.output).toContain("(showing ")
      }),
    )

    it.instance("bounds total output lines even for many disjoint context windows", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "lines.txt"),
            `${"x\n".repeat(10)}needle\n${"x\n".repeat(10)}gap\n`.repeat(100),
          ),
        )
        const grep = yield* (yield* GrepTool).init()
        const result = yield* grep.execute({ pattern: "needle", context: 10 }, ctx)
        expect(result.metadata).toEqual({ matches: 100, truncated: true })
        expect(result.output.split("\n").length).toBeLessThanOrEqual(2000)
        expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(50 * 1024)
        expect(result.output).toContain("Results truncated")
      }),
    )

    it.instance("bounds oversized JSON lines without claiming a complete empty search", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          Bun.write(path.join(test.directory, "huge.txt"), `needle\n${"x".repeat(2 * 1024 * 1024)}`),
        )
        const grep = yield* (yield* GrepTool).init()
        const result = yield* grep.execute({ pattern: "needle", context: 1 }, ctx).pipe(Effect.timeout("5 seconds"))
        expect(result.metadata).toEqual({ matches: 0, truncated: true })
        expect(result.output).toContain("Search truncated before any matches could be returned")
        expect(result.output).not.toContain("No files found")
        expect(result.output).not.toContain("Found 0 matches")
        expect(result.output).not.toContain("could not be decoded")
        expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(50 * 1024)
      }),
    )
  })

  it.instance("does not ask for external_directory when alias path is allowed", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return

      yield* TestInstance
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-grep-alias-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
      )
      const real = path.join(tmp, "real")
      const alias = path.join(tmp, "alias")
      yield* Effect.promise(() => fs.mkdir(real))
      yield* Effect.promise(() => fs.symlink(real, alias, "dir"))
      yield* Effect.promise(() => Bun.write(path.join(real, "test.txt"), "needle"))

      const ruleset = Permission.fromConfig({
        grep: "allow",
        external_directory: {
          [path.join(alias, "*")]: "allow",
        },
      })
      const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
      const next: Tool.Context = {
        ...ctx,
        ask: (req) =>
          Effect.sync(() => {
            const needsAsk = req.patterns.some(
              (pattern) => Permission.evaluate(req.permission, pattern, ruleset).action !== "allow",
            )
            if (needsAsk) requests.push(req)
          }),
      }

      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "needle",
          path: alias,
          include: "*.txt",
        },
        next,
      )

      expect(result.metadata.matches).toBe(1)
      expect(requests.find((req) => req.permission === "external_directory")).toBeUndefined()
    }),
  )

  scout.instance(
    "does not ask for external_directory permission inside configured git references",
    () =>
      Effect.gen(function* () {
        yield* TestInstance
        const appfs = yield* AppFileSystem.Service
        const cache = path.join(Global.Path.repos, "github.com", "opencode-grep-reference", "repo")
        yield* appfs.remove(cache, { recursive: true }).pipe(Effect.ignore)
        yield* Effect.addFinalizer(() => appfs.remove(cache, { recursive: true }).pipe(Effect.ignore))

        const source = yield* tmpdirScoped({ git: true })
        const remoteRoot = yield* tmpdirScoped()
        const remoteDir = path.join(remoteRoot, "opencode-grep-reference")
        const remoteRepo = path.join(remoteDir, "repo.git")
        yield* appfs.writeWithDirs(path.join(source, "src", "notes.md"), "needle\n")
        yield* git(source, ["add", "."])
        yield* git(source, ["commit", "-m", "add notes"])
        yield* appfs.makeDirectory(remoteDir, { recursive: true }).pipe(Effect.orDie)
        yield* git(remoteRoot, ["clone", "--bare", source, remoteRepo])

        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        const next: Tool.Context = {
          ...ctx,
          ask: (req) =>
            Effect.sync(() => {
              requests.push(req)
            }),
        }

        const info = yield* GrepTool
        const grep = yield* info.init()
        const result = yield* githubBase(
          `file://${remoteRoot}/`,
          grep.execute({ pattern: "needle", path: path.join(cache, "src"), include: "*.md" }, next),
        )

        expect(result.metadata.matches).toBe(1)
        expect(full(result.output)).toContain(full(path.join(cache, "src", "notes.md")))
        expect(requests.find((req) => req.permission === "external_directory")).toBeUndefined()
      }),
    {
      config: {
        reference: {
          docs: "opencode-grep-reference/repo",
        },
      },
    },
  )
})
