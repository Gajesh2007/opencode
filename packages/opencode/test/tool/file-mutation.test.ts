import { describe, expect } from "bun:test"
import { statSync } from "node:fs"
import path from "path"
import { Cause, Effect, Exit, Fiber, Latch, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { MessageID, SessionID } from "@/session/schema"
import { ApplyPatchTool } from "@/tool/apply_patch"
import { EditTool } from "@/tool/edit"
import { FileMutation } from "@/tool/file-mutation"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { WriteTool } from "@/tool/write"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    AppFileSystem.defaultLayer,
    Agent.defaultLayer,
    Bus.layer,
    Format.defaultLayer,
    LSP.defaultLayer,
    Truncate.defaultLayer,
  ),
)

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_file-mutation"),
  messageID: MessageID.make("msg_file-mutation"),
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const init = Effect.gen(function* () {
  return {
    patch: yield* (yield* ApplyPatchTool).init(),
    edit: yield* (yield* EditTool).init(),
    write: yield* (yield* WriteTool).init(),
  }
})

const approval = Effect.gen(function* () {
  const entered = yield* Latch.make()
  const proceed = yield* Latch.make()
  const calls: Parameters<Tool.Context["ask"]>[0][] = []
  return {
    entered,
    proceed,
    calls,
    ctx: {
      ...ctx,
      ask: (input: Parameters<Tool.Context["ask"]>[0]) =>
        Effect.gen(function* () {
          calls.push(input)
          yield* entered.open
          yield* proceed.await
        }),
    },
  }
})

const expectLocked = Effect.fn("FileMutationTest.expectLocked")(function* (paths: string[]) {
  let entered = false
  const probe = yield* FileMutation.withLocks(
    paths,
    Effect.sync(() => {
      entered = true
    }),
  ).pipe(Effect.forkScoped({ startImmediately: true }))
  expect(entered).toBe(false)
  yield* Fiber.interrupt(probe)
})

const patch = (...hunks: string[]) => ({ patchText: `*** Begin Patch\n${hunks.join("\n")}\n*** End Patch` })
const update = (file: string, before: string, after: string) => `*** Update File: ${file}\n@@\n-${before}\n+${after}`

