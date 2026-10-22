import { describe, expect } from "bun:test"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Cause, Effect, Exit, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Agent } from "@/agent/agent"
import { Ripgrep } from "@/file/ripgrep"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { ModelID, ProviderID } from "@/provider/schema"
import { Reference } from "@/reference/reference"
import { Instruction } from "@/session/instruction"
import type { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { writeTranscript } from "@/session/session-transcript"
import { assertExternalDirectoryEffect } from "@/tool/external-directory"
import { GrepTool } from "@/tool/grep"
import { ReadTool } from "@/tool/read"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Git.defaultLayer,
    Instruction.defaultLayer,
    LSP.defaultLayer,
    Reference.defaultLayer,
    Ripgrep.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
  ),
)

const fixture = Effect.fnUntraced(function* (provider: "codex" | "opencode" = "codex") {
  const cache = path.join(yield* tmpdirScoped(), "cache")
  const transcript = yield* Effect.promise(() =>
    writeTranscript(
      { source: provider, id: "referenced-session", title: "Referenced conversation" },
      [{ role: "user", text: "The selected transcript contains the reference-needle." }],
      cache,
    ),
  )
  return { cache, path: transcript.path }
})

function context(filepath: string, provider: "codex" | "opencode" = "codex", deny = "external_directory") {
  const sessionID = SessionID.make("ses_reference_read")
  const messageID = MessageID.ascending()
  const part: MessageV2.TextPart = {
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "text",
    synthetic: true,
    text: `Full filtered transcript: ${filepath}`,
    metadata: { sessionReference: { provider, id: "referenced-session", path: filepath } },
  }
  const requests: string[] = []
  const ctx: Tool.Context = {
    sessionID,
    messageID: MessageID.make("msg_reference_assistant"),
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [
      {
        info: {
          id: messageID,
          sessionID,
          role: "user",
          agent: "build",
          model: { modelID: ModelID.make("test"), providerID: ProviderID.make("test") },
          time: { created: 1 },
        },
        parts: [part],
      },
    ],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.sync(() => {
        requests.push(request.permission)
        if (request.permission === deny) throw new Error(`denied ${deny}`)
      }),
  }
  return { ctx, part, requests }
}

const read = Effect.fnUntraced(function* (filePath: string, ctx: Tool.Context) {
  const tool = yield* (yield* ReadTool).init()
  return yield* tool.execute({ filePath }, ctx)
})

const grep = Effect.fnUntraced(function* (filepath: string, ctx: Tool.Context) {
  const tool = yield* (yield* GrepTool).init()
  return yield* tool.execute({ pattern: "reference-needle", path: filepath }, ctx)
})

function denied<A, E, R>(effect: Effect.Effect<A, E, R>, permission = "external_directory") {
  return Effect.gen(function* () {
    const exit = yield* effect.pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain(`denied ${permission}`)
  })
}

