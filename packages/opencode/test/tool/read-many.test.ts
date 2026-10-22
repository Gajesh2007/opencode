import { describe, expect } from "bun:test"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import path from "path"
import { Agent } from "@/agent/agent"
import { LSP } from "@/lsp/lsp"
import { Permission } from "@/permission"
import { Reference } from "@/reference/reference"
import { ModelID, ProviderID } from "@/provider/schema"
import { Instruction } from "@/session/instruction"
import type { MessageV2 } from "@/session/message-v2"
import { ReadTool } from "@/tool/read"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ReadManyTool } from "@/tool/read-many"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Instruction.defaultLayer,
    LSP.defaultLayer,
    Permission.defaultLayer,
    Reference.defaultLayer,
    Truncate.defaultLayer,
  ),
)

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_read_many"),
  messageID: MessageID.make("msg_read_many"),
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.die(new Error("individual reads must not overwrite batch metadata")),
  ask: () => Effect.void,
}

const run = Effect.fn("ReadManyTest.run")(function* (
  files: Tool.InferParameters<typeof ReadManyTool>["files"],
  next: Tool.Context = ctx,
) {
  const tool = yield* (yield* ReadManyTool).init()
  return yield* tool.execute({ files }, next)
})

const orderedInstructions = Effect.fn("ReadManyTest.orderedInstructions")(function* (filepath: string) {
  const instruction = yield* Instruction.Service
  const first = yield* Deferred.make<void>()
  return Instruction.Service.of({
    ...instruction,
    resolve: (...args) =>
      Effect.gen(function* () {
        if (args[1] !== filepath) {
          yield* awaitWithTimeout(Deferred.await(first), `Expected ${filepath} to resolve before ${args[1]}`).pipe(
            Effect.orDie,
          )
        }
        const result = yield* instruction.resolve(...args)
        if (args[1] === filepath) yield* Deferred.succeed(first, undefined)
        return result
      }),
  })
})

