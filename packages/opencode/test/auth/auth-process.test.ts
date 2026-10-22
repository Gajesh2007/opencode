import { expect, test } from "bun:test"
import path from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createInterface } from "node:readline"
import { tmpdir } from "../fixture/fixture"

const initial = { type: "oauth", access: "account-a", refresh: "refresh-a", expires: 0 }

function worker(root: string, mode: string, info: typeof initial, state: string, name = "") {
  const child = spawn(
    process.execPath,
    [path.join(import.meta.dir, "fixtures/auth-worker.ts"), mode, JSON.stringify(info), name],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        ...process.env,
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_STATE_HOME: path.join(root, state),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        OPENCODE_AUTH_CONTENT: JSON.stringify({
          "openai-codex": info,
          ...(mode === "unrelated"
            ? { "other-provider": { type: "oauth", access: "other-access", refresh: "other-refresh", expires: 0 } }
            : {}),
        }),
      },
      stdio: "pipe",
    },
  )
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const exited = once(child, "exit")
  let error = ""
  child.stderr.setEncoding("utf8").on("data", (text) => {
    error += text
  })
  return {
    async line() {
      const next = await lines.next()
      if (next.done) throw new Error(error || "Auth worker exited without a response")
      return next.value
    },
    resume() {
      child.stdin.write("continue\n")
    },
    async done() {
      expect((await exited)[0]).toBe(0)
      expect(error).toBe("")
    },
    [Symbol.dispose]() {
      child.kill()
    },
  }
}

test.each(["set", "remove"])("distinct environment snapshots cannot overwrite another process's %s", async (mode) => {
  await using tmp = await tmpdir()
  using a = worker(tmp.path, "stale", initial, "state")
  expect(await a.line()).toBe("ready")
  using b = worker(tmp.path, mode, { ...initial, access: "account-b", refresh: "refresh-b" }, "state")
  expect(await b.line()).toBe("written")
  await b.done()
  a.resume()
  expect(JSON.parse(await a.line())).toEqual({ staleRejected: true, freshRejected: true })
  await a.done()
  const data = await Bun.file(path.join(tmp.path, "data/opencode/auth.json")).json()
  expect(data["openai-codex"]?.access).toBe(mode === "set" ? "account-b" : undefined)
})

test.each(["set", "remove"])(
  "an unrelated provider refresh cannot restore a stale environment after %s",
  async (mode) => {
    await using tmp = await tmpdir()
    using a = worker(tmp.path, "unrelated", initial, "state-a")
    expect(await a.line()).toBe("ready")
    using b = worker(tmp.path, mode, { ...initial, access: "account-b", refresh: "refresh-b" }, "state-b")
    expect(await b.line()).toBe("written")
    await b.done()
    a.resume()
    expect(JSON.parse(await a.line())).toEqual({ updated: true })
    await a.done()
    const data = await Bun.file(path.join(tmp.path, "data/opencode/auth.json")).json()
    expect(data["openai-codex"]?.access).toBe(mode === "set" ? "account-b" : undefined)
    expect(data["other-provider"].access).toBe("other-refreshed")
  },
)

test("processes with different state directories serialize writes to the same auth file", async () => {
  await using tmp = await tmpdir()
  using a = worker(tmp.path, "concurrent", initial, "state-a", "writer-a")
  using b = worker(tmp.path, "concurrent", initial, "state-b", "writer-b")
  using c = worker(tmp.path, "concurrent", initial, "state-c", "writer-c")
  for (const child of [a, b, c]) expect(await child.line()).toBe("ready")
  for (const child of [a, b, c]) child.resume()
  for (const child of [a, b, c]) {
    expect(await child.line()).toBe("written")
    await child.done()
  }
  const data = await Bun.file(path.join(tmp.path, "data/opencode/auth.json")).json()
  for (const prefix of ["writer-a", "writer-b", "writer-c"]) {
    for (let index = 0; index < 4; index++) expect(data[`${prefix}-${index}`].access).toBe("account-a")
  }
}, 20_000)