describe("session reference read permissions", () => {
  for (const provider of ["codex", "opencode"] as const) {
    it.instance(`reads and greps the explicitly referenced ${provider} transcript without an external grant`, () =>
      Effect.gen(function* () {
        const transcript = yield* fixture(provider)
        const next = context(transcript.path, provider)

        expect((yield* read(transcript.path, next.ctx)).output).toContain("reference-needle")
        expect((yield* grep(transcript.path, next.ctx)).output).toContain("reference-needle")
        expect(next.requests).toEqual(["read", "grep"])
      }),
    )
  }

  if (process.platform === "win32") {
    it.instance("normalizes canonical Windows metadata separators and casing", () =>
      Effect.gen(function* () {
        const transcript = yield* fixture()
        const next = context(transcript.path.replaceAll("\\", "/").toLowerCase())
        expect((yield* read(transcript.path, next.ctx)).output).toContain("reference-needle")
        expect((yield* grep(transcript.path, next.ctx)).output).toContain("reference-needle")
        expect(next.requests).toEqual(["read", "grep"])
      }),
    )
  }

  it.instance("does not allow unrelated files in the same transcript cache", () =>
    Effect.gen(function* () {
      const transcript = yield* fixture()
      const next = context(transcript.path)
      const other = path.join(transcript.cache, "unrelated.md")
      yield* Effect.promise(() => Bun.write(other, "private reference-needle"))

      yield* denied(read(other, next.ctx))
      yield* denied(grep(other, next.ctx))
      expect(next.requests).toEqual(["external_directory", "grep", "external_directory"])
    }),
  )

  it.instance("never grants directory scope or access to non-read callers", () =>
    Effect.gen(function* () {
      const transcript = yield* fixture()
      const next = context(transcript.path)

      yield* denied(read(transcript.cache, next.ctx))
      yield* denied(grep(transcript.cache, next.ctx))
      yield* denied(assertExternalDirectoryEffect(next.ctx, transcript.path))
      yield* denied(assertExternalDirectoryEffect(next.ctx, transcript.path, { readOnly: false }))

      const directory = context(transcript.cache)
      yield* denied(assertExternalDirectoryEffect(directory.ctx, transcript.cache, { readOnly: true, kind: "file" }))
    }),
  )

  it.instance("still applies normal read and grep permissions to selected transcripts", () =>
    Effect.gen(function* () {
      const transcript = yield* fixture()
      const reader = context(transcript.path, "codex", "read")
      yield* denied(read(transcript.path, reader.ctx), "read")
      expect(reader.requests).toEqual(["read"])

      const searcher = context(transcript.path, "codex", "grep")
      yield* denied(grep(transcript.path, searcher.ctx), "grep")
      expect(searcher.requests).toEqual(["grep"])
    }),
  )

  it.instance("reads captured bytes when the cache path is swapped during read permission", () =>
    Effect.gen(function* () {
      const transcript = yield* fixture()
      const next = context(transcript.path)
      const secret = path.join(transcript.cache, "substituted.md")
      yield* Effect.promise(() => Bun.write(secret, "private-substituted-contents"))
      const ask = next.ctx.ask
      next.ctx.ask = (request) =>
        Effect.gen(function* () {
          yield* ask(request)
          if (request.permission !== "read") return
          yield* Effect.promise(() => fs.unlink(transcript.path))
          yield* Effect.promise(() => fs.symlink(secret, transcript.path))
        })

      const result = yield* read(transcript.path, next.ctx)
      expect(result.output).toContain("The selected transcript contains the reference-needle.")
      expect(result.output).not.toContain("private-substituted-contents")
      expect(result.metadata.loaded).toEqual([])
      expect(next.requests).toEqual(["read"])
    }),
  )

  it.instance("greps captured bytes even if the path changes before ripgrep starts", () =>
    Effect.gen(function* () {
      const transcript = yield* fixture()
      const next = context(transcript.path)
      const rg = yield* Ripgrep.Service
      const result = yield* grep(transcript.path, next.ctx).pipe(
        Effect.provideService(Ripgrep.Service, {
          ...rg,
          search: (input) =>
            Effect.gen(function* () {
              expect(input.stdin).toContain("The selected transcript")
              const secret = path.join(transcript.cache, "substituted.md")
              yield* Effect.promise(() => Bun.write(secret, "private-substituted-contents reference-needle"))
              yield* Effect.promise(() => fs.unlink(transcript.path))
              yield* Effect.promise(() => fs.symlink(secret, transcript.path))
              return yield* rg.search(input)
            }),
        }),
      )
      expect(result.output).toContain(transcript.path)
      expect(result.output).toContain("The selected transcript contains the reference-needle.")
      expect(result.output).not.toContain("private-substituted-contents")
      expect(next.requests).toEqual(["grep"])
    }),
  )

  it.instance("bounds captured-stdin grep with context without a pipe failure", () =>
    Effect.gen(function* () {
      const cache = yield* tmpdirScoped()
      const transcript = yield* Effect.promise(() =>
        writeTranscript(
          { source: "codex", id: "referenced-session", title: "Large reference" },
          [{ role: "assistant", text: "reference-needle\n".repeat(100_000) }],
          cache,
        ),
      )
      const next = context(transcript.path)
      const tool = yield* (yield* GrepTool).init()
      const result = yield* tool.execute({ pattern: "^reference-[a-z]+$", path: transcript.path, context: 1 }, next.ctx)
      expect(result.metadata.truncated).toBe(true)
      expect(result.metadata.matches).toBeGreaterThanOrEqual(100)
      expect(result.output).toContain(transcript.path)
      expect(result.output).toContain("reference-needle")
      expect(result.output).toContain("Results truncated")
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(50 * 1024)
      expect(next.requests).toEqual(["grep"])
    }),
  )

  it.instance("rejects modified contents even when the referenced pathname has not changed", () =>
    Effect.gen(function* () {
      const transcript = yield* fixture()
      const next = context(transcript.path)
      yield* Effect.promise(() => Bun.write(transcript.path, "private-modified-contents reference-needle"))
      yield* denied(read(transcript.path, next.ctx))
      yield* denied(grep(transcript.path, next.ctx))
    }),
  )

  it.instance("restores only stored user reference grants after context compaction", () =>
    Effect.gen(function* () {
      for (const provider of ["codex", "opencode"] as const) {
        const transcript = yield* fixture(provider)
        const session = yield* Effect.acquireRelease(Session.use.create(), (session) =>
          Session.use.remove(session.id).pipe(Effect.ignore),
        )
        const next = context(transcript.path, provider)
        yield* Session.use.updateMessage({ ...next.ctx.messages[0].info, sessionID: session.id })
        const part = { ...next.part, sessionID: session.id }
        yield* Session.use.updatePart(part)
        next.ctx.sessionID = session.id
        next.ctx.messages = []

        expect((yield* read(transcript.path, next.ctx)).output).toContain("reference-needle")
        expect((yield* grep(transcript.path, next.ctx)).output).toContain("reference-needle")
        expect(next.requests).toEqual(["read", "grep"])
        yield* denied(read(transcript.path, { ...next.ctx, sessionID: SessionID.make("ses_other") }))

        yield* Session.use.updatePart({ ...part, ignored: true })
        yield* denied(read(transcript.path, next.ctx))
        yield* Session.use.updatePart({ ...part, synthetic: false })
        yield* denied(grep(transcript.path, next.ctx))
      }
    }),
  )

  it.instance("does not grant files without a provider-matching content hash name", () =>
    Effect.gen(function* () {
      const transcript = yield* fixture()
      yield* denied(read(transcript.path, context(transcript.path, "opencode").ctx))
      const plain = path.join(transcript.cache, "transcript.md")
      yield* Effect.promise(() => Bun.write(plain, "reference-needle"))
      yield* denied(read(plain, context(plain).ctx))
    }),
  )

  it.instance("requires a valid synthetic reference in a current-session user message", () =>
    Effect.gen(function* () {
      const transcript = yield* fixture()
      for (const change of [
        { synthetic: false },
        { ignored: true },
        { metadata: undefined },
        { metadata: { sessionReference: { provider: "other", id: "id", path: transcript.path } } },
        { metadata: { sessionReference: { provider: "codex", path: transcript.path } } },
        { metadata: { sessionReference: { provider: "codex", id: " ", path: transcript.path } } },
        { sessionID: SessionID.make("ses_other") },
        { messageID: MessageID.make("msg_other") },
      ]) {
        const next = context(transcript.path)
        next.ctx.messages[0].parts = [{ ...next.part, ...change }]
        yield* denied(assertExternalDirectoryEffect(next.ctx, transcript.path, { readOnly: true }))
      }
      const empty = context(transcript.path)
      empty.ctx.messages = []
      yield* denied(assertExternalDirectoryEffect(empty.ctx, transcript.path, { readOnly: true }))

      const assistant = context(transcript.path)
      assistant.ctx.messages[0].info = {
        id: assistant.part.messageID,
        sessionID: assistant.ctx.sessionID,
        role: "assistant",
        agent: "build",
        mode: "build",
        parentID: MessageID.make("msg_user"),
        modelID: ModelID.make("test"),
        providerID: ProviderID.make("test"),
        path: { cwd: "/fixture", root: "/fixture" },
        time: { created: 1 },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      yield* denied(assertExternalDirectoryEffect(assistant.ctx, transcript.path, { readOnly: true }))
    }),
  )

  for (const kind of ["file", "directory"] as const) {
    it.instance(`rejects ${kind} symlink substitution of the referenced transcript`, () =>
      Effect.gen(function* () {
        const transcript = yield* fixture()
        const next = context(transcript.path)
        if (kind === "file") {
          const secret = path.join(transcript.cache, "secret.md")
          yield* Effect.promise(() => Bun.write(secret, "private reference-needle"))
          yield* Effect.promise(() => fs.unlink(transcript.path))
          yield* Effect.promise(() => fs.symlink(secret, transcript.path))
        } else {
          const redirected = transcript.cache + "-redirected"
          yield* Effect.promise(() => fs.mkdir(redirected))
          yield* Effect.promise(() =>
            Bun.write(path.join(redirected, path.basename(transcript.path)), "private reference-needle"),
          )
          yield* Effect.promise(() => fs.rename(transcript.cache, transcript.cache + "-original"))
          yield* Effect.promise(() => fs.symlink(redirected, transcript.cache, "dir"))
        }

        yield* denied(read(transcript.path, next.ctx))
        yield* denied(grep(transcript.path, next.ctx))
        expect(next.requests.filter((request) => request === "external_directory")).toHaveLength(2)
      }),
    )
  }
})