describe("tool.read_many", () => {
  it.instance("declares read-only execution", () =>
    Effect.gen(function* () {
      const tool = yield* (yield* ReadManyTool).init()
      expect(tool.readOnly).toBe(true)
    }),
  )

  it.instance("reads known ranges and directories in input order, including repeated paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const filepath = path.join(test.directory, "lines.txt")
      yield* fs.writeFileString(filepath, "one\ntwo\nthree\nfour\nfive")
      yield* fs.writeWithDirs(path.join(test.directory, "dir", "entry.txt"), "entry")

      const result = yield* run([
        { filePath: filepath, offset: 2, limit: 2 },
        { filePath: "dir", limit: 1 },
        { filePath: filepath, offset: 5, limit: 1 },
      ])

      expect(result.output).toContain("2: two\n3: three")
      expect(result.output).not.toContain("4: four")
      expect(result.output).toContain("entry.txt")
      expect(result.output).toContain("5: five")
      expect(result.output.indexOf("[1] success:")).toBeLessThan(result.output.indexOf("[2] success:"))
      expect(result.output.indexOf("[2] success:")).toBeLessThan(result.output.indexOf("[3] success:"))
      expect(result.metadata.results.map((item) => item.status)).toEqual(["success", "success", "success"])
      expect(result.metadata.results.map((item) => item.truncated)).toEqual([true, false, false])
    }),
  )

  it.instance("defaults to 200 lines and preserves zero-limit and empty-file behavior", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const filepath = path.join(test.directory, "many.txt")
      yield* fs.writeFileString(filepath, Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n"))
      yield* fs.writeFileString(path.join(test.directory, "empty.txt"), "")

      const result = yield* run([
        { filePath: filepath },
        { filePath: filepath, offset: 0, limit: 0 },
        { filePath: "empty.txt" },
      ])

      expect(result.output).toContain("200: line 200")
      expect(result.output).not.toContain("201: line 201")
      expect(result.output).toContain("Use offset=201")
      expect(result.output).toContain("End of file - total 0 lines")
      expect(result.metadata.results).toMatchObject([
        { limit: 200, offset: 1, status: "success", truncated: true },
        { limit: 0, offset: 1, status: "success", truncated: true },
        { limit: 200, offset: 1, status: "success", truncated: false },
      ])
    }),
  )

  it.instance("retains successes alongside missing-file suggestions and out-of-range errors", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const filepath = path.join(test.directory, "notes.txt")
      yield* fs.writeFileString(filepath, "retained content")

      const result = yield* run([
        { filePath: "notes.tx" },
        { filePath: filepath },
        { filePath: filepath, offset: 2 },
        { filePath: "absent/directory/file.txt" },
      ])

      expect(result.output).toContain("File not found:")
      expect(result.output).toContain("Did you mean one of these?")
      expect(result.output).toContain(filepath)
      expect(result.output).toContain("retained content")
      expect(result.output).toContain("Offset 2 is out of range for this file (1 lines)")
      expect(result.metadata.results.map((item) => item.status)).toEqual(["error", "success", "error", "error"])
    }),
  )

  it.instance(
    "enforces real read-deny rules for every file without hiding allowed siblings",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* AppFileSystem.Service
        const permission = yield* Permission.Service
        yield* fs.writeFileString(path.join(test.directory, "public.txt"), "public content")
        yield* fs.writeFileString(path.join(test.directory, "secret.txt"), "private content")
        const asked: string[] = []
        const ruleset = Permission.fromConfig({ read: { "*": "allow", "secret.txt": "deny" } })
        const result = yield* run(
          [{ filePath: "secret.txt" }, { filePath: "public.txt" }, { filePath: "secret.txt" }],
          {
            ...ctx,
            ask: (request) =>
              Effect.gen(function* () {
                asked.push(...request.patterns)
                yield* permission.ask({ ...request, sessionID: ctx.sessionID, ruleset }).pipe(Effect.orDie)
              }),
          },
        )

        expect(asked.filter((item) => item === "secret.txt")).toHaveLength(2)
        expect(result.metadata.results.map((item) => item.status)).toEqual(["error", "success", "error"])
        expect(result.output).toContain("The user has specified a rule")
        expect(result.output).toContain("public content")
        expect(result.output).not.toContain("private content")

        const denied = yield* run([{ filePath: "secret.txt" }, { filePath: "public.txt" }], {
          ...ctx,
          ask: (request) =>
            permission
              .ask({ ...request, sessionID: ctx.sessionID, ruleset: Permission.fromConfig({ read: "deny" }) })
              .pipe(Effect.orDie),
        })
        expect(denied.metadata.results.map((item) => item.status)).toEqual(["error", "error"])
        expect(denied.output).not.toContain("public content")
      }),
    { git: true },
  )

  it.instance(
    "preserves external-directory checks and the existing bypass context",
    () =>
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const permission = yield* Permission.Service
        const outer = yield* tmpdirScoped()
        const filepath = path.join(outer, "outside.txt")
        yield* fs.writeFileString(filepath, "outside content")
        const asked: string[] = []
        const next = {
          ...ctx,
          ask: (request: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
            Effect.gen(function* () {
              asked.push(request.permission)
              yield* permission
                .ask({
                  ...request,
                  sessionID: ctx.sessionID,
                  ruleset: Permission.fromConfig({ external_directory: "deny", read: "allow" }),
                })
                .pipe(Effect.orDie)
            }),
        }

        const denied = yield* run([{ filePath: filepath }], next)
        expect(denied.metadata.results[0].status).toBe("error")
        expect(denied.output).not.toContain("outside content")
        expect(asked).toEqual(["external_directory"])

        const allowed = yield* run([{ filePath: filepath }], { ...next, extra: { bypassCwdCheck: true } })
        expect(allowed.metadata.results[0].status).toBe("success")
        expect(allowed.output).toContain("outside content")
        expect(asked).toEqual(["external_directory", "read"])
      }),
    { git: true },
  )

  it.instance("loads nearby instructions once and preserves them when file contents are capped", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const instructions = path.join(test.directory, "nested", "AGENTS.md")
      yield* fs.writeWithDirs(
        instructions,
        "# Nearby instructions\nKeep these instructions visible.\n\n<system-reminder>\nNested example\n</system-reminder>",
      )
      yield* fs.writeFileString(path.join(test.directory, "nested", "one.txt"), `${"x".repeat(1500)}\n`.repeat(100))
      yield* fs.writeFileString(
        path.join(test.directory, "nested", "two.txt"),
        `second file\n${`${"y".repeat(1500)}\n`.repeat(100)}`,
      )

      const result = yield* run([{ filePath: "nested/one.txt" }, { filePath: "nested/two.txt" }])

      expect(result.metadata.loaded).toEqual([instructions])
      expect(result.metadata.results[0].loaded).toEqual([instructions])
      expect(result.metadata.results[1].loaded).toEqual([])
      expect(result.output).toContain("# Nearby instructions")
      expect(result.output.match(/Keep these instructions visible\./g)).toHaveLength(1)
      expect(result.output).toContain("</system-reminder>\n\n<path>")
      expect(result.output).toContain("<system-reminder>")
      expect(result.output).toContain("</system-reminder>")
      expect(result.output).toContain("second file")
      expect(result.metadata.truncated).toBe(true)
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(50 * 1024)
    }),
  )

  it.instance("releases oversized nested instructions for a direct read in the same message", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const instructions = `${"instruction\n".repeat(10_000)}Critical instruction at the very end.`
      yield* fs.writeWithDirs(path.join(test.directory, "nested", "AGENTS.md"), instructions)
      yield* fs.writeWithDirs(path.join(test.directory, "nested", "deeper", "AGENTS.md"), "Deeper instruction.")
      yield* fs.writeFileString(path.join(test.directory, "nested", "deeper", "file.txt"), "small file")

      const result = yield* run([{ filePath: "nested/deeper/file.txt" }])

      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(50 * 1024)
      expect(result.output).toContain("omitted instructions")
      expect(result.metadata.truncated).toBe(true)
      expect(result.metadata.loaded).toEqual([])
      expect(result.metadata.results[0].loaded).toEqual([])

      const read = yield* (yield* ReadTool).init()
      const direct = yield* read.execute({ filePath: "nested/deeper/file.txt" }, ctx)
      expect(direct.output).toContain(instructions)
      expect(direct.output).toContain("Deeper instruction.")
      expect(direct.metadata.loaded).toEqual([
        path.join(test.directory, "nested", "deeper", "AGENTS.md"),
        path.join(test.directory, "nested", "AGENTS.md"),
      ])
    }),
  )

  for (const entry of [
    { name: "image.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    { name: "document.pdf", content: Buffer.from("%PDF-1.4") },
    { name: "binary.bin", content: Buffer.from([65, 0, 66]) },
    { name: "short.txt", content: Buffer.from("one line"), offset: 2 },
  ]) {
    it.instance(`releases instructions after a failed ${entry.name} read`, () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* AppFileSystem.Service
        const instructions = "Critical instructions must survive failed reads."
        yield* fs.writeWithDirs(path.join(test.directory, "nested", "AGENTS.md"), instructions)
        yield* fs.writeFile(path.join(test.directory, "nested", entry.name), entry.content)
        yield* fs.writeFileString(path.join(test.directory, "nested", "ok.txt"), "text content")

        const result = yield* run([{ filePath: `nested/${entry.name}`, offset: entry.offset }])
        expect(result.metadata.results[0].status).toBe("error")
        expect(result.metadata.loaded).toEqual([])

        const read = yield* (yield* ReadTool).init()
        const direct = yield* read.execute({ filePath: "nested/ok.txt" }, ctx)
        expect(direct.output).toContain(instructions)
        expect(direct.metadata.loaded).toEqual([path.join(test.directory, "nested", "AGENTS.md")])
      }),
    )
  }

  for (const oversized of [false, true]) {
    it.instance(
      `preserves a failing owner's shared guidance${oversized ? " with an explicit budget warning" : ""}`,
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const fs = yield* AppFileSystem.Service
          const filepath = path.join(test.directory, "nested", "AGENTS.md")
          const instructions = oversized
            ? `${"Shared guidance.\n".repeat(4000)}Critical final guidance.`
            : "Critical shared guidance."
          yield* fs.writeWithDirs(filepath, instructions)
          yield* fs.writeFile(path.join(test.directory, "nested", "bad.bin"), Buffer.from("PRIVATE_REJECTED_DATA\0"))
          yield* fs.writeFileString(path.join(test.directory, "nested", "good.txt"), "successful sibling")

          const result = yield* run([{ filePath: "nested/bad.bin" }, { filePath: "nested/good.txt" }]).pipe(
            Effect.provideService(
              Instruction.Service,
              yield* orderedInstructions(path.join(test.directory, "nested", "bad.bin")),
            ),
          )

          expect(result.output).toContain("successful sibling")
          expect(result.metadata.results.map((item) => item.status)).toEqual(["error", "success"])
          expect(JSON.stringify(result)).not.toContain("PRIVATE_REJECTED_DATA")
          expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(50 * 1024)
          if (!oversized) {
            expect(result.output).toContain(instructions)
            expect(result.metadata.loaded).toEqual([filepath])
            expect(result.metadata.results[1].loaded).toEqual([filepath])
            expect(result.metadata.truncated).toBe(false)
          }
          if (oversized) {
            expect(result.output).toContain("omitted instructions")
            expect(result.metadata.results[1].truncated).toBe(true)
            expect(result.metadata.loaded).toEqual([])
            const read = yield* (yield* ReadTool).init()
            const direct = yield* read.execute({ filePath: "nested/good.txt" }, ctx)
            expect(direct.output).toContain(instructions)
          }
        }),
    )
  }

  it.instance("lets a sibling return guidance that did not fit its first owner's section", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const filepath = path.join(test.directory, "nested", "AGENTS.md")
      const first = `nested/${"x".repeat(230)}.txt`
      const instructions = `${"g".repeat(25_290 - Buffer.byteLength(`Instructions from: ${filepath}\n`))}\nCritical shared guidance.`
      yield* fs.writeWithDirs(filepath, instructions)
      yield* fs.writeFileString(path.join(test.directory, first), "large content\n".repeat(5000))
      yield* fs.writeFileString(path.join(test.directory, "nested", "good.txt"), "successful sibling")

      const result = yield* run([{ filePath: first }, { filePath: "nested/good.txt" }]).pipe(
        Effect.provideService(Instruction.Service, yield* orderedInstructions(path.join(test.directory, first))),
      )

      expect(result.metadata.results.map((item) => item.status)).toEqual(["success", "success"])
      expect(result.metadata.results[0].loaded).toEqual([])
      expect(result.metadata.results[0].truncated).toBe(true)
      expect(result.metadata.results[1].loaded).toEqual([filepath])
      expect(result.metadata.loaded).toEqual([filepath])
      expect(result.output.slice(result.output.indexOf("[2] success:"))).toContain(instructions)
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(50 * 1024)
    }),
  )

  it.instance("does not expose rejected-file data or unrelated private instructions", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      yield* fs.writeWithDirs(path.join(test.directory, "private", "AGENTS.md"), "PRIVATE_UNRELATED_GUIDANCE")
      yield* fs.writeFile(path.join(test.directory, "private", "bad.bin"), Buffer.from("PRIVATE_REJECTED_DATA\0"))
      yield* fs.writeFileString(path.join(test.directory, "good.txt"), "public sibling")

      const result = yield* run([{ filePath: "private/bad.bin" }, { filePath: "good.txt" }]).pipe(
        Effect.provideService(
          Instruction.Service,
          yield* orderedInstructions(path.join(test.directory, "private", "bad.bin")),
        ),
      )

      expect(result.metadata.results.map((item) => item.status)).toEqual(["error", "success"])
      expect(result.output).toContain("public sibling")
      expect(JSON.stringify(result)).not.toContain("PRIVATE_REJECTED_DATA")
      expect(JSON.stringify(result)).not.toContain("PRIVATE_UNRELATED_GUIDANCE")
      expect(result.metadata.loaded).toEqual([])
    }),
  )

  it.instance("keeps delivered claims and recognizes completed batches in later messages", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const filepath = path.join(test.directory, "nested", "AGENTS.md")
      yield* fs.writeWithDirs(filepath, "Previously delivered instructions.")
      yield* fs.writeFileString(path.join(test.directory, "nested", "file.txt"), "content")
      const result = yield* run([{ filePath: "nested/file.txt" }])
      expect(result.metadata.loaded).toEqual([filepath])

      const read = yield* (yield* ReadTool).init()
      const same = yield* read.execute({ filePath: "nested/file.txt" }, ctx)
      expect(same.metadata.loaded).toEqual([])

      const messages: MessageV2.WithParts[] = [
        {
          info: {
            id: ctx.messageID,
            sessionID: ctx.sessionID,
            role: "user",
            agent: ctx.agent,
            time: { created: 0 },
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
          },
          parts: [
            {
              id: PartID.make("prt_read_many"),
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              type: "tool",
              tool: "read_many",
              callID: "read_many",
              state: {
                status: "completed",
                input: { files: [{ filePath: "nested/file.txt" }] },
                output: result.output,
                title: result.title,
                metadata: { ...result.metadata, loaded: [filepath, null, 42] },
                time: { start: 0, end: 1 },
              },
            },
          ],
        },
      ]
      expect([...Instruction.loaded(messages)]).toEqual([filepath])
      const next = yield* read.execute(
        { filePath: "nested/file.txt" },
        {
          ...ctx,
          messageID: MessageID.make("msg_read_many_next"),
          messages,
        },
      )
      expect(next.metadata.loaded).toEqual([])
      expect(next.output).not.toContain("Previously delivered instructions.")
    }),
  )

  it.instance("does not release another in-flight read's instruction claims", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const filepath = path.join(test.directory, "nested", "held.txt")
      const instructions = `${"large instruction\n".repeat(5000)}Critical last instruction.`
      yield* fs.writeWithDirs(path.join(test.directory, "nested", "AGENTS.md"), "Held by a different read.")
      yield* fs.writeWithDirs(path.join(test.directory, "nested", "deeper", "AGENTS.md"), instructions)
      yield* fs.writeFileString(filepath, "held content")
      yield* fs.writeFileString(path.join(test.directory, "nested", "other.txt"), "other content")
      yield* fs.writeFileString(path.join(test.directory, "nested", "deeper", "file.txt"), "deep content")
      const read = yield* (yield* ReadTool.pipe(
        Effect.provideService(AppFileSystem.Service, {
          ...fs,
          stream: (target, options) =>
            target === filepath
              ? Stream.unwrap(
                  Deferred.succeed(ready, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.as(fs.stream(target, options)),
                  ),
                )
              : fs.stream(target, options),
        }),
      )).init()
      const pending = yield* read.execute({ filePath: filepath }, ctx).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(ready), "direct read did not acquire its instructions")

      const result = yield* run([{ filePath: "nested/deeper/file.txt" }])
      expect(result.metadata.loaded).toEqual([])
      const other = yield* read.execute({ filePath: "nested/other.txt" }, ctx)
      expect(other.metadata.loaded).toEqual([])
      expect(other.output).not.toContain("Held by a different read.")
      const deep = yield* read.execute({ filePath: "nested/deeper/file.txt" }, ctx)
      expect(deep.output).toContain(instructions)
      expect(deep.metadata.loaded).toEqual([path.join(test.directory, "nested", "deeper", "AGENTS.md")])

      yield* Deferred.succeed(release, undefined)
      const held = yield* Fiber.join(pending)
      expect(held.output).toContain("Held by a different read.")
    }),
  )

  for (const interrupt of [false, true]) {
    it.instance(
      `releases acquired instructions after ${interrupt ? "parent interruption" : "signal cancellation"}`,
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const fs = yield* AppFileSystem.Service
          const abort = new AbortController()
          const ready = yield* Deferred.make<void>()
          const filepath = path.join(test.directory, "nested", "file.txt")
          yield* fs.writeWithDirs(path.join(test.directory, "nested", "AGENTS.md"), "Critical after cancellation.")
          yield* fs.writeFileString(filepath, "content")
          const pending = yield* run([{ filePath: filepath }], { ...ctx, abort: abort.signal }).pipe(
            Effect.provideService(AppFileSystem.Service, {
              ...fs,
              stream: (target, options) =>
                target === filepath
                  ? Stream.unwrap(Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)))
                  : fs.stream(target, options),
            }),
            Effect.forkChild,
          )
          yield* awaitWithTimeout(Deferred.await(ready), "batch read did not acquire its instructions")
          if (interrupt) yield* Fiber.interrupt(pending)
          if (!interrupt) abort.abort()
          const exit = yield* awaitWithTimeout(Fiber.await(pending), "batch did not finish cancellation")
          if (interrupt) {
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
          }
          if (!interrupt) {
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) expect(exit.value.metadata.results[0].status).toBe("cancelled")
          }

          const read = yield* (yield* ReadTool).init()
          const direct = yield* read.execute({ filePath: filepath }, ctx)
          expect(direct.output).toContain("Critical after cancellation.")
          expect(direct.metadata.loaded).toEqual([path.join(test.directory, "nested", "AGENTS.md")])
        }),
    )
  }

  it.instance("rejects binary files and sniffed attachments without loading their full payloads", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      yield* fs.writeFile(path.join(test.directory, "null.txt"), Buffer.from([65, 0, 66]))
      yield* fs.writeFileString(path.join(test.directory, "module.wasm"), "binary extension")
      yield* fs.writeFile(
        path.join(test.directory, "renamed.bin"),
        Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1024 * 1024)]),
      )
      yield* fs.writeFileString(path.join(test.directory, "renamed.txt"), `%PDF-1.4\n${"x".repeat(1024 * 1024)}`)
      yield* fs.writeFileString(path.join(test.directory, "ok.txt"), "text survives")
      const reads: string[] = []

      const result = yield* run([
        { filePath: "null.txt" },
        { filePath: "module.wasm" },
        { filePath: "renamed.bin" },
        { filePath: "renamed.txt" },
        { filePath: "ok.txt" },
      ]).pipe(
        Effect.provideService(AppFileSystem.Service, {
          ...fs,
          readFile: (filepath) => {
            reads.push(filepath)
            return fs.readFile(filepath)
          },
        }),
      )

      expect(reads).toEqual([])
      expect(result.metadata.results.map((item) => item.status)).toEqual([
        "error",
        "error",
        "error",
        "error",
        "success",
      ])
      expect(result.output).toContain("Cannot read binary file:")
      expect(result.output.match(/does not support image or PDF attachments/g)).toHaveLength(2)
      expect(result.output).toContain("Use read instead.")
      expect(result.output).toContain("text survives")
      expect(result).not.toHaveProperty("attachments")
    }),
  )

  it.instance("caps aggregate UTF-8 output while retaining all labels and a final missing-file error", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const filepath = path.join(test.directory, "large.txt")
      yield* fs.writeFileString(filepath, `${String.fromCodePoint(0x1f600).repeat(900)}\n`.repeat(100))

      const result = yield* run([
        ...Array.from({ length: 15 }, () => ({ filePath: filepath })),
        { filePath: "missing-last.txt" },
      ])

      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(50 * 1024)
      expect(result.output).not.toContain("\ufffd")
      expect(result.output).toContain("read_many output capped")
      expect(result.output).toContain("[16] error:")
      expect(result.output).toContain("File not found:")
      expect(result.metadata.results).toHaveLength(16)
      expect(result.metadata.truncated).toBe(true)
      for (let i = 1; i <= 15; i++) expect(result.output).toContain(`[${i}] success:`)
    }),
  )

  it.instance("runs concurrently with no more than eight reads awaiting permission", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const files = Array.from({ length: 16 }, (_, i) => ({ filePath: path.join(test.directory, `${i}.txt`) }))
      yield* Effect.forEach(files, (file) => fs.writeFileString(file.filePath, file.filePath))
      const counts = { active: 0, peak: 0, total: 0 }
      const fiber = yield* run(files, {
        ...ctx,
        ask: () =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              counts.active++
              counts.total++
              counts.peak = Math.max(counts.peak, counts.active)
            }),
            () =>
              Effect.gen(function* () {
                if (counts.active === 8) yield* Deferred.succeed(ready, undefined)
                yield* Deferred.await(release)
              }),
            () =>
              Effect.sync(() => {
                counts.active--
              }),
          ),
      }).pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "eight concurrent reads did not start")
      yield* Effect.yieldNow
      expect(counts.total).toBe(8)
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(fiber)

      expect(counts).toEqual({ active: 0, peak: 8, total: 16 })
      expect(result.metadata.results.map((item) => item.filePath)).toEqual(files.map((file) => file.filePath))
      expect(result.metadata.results.every((item) => item.status === "success")).toBe(true)
    }),
  )

  it.instance("distinguishes an individual interruption from errors without cancelling siblings", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      yield* fs.writeFileString(path.join(test.directory, "cancel.txt"), "not read")
      yield* fs.writeFileString(path.join(test.directory, "ok.txt"), "still read")

      const result = yield* run([{ filePath: "cancel.txt" }, { filePath: "ok.txt" }, { filePath: "missing.txt" }], {
        ...ctx,
        ask: (request) => (request.patterns[0].endsWith("cancel.txt") ? Effect.interrupt : Effect.void),
      })

      expect(result.metadata.results.map((item) => item.status)).toEqual(["cancelled", "success", "error"])
      expect(result.output).toContain("Read cancelled.")
      expect(result.output).toContain("still read")
      expect(result.output).not.toContain("not read")
    }),
  )

  it.instance("does not start reads when the context is already aborted", () =>
    Effect.gen(function* () {
      const abort = new AbortController()
      abort.abort()
      const result = yield* run([{ filePath: "missing.txt" }, { filePath: "also-missing.txt" }], {
        ...ctx,
        abort: abort.signal,
        ask: () => Effect.die(new Error("must not ask after cancellation")),
      })

      expect(result.metadata.results.map((item) => item.status)).toEqual(["cancelled", "cancelled"])
      expect(result.output).not.toContain("File not found")
    }),
  )

  it.instance("aborts active and queued reads while retaining earlier successes and errors", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const abort = new AbortController()
      const ready = yield* Deferred.make<void>()
      const blocked = Array.from({ length: 10 }, (_, i) => ({ filePath: `blocked-${i}.txt` }))
      yield* fs.writeFileString(path.join(test.directory, "ok.txt"), "completed before abort")
      yield* Effect.forEach(blocked, (file) => fs.writeFileString(path.join(test.directory, file.filePath), "blocked"))
      const waiting: string[] = []
      const counts = { active: 0 }
      const fiber = yield* run([{ filePath: "ok.txt" }, { filePath: "missing.txt" }, ...blocked], {
        ...ctx,
        abort: abort.signal,
        ask: (request) =>
          Effect.gen(function* () {
            if (!request.patterns[0].includes("blocked-")) return
            waiting.push(request.patterns[0])
            counts.active++
            yield* Effect.gen(function* () {
              if (waiting.length === 8) yield* Deferred.succeed(ready, undefined)
              yield* Effect.never
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  counts.active--
                }),
              ),
            )
          }),
      }).pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "active reads did not reach the permission gate")
      abort.abort()
      const result = yield* awaitWithTimeout(Fiber.join(fiber), "read_many did not observe cancellation")

      expect(waiting).toHaveLength(8)
      expect(counts.active).toBe(0)
      expect(result.metadata.results.map((item) => item.status)).toEqual([
        "success",
        "error",
        ...Array.from({ length: 10 }, () => "cancelled" as const),
      ])
      expect(result.output).toContain("completed before abort")
      expect(result.output).toContain("File not found:")
    }),
  )

  it.instance("does not turn parent-fiber interruption into a successful batch", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      yield* fs.writeFileString(path.join(test.directory, "blocked.txt"), "not read")
      const ready = yield* Deferred.make<void>()
      const fiber = yield* run([{ filePath: "blocked.txt" }], {
        ...ctx,
        ask: () => Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
      }).pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "read did not start")
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }),
  )

  it.instance("rejects invalid batch sizes and ranges before asking for permission", () =>
    Effect.gen(function* () {
      const invalid = [
        [],
        Array.from({ length: 17 }, () => ({ filePath: "file.txt" })),
        [{ filePath: "file.txt", offset: -1 }],
        [{ filePath: "file.txt", limit: 1.5 }],
      ]
      for (const files of invalid) {
        const exit = yield* run(files, {
          ...ctx,
          ask: () => Effect.die(new Error("invalid arguments must not request permission")),
        }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Tool.InvalidArgumentsError)
      }
    }),
  )
})