describe("shared file mutations", () => {
  it.instance("keeps hard-link names stable across 100 queued identical rewrites", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const a = path.join(test.directory, "a.txt")
      const b = path.join(test.directory, "b.txt")
      const content = "unchanged\n"
      yield* fs.writeWithDirs(a, content)
      yield* fs.link(a, b)
      const conflicts: number[] = []

      for (let index = 0; index < 100; index++) {
        const ready = yield* Latch.make()
        const release = yield* Latch.make()
        const before = yield* FileMutation.read(fs, b)
        const holder = yield* FileMutation.withLocks(
          [a],
          Effect.gen(function* () {
            yield* ready.open
            yield* release.await
            yield* fs.writeWithDirs(a, content)
          }),
        ).pipe(Effect.forkScoped)
        yield* awaitWithTimeout(ready.await, "hard-link holder did not acquire its lock")
        const queued = yield* FileMutation.withLocks([b], FileMutation.assertUnchanged(fs, before)).pipe(
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* release.open
        yield* awaitWithTimeout(Fiber.join(holder), "identical rewrite did not finish")
        const exit = yield* awaitWithTimeout(Fiber.await(queued), "hard-link waiter did not finish")
        if (Exit.isFailure(exit)) conflicts.push(index)
      }

      expect(conflicts).toEqual([])
      expect(yield* fs.readFileString(a)).toBe(content)
      expect(yield* fs.readFileString(b)).toBe(content)
    }),
  )

  it.instance("serializes edits through hard links and preserves their shared inode", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const tools = yield* init
      const gate = yield* approval
      const a = path.join(test.directory, "a.txt")
      const b = path.join(test.directory, "b.txt")
      yield* fs.writeWithDirs(a, "top = 0\nbottom = 0\n")
      yield* fs.link(a, b)
      const before = statSync(a, { bigint: true })
      expect(typeof before.dev).toBe("bigint")
      expect(typeof before.ino).toBe("bigint")
      expect((yield* FileMutation.read(fs, a)).identity).toBe(`${before.dev}:${before.ino}`)
      yield* awaitWithTimeout(FileMutation.withLocks([b, a], Effect.void), "hard-link aliases deadlocked")

      const first = yield* tools.edit
        .execute({ filePath: a, oldString: "top = 0", newString: "top = 1" }, gate.ctx)
        .pipe(Effect.forkScoped)
      yield* awaitWithTimeout(gate.entered.await, "hard-link edit never requested approval")
      yield* expectLocked([b])
      const second = yield* tools.patch
        .execute(patch(update(b, "bottom = 0", "bottom = 2")), ctx)
        .pipe(Effect.forkScoped({ startImmediately: true }))
      yield* gate.proceed.open
      yield* awaitWithTimeout(Fiber.join(first), "first hard-link edit did not finish")
      yield* awaitWithTimeout(Fiber.join(second), "second hard-link edit did not finish")

      expect(yield* fs.readFileString(a)).toBe("top = 1\nbottom = 2\n")
      expect(yield* fs.readFileString(b)).toBe("top = 1\nbottom = 2\n")
      expect(statSync(a, { bigint: true }).ino).toBe(before.ino)
      expect(statSync(b, { bigint: true }).ino).toBe(before.ino)
    }),
  )

  for (const kind of ["write", "edit", "apply_patch"] as const) {
    it.instance(`rejects an identical-content inode swap during ${kind} approval`, () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* AppFileSystem.Service
        const tools = yield* init
        const gate = yield* approval
        const a = path.join(test.directory, "a.txt")
        const b = path.join(test.directory, "b.txt")
        yield* fs.writeWithDirs(a, "old\n")
        yield* fs.writeWithDirs(b, "old\n")
        expect(statSync(a, { bigint: true }).ino).not.toBe(statSync(b, { bigint: true }).ino)
        const pending = yield* (
          kind === "write"
            ? tools.write.execute({ filePath: a, content: "tool\n" }, gate.ctx)
            : kind === "edit"
              ? tools.edit.execute({ filePath: a, oldString: "old", newString: "tool" }, gate.ctx)
              : tools.patch.execute(patch(update(a, "old", "tool")), gate.ctx)
        ).pipe(Effect.forkScoped)
        yield* awaitWithTimeout(gate.entered.await, "mutation never requested approval")
        yield* fs.remove(a)
        yield* fs.link(b, a)
        yield* expectLocked([a])
        yield* gate.proceed.open

        const exit = yield* awaitWithTimeout(Fiber.await(pending), "inode swap did not finish")
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause)).toContain("File changed while waiting for permission")
        expect(yield* fs.readFileString(a)).toBe("old\n")
        expect(yield* fs.readFileString(b)).toBe("old\n")
        yield* awaitWithTimeout(tools.write.execute({ filePath: b, content: "retry\n" }, ctx), "inode lock leaked")
      }),
    )
  }

  it.instance("rejects an inode swap while waiting on another hard-link alias", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const tools = yield* init
      const gate = yield* approval
      const a = path.join(test.directory, "a.txt")
      const b = path.join(test.directory, "b.txt")
      const replacement = path.join(test.directory, "replacement.txt")
      yield* fs.writeWithDirs(a, "old\n")
      yield* fs.link(a, b)
      yield* fs.writeWithDirs(replacement, "old\n")
      const holder = yield* tools.write.execute({ filePath: a, content: "holder\n" }, gate.ctx).pipe(Effect.forkScoped)
      yield* awaitWithTimeout(gate.entered.await, "holder never requested approval")
      const pending = yield* tools.write
        .execute({ filePath: b, content: "tool\n" }, ctx)
        .pipe(Effect.forkScoped({ startImmediately: true }))
      yield* fs.remove(b)
      yield* fs.link(replacement, b)
      yield* expectLocked([b])
      yield* gate.proceed.open
      yield* awaitWithTimeout(Fiber.join(holder), "holder did not finish")

      const exit = yield* awaitWithTimeout(Fiber.await(pending), "replaced waiter did not finish")
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("File target changed")
      expect(yield* fs.readFileString(a)).toBe("holder\n")
      expect(yield* fs.readFileString(b)).toBe("old\n")
      expect(yield* fs.readFileString(replacement)).toBe("old\n")
    }),
  )

  it.instance("acquires the new inode when a queued missing path becomes a hard link", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const tools = yield* init
      const name = yield* approval
      const inode = yield* approval
      const a = path.join(test.directory, "a.txt")
      const b = path.join(test.directory, "b.txt")
      yield* fs.writeWithDirs(b, "top = 0\nbottom = 0\n")
      const nameHolder = yield* FileMutation.withLocks(
        [a],
        name.entered.open.pipe(Effect.andThen(name.proceed.await)),
      ).pipe(Effect.forkScoped)
      yield* awaitWithTimeout(name.entered.await, "missing path was not locked")
      const inodeHolder = yield* tools.write
        .execute({ filePath: b, content: "top = 1\nbottom = 0\n" }, inode.ctx)
        .pipe(Effect.forkScoped)
      yield* awaitWithTimeout(inode.entered.await, "inode holder never requested approval")
      const pending = yield* tools.patch
        .execute(patch(update(a, "bottom = 0", "bottom = 2")), ctx)
        .pipe(Effect.forkScoped({ startImmediately: true }))
      yield* fs.link(b, a)
      yield* name.proceed.open
      yield* awaitWithTimeout(Fiber.join(nameHolder), "name holder did not finish")
      yield* expectLocked([a])
      yield* inode.proceed.open
      yield* awaitWithTimeout(Fiber.join(inodeHolder), "inode holder did not finish")
      yield* awaitWithTimeout(Fiber.join(pending), "queued hard-link edit did not finish")

      expect(yield* fs.readFileString(a)).toBe("top = 1\nbottom = 2\n")
      expect(yield* fs.readFileString(b)).toBe("top = 1\nbottom = 2\n")
    }),
  )

  it.instance("shares locks between existing symlink aliases without replacing the links", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const tools = yield* init
      const gate = yield* approval
      const file = path.join(test.directory, "target.txt")
      const firstAlias = path.join(test.directory, "first.txt")
      const secondAlias = path.join(test.directory, "second.txt")
      yield* fs.writeWithDirs(file, "top = 0\nbottom = 0\n")
      yield* fs.symlink(file, firstAlias)
      yield* fs.symlink(file, secondAlias)
      const first = yield* tools.edit
        .execute({ filePath: firstAlias, oldString: "top = 0", newString: "top = 1" }, gate.ctx)
        .pipe(Effect.forkScoped)
      yield* awaitWithTimeout(gate.entered.await, "alias edit never requested approval")
      yield* expectLocked([secondAlias])
      const second = yield* tools.patch
        .execute(patch(update(secondAlias, "bottom = 0", "bottom = 2")), ctx)
        .pipe(Effect.forkScoped({ startImmediately: true }))
      yield* gate.proceed.open
      yield* awaitWithTimeout(Fiber.join(first), "first alias edit did not finish")
      yield* awaitWithTimeout(Fiber.join(second), "second alias edit did not finish")

      expect(yield* fs.readFileString(file)).toBe("top = 1\nbottom = 2\n")
      expect(yield* fs.readLink(firstAlias)).toBe(file)
      expect(yield* fs.readLink(secondAlias)).toBe(file)
    }),
  )

  it.instance("preserves parent traversal through symlinks when resolving lock targets", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const tools = yield* init
      const gate = yield* approval
      const real = path.join(test.directory, "real")
      const alias = path.join(test.directory, "alias")
      const file = path.join(real, "target.txt")
      const lexical = path.join(test.directory, "target.txt")
      yield* fs.makeDirectory(path.join(real, "nested"), { recursive: true })
      yield* fs.symlink(path.join(real, "nested"), alias)
      yield* fs.writeWithDirs(file, "old\n")
      yield* fs.writeWithDirs(lexical, "unrelated\n")
      expect(yield* fs.readFileString(`${alias}${path.sep}..${path.sep}target.txt`)).toBe("old\n")
      const pending = yield* tools.write
        .execute({ filePath: `${alias}${path.sep}..${path.sep}target.txt`, content: "tool\n" }, gate.ctx)
        .pipe(Effect.forkScoped)
      yield* awaitWithTimeout(gate.entered.await, "alias traversal never requested approval")
      yield* expectLocked([file])
      yield* gate.proceed.open
      yield* awaitWithTimeout(Fiber.join(pending), "alias traversal write did not finish")

      expect(yield* fs.readFileString(file)).toBe("tool\n")
      expect(yield* fs.readFileString(lexical)).toBe("unrelated\n")
    }),
  )

  for (const suffix of ["new.txt", "nested/deeper/new.txt"]) {
    it.instance(`shares locks for missing ${suffix} through a symlinked parent`, () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* AppFileSystem.Service
        const tools = yield* init
        const gate = yield* approval
        const real = path.join(test.directory, "real")
        const alias = path.join(test.directory, "alias")
        const file = path.join(real, suffix)
        yield* fs.makeDirectory(real)
        yield* fs.symlink(real, alias)
        const first = yield* tools.write
          .execute({ filePath: path.join(alias, suffix), content: "top = 1\nbottom = 0\n" }, gate.ctx)
          .pipe(Effect.forkScoped)
        yield* awaitWithTimeout(gate.entered.await, "creation never requested approval")
        yield* expectLocked([file])
        const second = yield* tools.patch
          .execute(patch(update(file, "bottom = 0", "bottom = 2")), ctx)
          .pipe(Effect.forkScoped({ startImmediately: true }))
        yield* gate.proceed.open
        yield* awaitWithTimeout(Fiber.join(first), "alias creation did not finish")
        yield* awaitWithTimeout(Fiber.join(second), "patch after alias creation did not finish")

        expect(yield* fs.readFileString(file)).toBe("top = 1\nbottom = 2\n")
        expect(yield* fs.readLink(alias)).toBe(real)
      }),
    )
  }

  it.instance("rejects a symlink retargeted during approval even when bytes match", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const tools = yield* init
      const gate = yield* approval
      const first = path.join(test.directory, "first.txt")
      const second = path.join(test.directory, "second.txt")
      const alias = path.join(test.directory, "alias.txt")
      yield* fs.writeWithDirs(first, "old\n")
      yield* fs.writeWithDirs(second, "old\n")
      yield* fs.symlink(first, alias)
      const pending = yield* tools.write
        .execute({ filePath: alias, content: "tool\n" }, gate.ctx)
        .pipe(Effect.forkScoped)
      yield* awaitWithTimeout(gate.entered.await, "symlink write never requested approval")
      yield* fs.remove(alias)
      yield* fs.symlink(second, alias)
      yield* gate.proceed.open

      const exit = yield* awaitWithTimeout(Fiber.await(pending), "retargeted write did not finish")
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* fs.readFileString(first)).toBe("old\n")
      expect(yield* fs.readFileString(second)).toBe("old\n")
      expect(yield* fs.readLink(alias)).toBe(second)
    }),
  )

  it.instance("rejects an actual symlink retarget between names of the same inode", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const tools = yield* init
      const gate = yield* approval
      const a = path.join(test.directory, "a.txt")
      const b = path.join(test.directory, "b.txt")
      const alias = path.join(test.directory, "alias.txt")
      yield* fs.writeWithDirs(a, "old\n")
      yield* fs.link(a, b)
      yield* fs.symlink(a, alias)
      const pending = yield* tools.write
        .execute({ filePath: alias, content: "tool\n" }, gate.ctx)
        .pipe(Effect.forkScoped)
      yield* awaitWithTimeout(gate.entered.await, "symlink write never requested approval")
      yield* fs.remove(alias)
      yield* fs.symlink(b, alias)
      yield* gate.proceed.open

      const exit = yield* awaitWithTimeout(Fiber.await(pending), "retargeted write did not finish")
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* fs.readFileString(a)).toBe("old\n")
      expect(yield* fs.readFileString(b)).toBe("old\n")
      expect(yield* fs.readLink(alias)).toBe(b)
    }),
  )

  it.instance("rejects symlink cycles during name resolution", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const tools = yield* init
      const a = path.join(test.directory, "a.txt")
      const b = path.join(test.directory, "b.txt")
      yield* fs.symlink(b, a)
      yield* fs.symlink(a, b)

      const exit = yield* tools.write.execute({ filePath: a, content: "tool\n" }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Too many symbolic links")
    }),
  )

  it.instance("rejects a symlink retargeted while waiting for its original target lock", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const tools = yield* init
      const gate = yield* approval
      const first = path.join(test.directory, "first.txt")
      const second = path.join(test.directory, "second.txt")
      const alias = path.join(test.directory, "alias.txt")
      yield* fs.writeWithDirs(first, "old\n")
      yield* fs.writeWithDirs(second, "old\n")
      yield* fs.symlink(first, alias)
      const holder = yield* tools.write
        .execute({ filePath: first, content: "holder\n" }, gate.ctx)
        .pipe(Effect.forkScoped)
      yield* awaitWithTimeout(gate.entered.await, "holder never requested approval")
      const pending = yield* tools.write
        .execute({ filePath: alias, content: "tool\n" }, ctx)
        .pipe(Effect.forkScoped({ startImmediately: true }))
      yield* fs.remove(alias)
      yield* fs.symlink(second, alias)
      yield* gate.proceed.open
      yield* awaitWithTimeout(Fiber.join(holder), "holder did not finish")

      const exit = yield* awaitWithTimeout(Fiber.await(pending), "retargeted waiter did not finish")
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("File target changed")
      expect(yield* fs.readFileString(first)).toBe("holder\n")
      expect(yield* fs.readFileString(second)).toBe("old\n")
    }),
  )

  it.instance("deletes a symlink path rather than its canonical target", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const tools = yield* init
      const file = path.join(test.directory, "target.txt")
      const alias = path.join(test.directory, "alias.txt")
      yield* fs.writeWithDirs(file, "keep\n")
      yield* fs.symlink(file, alias)

      yield* tools.patch.execute(patch(`*** Delete File: ${alias}`), ctx)

      expect(yield* fs.exists(alias)).toBe(false)
      expect(yield* fs.readFileString(file)).toBe("keep\n")
    }),
  )

  for (const nested of [false, true]) {
    it.instance(`does not write through a dangling ${nested ? "parent" : "file"} symlink`, () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* AppFileSystem.Service
        const tools = yield* init
        const target = path.join(test.directory, "missing")
        const alias = path.join(test.directory, "alias")
        yield* fs.symlink(target, alias)

        const exit = yield* tools.write
          .execute({ filePath: nested ? path.join(alias, "new.txt") : alias, content: "tool" }, ctx)
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* fs.exists(target)).toBe(false)
        expect(yield* fs.readLink(alias)).toBe(target)
      }),
    )
  }

  it.instance("serializes overlapping patches without losing either edit", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const tools = yield* init
      const gate = yield* approval
      const file = path.join(test.directory, "shared.txt")
      yield* fs.writeWithDirs(file, "top = 0\nbottom = 0\n")

      const first = yield* tools.patch
        .execute(patch(update(file, "top = 0", "top = 1")), gate.ctx)
        .pipe(Effect.forkScoped)
      yield* awaitWithTimeout(gate.entered.await, "first patch never requested approval")
      yield* expectLocked([file])

      const second = yield* tools.patch
        .execute(patch(update(file, "bottom = 0", "bottom = 2")), ctx)
        .pipe(Effect.forkScoped({ startImmediately: true }))
      yield* tools.write.execute({ filePath: path.join(test.directory, "other.txt"), content: "independent" }, ctx)
      yield* gate.proceed.open
      yield* awaitWithTimeout(Fiber.join(first), "first patch did not finish")
      yield* awaitWithTimeout(Fiber.join(second), "overlapping patch did not finish")

      expect(yield* fs.readFileString(file)).toBe("top = 1\nbottom = 2\n")
    }),
  )

  it.instance("allows disjoint edits while another edit awaits approval", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const tools = yield* init
      const gate = yield* approval
      const firstPath = path.join(test.directory, "first.txt")
      const secondPath = path.join(test.directory, "second.txt")
      yield* fs.writeWithDirs(firstPath, "old")
      yield* fs.writeWithDirs(secondPath, "old")

      const first = yield* tools.edit
        .execute({ filePath: firstPath, oldString: "old", newString: "first" }, gate.ctx)
        .pipe(Effect.forkScoped)
      yield* awaitWithTimeout(gate.entered.await, "edit never requested approval")
      yield* expectLocked([firstPath])
      yield* awaitWithTimeout(
        tools.edit.execute({ filePath: secondPath, oldString: "old", newString: "second" }, ctx),
        "disjoint edit was blocked",
      )
      expect(yield* fs.readFileString(firstPath)).toBe("old")
      expect(yield* fs.readFileString(secondPath)).toBe("second")
      yield* gate.proceed.open
      yield* Fiber.join(first)
    }),
  )

  for (const kind of ["edit", "write"] as const) {
    it.instance(`shares ${kind} locks with apply_patch`, () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* AppFileSystem.Service
        const tools = yield* init
        const gate = yield* approval
        const file = path.join(test.directory, "shared.txt")
        yield* fs.writeWithDirs(file, "top = 0\nbottom = 0\n")

        const first = yield* (
          kind === "edit"
            ? tools.edit.execute({ filePath: file, oldString: "top = 0", newString: "top = 1" }, gate.ctx)
            : tools.write.execute({ filePath: file, content: "top = 1\nbottom = 0\n" }, gate.ctx)
        ).pipe(Effect.forkScoped)
        yield* awaitWithTimeout(gate.entered.await, `${kind} never requested approval`)
        yield* expectLocked([file])
        const second = yield* tools.patch
          .execute(patch(update(file, "bottom = 0", "bottom = 2")), ctx)
          .pipe(Effect.forkScoped({ startImmediately: true }))
        yield* gate.proceed.open
        yield* awaitWithTimeout(Fiber.join(first), `${kind} did not finish`)
        yield* awaitWithTimeout(Fiber.join(second), "patch did not finish")

        expect(yield* fs.readFileString(file)).toBe("top = 1\nbottom = 2\n")
      }),
    )
  }

  for (const mutation of [
    {
      name: "patch update",
      before: "old\n",
      after: "user\n",
      run: (tools, file, next) => tools.patch.execute(patch(update(file, "old", "tool")), next),
    },
    {
      name: "patch delete",
      before: "old\n",
      after: "user\n",
      run: (tools, file, next) => tools.patch.execute(patch(`*** Delete File: ${file}`), next),
    },
    {
      name: "patch add replacing an existing file",
      before: "old\n",
      after: "user\n",
      run: (tools, file, next) => tools.patch.execute(patch(`*** Add File: ${file}\n+tool`), next),
    },
    {
      name: "patch add racing creation of an empty file",
      before: undefined,
      after: "",
      run: (tools, file, next) => tools.patch.execute(patch(`*** Add File: ${file}\n+tool`), next),
    },
    {
      name: "write with changed undecodable bytes",
      before: new Uint8Array([0x80]),
      after: new Uint8Array([0x81]),
      run: (tools, file, next) => tools.write.execute({ filePath: file, content: "tool" }, next),
    },
    {
      name: "write racing creation of an empty file",
      before: undefined,
      after: "",
      run: (tools, file, next) => tools.write.execute({ filePath: file, content: "tool" }, next),
    },
    {
      name: "edit with changed line endings",
      before: "old\n",
      after: "old\r\n",
      run: (tools, file, next) => tools.edit.execute({ filePath: file, oldString: "old", newString: "tool" }, next),
    },
    {
      name: "empty-string edit with changed BOM",
      before: "old\n",
      after: "\ufeffold\n",
      run: (tools, file, next) => tools.edit.execute({ filePath: file, oldString: "", newString: "tool" }, next),
    },
    {
      name: "empty-string edit racing creation of an empty file",
      before: undefined,
      after: "",
      run: (tools, file, next) => tools.edit.execute({ filePath: file, oldString: "", newString: "tool" }, next),
    },
    {
      name: "patch update racing deletion",
      before: "old\n",
      after: undefined,
      run: (tools, file, next) => tools.patch.execute(patch(update(file, "old", "tool")), next),
    },
  ] satisfies Array<{
    name: string
    before: string | Uint8Array | undefined
    after: string | Uint8Array | undefined
    run: (tools: Effect.Success<typeof init>, file: string, next: Tool.Context) => Effect.Effect<unknown>
  }>) {
    it.instance(`rejects ${mutation.name} changes during approval and releases the lock`, () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* AppFileSystem.Service
        const tools = yield* init
        const gate = yield* approval
        const file = path.join(test.directory, "changed.txt")
        if (mutation.before !== undefined) yield* fs.writeWithDirs(file, mutation.before)

        const pending = yield* mutation.run(tools, file, gate.ctx).pipe(Effect.forkScoped)
        yield* awaitWithTimeout(gate.entered.await, "mutation never requested approval")
        if (mutation.after === undefined) yield* fs.remove(file)
        if (mutation.after !== undefined) yield* fs.writeWithDirs(file, mutation.after)
        yield* gate.proceed.open
        const exit = yield* awaitWithTimeout(Fiber.await(pending), "mutation did not reject the conflict")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause)).toContain("File changed while waiting for permission")
        if (mutation.after === undefined) expect(yield* fs.exists(file)).toBe(false)
        if (mutation.after !== undefined) {
          expect(Array.from(yield* fs.readFile(file))).toEqual(
            Array.from(typeof mutation.after === "string" ? new TextEncoder().encode(mutation.after) : mutation.after),
          )
        }
        yield* awaitWithTimeout(
          tools.write.execute({ filePath: file, content: "retry" }, ctx),
          "failed mutation leaked its lock",
        )
      }),
    )
  }

  it.instance("checks all patch snapshots before the first mutation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const tools = yield* init
      const gate = yield* approval
      const created = path.join(test.directory, "created.txt")
      const changed = path.join(test.directory, "changed.txt")
      yield* fs.writeWithDirs(changed, "old\n")
      const pending = yield* tools.patch
        .execute(patch(`*** Add File: ${created}\n+new`, update(changed, "old", "tool")), gate.ctx)
        .pipe(Effect.forkScoped)
      yield* awaitWithTimeout(gate.entered.await, "patch never requested approval")
      yield* fs.writeWithDirs(changed, "user\n")
      yield* gate.proceed.open

      expect(Exit.isFailure(yield* Fiber.await(pending))).toBe(true)
      expect(yield* fs.exists(created)).toBe(false)
      expect(yield* fs.readFileString(changed)).toBe("user\n")
    }),
  )

  for (const exists of [false, true]) {
    it.instance(
      `checks a move destination ${exists ? "changed" : "created"} during approval`,
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const fs = yield* AppFileSystem.Service
          const tools = yield* init
          const gate = yield* approval
          const source = path.join(test.directory, "source.txt")
          const target = path.join(test.directory, "target.txt")
          yield* fs.writeWithDirs(source, "old\n")
          if (exists) yield* fs.writeWithDirs(target, "existing\n")
          const pending = yield* tools.patch
            .execute(patch(`*** Update File: ${source}\n*** Move to: ${target}\n@@\n-old\n+tool`), gate.ctx)
            .pipe(Effect.forkScoped)
          yield* awaitWithTimeout(gate.entered.await, "move never requested approval")
          expect(gate.calls[0].patterns).toEqual(["source.txt", "target.txt"])
          yield* expectLocked([target])
          yield* fs.writeWithDirs(target, "user\n")
          yield* gate.proceed.open

          const exit = yield* Fiber.await(pending)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(target)
          expect(yield* fs.readFileString(source)).toBe("old\n")
          expect(yield* fs.readFileString(target)).toBe("user\n")
        }),
      { git: true },
    )
  }

  it.instance("releases acquired locks when cancelled during approval or multi-file acquisition", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const tools = yield* init
      const gate = yield* approval
      const a = path.join(test.directory, "a.txt")
      const b = path.join(test.directory, "b.txt")
      yield* fs.writeWithDirs(a, "old\n")
      yield* fs.writeWithDirs(b, "old\n")
      const holder = yield* tools.write.execute({ filePath: b, content: "holder" }, gate.ctx).pipe(Effect.forkScoped)
      yield* awaitWithTimeout(gate.entered.await, "holder never requested approval")

      // Reverse input order must still acquire a before waiting for b.
      const waiting = yield* tools.patch
        .execute(patch(update(b, "old", "next"), update(a, "old", "next")), ctx)
        .pipe(Effect.forkScoped({ startImmediately: true }))
      yield* expectLocked([a])
      yield* awaitWithTimeout(Fiber.interrupt(waiting), "waiting patch could not be cancelled")
      yield* awaitWithTimeout(tools.write.execute({ filePath: a, content: "released" }, ctx), "partial lock leaked")
      yield* awaitWithTimeout(Fiber.interrupt(holder), "approval wait could not be cancelled")
      yield* awaitWithTimeout(tools.write.execute({ filePath: b, content: "released" }, ctx), "holder lock leaked")

      expect(yield* fs.readFileString(a)).toBe("released")
      expect(yield* fs.readFileString(b)).toBe("released")
    }),
  )

  it.instance("deduplicates normalized paths and releases locks after permission failure", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const tools = yield* init
      const file = path.join(test.directory, "file.txt")
      yield* fs.writeWithDirs(file, "old\n")
      yield* awaitWithTimeout(
        FileMutation.withLocks([file, `${test.directory}/./file.txt`, file], Effect.void),
        "duplicate paths deadlocked",
      )
      const exit = yield* tools.write
        .execute({ filePath: file, content: "denied" }, { ...ctx, ask: () => Effect.die(new Error("denied")) })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* fs.readFileString(file)).toBe("old\n")
      yield* awaitWithTimeout(
        tools.patch.execute(patch(update(file, "old", "retry")), ctx),
        "denied write leaked its lock",
      )
      expect(yield* fs.readFileString(file)).toBe("retry\n")
    }),
  )
})
