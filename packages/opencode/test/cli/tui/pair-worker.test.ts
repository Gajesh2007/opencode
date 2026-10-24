import { expect, test } from "bun:test"
import { sanitizedProcessEnv } from "@opencode-ai/core/util/opencode-process"
import type { rpc } from "../../../src/cli/cmd/tui/worker"
import { createWorkerFetch } from "../../../src/cli/cmd/tui/worker-fetch"
import { Rpc } from "../../../src/util/rpc"
import { withTimeout } from "../../../src/util/timeout"
import { tmpdir } from "../../fixture/fixture"

// The real TUI worker, with the env the TUI thread gives it.
function spawn(env: Record<string, string>) {
  const worker = new Worker(new URL("../../../src/cli/cmd/tui/worker.ts", import.meta.url), {
    env: sanitizedProcessEnv({ OPENCODE_PROCESS_ROLE: "worker", ...env }),
  })
  const client = Rpc.client<typeof rpc>(worker)
  return {
    client,
    async [Symbol.asyncDispose]() {
      await withTimeout(client.call("shutdown", undefined), 15_000).catch(() => {})
      worker.terminate()
    },
  }
}

test("the TUI worker pairs through a password-protected listener that serves its own sessions", async () => {
  await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
  await using worker = spawn({ OPENCODE_SERVER_PASSWORD: "worker-secret", OPENCODE_SERVER_USERNAME: "opencode" })

  const listener = await withTimeout(worker.client.call("pairListen", undefined), 15_000)
  if ("error" in listener) throw new Error(listener.error)
  expect(listener.username).toBe("opencode")
  expect(listener.password).toBe("worker-secret")
  expect(new URL(listener.url).hostname).toBe("127.0.0.1")
  // Asking again reuses the listener.
  expect(await withTimeout(worker.client.call("pairListen", undefined), 15_000)).toEqual(listener)
  expect((await fetch(`${listener.url}/global/info`)).status).toBe(401)

  // The TUI's own requests carry no credentials; the worker adds them.
  const tui = createWorkerFetch(worker.client)
  const created = await tui(`http://opencode.internal/session?directory=${encodeURIComponent(tmp.path)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "started in the TUI" }),
  })
  expect(created.status).toBe(200)
  const session = (await created.json()) as { id: string }
  const info = (await (await tui("http://opencode.internal/global/info")).json()) as { urls: string[] }
  expect(info.urls).toEqual([listener.url])

  // A device redeems a code issued through the listener, then sees the TUI's session.
  const basic = (password: string) => ({ authorization: `Basic ${btoa(`opencode:${password}`)}` })
  const pairing = await fetch(`${listener.url}/api/pair`, { method: "POST", headers: basic("worker-secret") })
  expect(pairing.status).toBe(200)
  const code = ((await pairing.json()) as { code: string }).code
  const redeemed = await fetch(`${listener.url}/auth/connect/${code}`, { headers: { accept: "application/json" } })
  expect(redeemed.status).toBe(200)
  const token = ((await redeemed.json()) as { token: string }).token
  const listed = await fetch(`${listener.url}/session?directory=${encodeURIComponent(tmp.path)}`, {
    headers: basic(token),
  })
  expect(listed.status).toBe(200)
  expect(((await listed.json()) as { id: string }[]).map((item) => item.id)).toContain(session.id)
}, 60_000)

test("the TUI worker will not pair without a server password", async () => {
  await using worker = spawn({ OPENCODE_SERVER_PASSWORD: "" })
  const result = await withTimeout(worker.client.call("pairListen", undefined), 15_000)
  expect(result).toEqual({ error: "Pairing requires a server password; set OPENCODE_SERVER_PASSWORD and restart" })
}, 60_000)
