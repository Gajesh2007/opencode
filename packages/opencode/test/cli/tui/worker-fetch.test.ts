import { createWorkerFetch, createWorkerFetchHandlers } from "@/cli/cmd/tui/worker-fetch"
import { Rpc } from "@/util/rpc"
import { expect, test } from "bun:test"

function connect() {
  const worker = new Worker(new URL("./fixtures/worker-fetch.ts", import.meta.url))
  const client = Rpc.client<ReturnType<typeof createWorkerFetchHandlers>>(worker)
  return {
    client,
    fetch: createWorkerFetch(client),
    async [Symbol.asyncDispose]() {
      await client.call("shutdown", undefined)
      worker.terminate()
    },
  }
}

test("aborting a dispatched warm across worker RPC interrupts the real HTTP handler", async () => {
  await using worker = connect()
  const started = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<void>()
  worker.client.on("warm.started", () => started.resolve())
  worker.client.on("warm.stopped", () => stopped.resolve())
  const controller = new AbortController()
  // Match the TUI debounce before crossing the production fetch adapter and RPC listener.
  await Bun.sleep(400)
  const response = worker.fetch("http://opencode.internal/session/ses_warm/warm", {
    method: "POST",
    body: JSON.stringify({ providerID: "openai", modelID: "test" }),
    signal: controller.signal,
  })
  await started.promise
  controller.abort()
  await expect(response).rejects.toMatchObject({ name: "AbortError" })
  await stopped.promise
  expect(await (await worker.fetch("http://opencode.internal/ok")).text()).toBe("ok")
})

test("worker shutdown interrupts active fetches through RPC", async () => {
  await using worker = connect()
  const started = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<void>()
  worker.client.on("warm.started", () => started.resolve())
  worker.client.on("warm.stopped", () => stopped.resolve())
  const response = worker.fetch("http://opencode.internal/session/ses_warm/warm", { method: "POST" })
  await started.promise
  await worker.client.call("shutdown", undefined)
  await expect(response).rejects.toMatchObject({ name: "AbortError" })
  await stopped.promise
})

test("worker fetch skips pre-aborted requests and cancels unfinished request bodies before RPC", async () => {
  await using worker = connect()
  const methods: string[] = []
  worker.client.on<string>("fetch.started", (method) => methods.push(method))
  const pre = new AbortController()
  pre.abort()
  await expect(worker.fetch("http://opencode.internal/ok", { signal: pre.signal })).rejects.toMatchObject({
    name: "AbortError",
  })
  expect(methods).toEqual([])

  const controller = new AbortController()
  const canceled = Promise.withResolvers<void>()
  const response = worker.fetch("http://opencode.internal/ok", {
    method: "POST",
    body: new ReadableStream({ cancel: () => canceled.resolve() }),
    signal: controller.signal,
  })
  controller.abort()
  await expect(response).rejects.toMatchObject({ name: "AbortError" })
  await canceled.promise
  await worker.fetch("http://opencode.internal/ok")
  expect(methods).toEqual(["/ok"])
})

test("worker fetch IDs cannot cancel a newer request and finished IDs are reusable", async () => {
  const active: Request[] = []
  const handlers = createWorkerFetchHandlers((request) => {
    active.push(request)
    if (request.url.endsWith("/ok")) return new Response("ok")
    return new Promise<Response>((_, reject) =>
      request.signal.addEventListener("abort", () => reject(new Error("aborted"))),
    )
  })
  const input = { url: "http://opencode.internal/slow", method: "GET", headers: {} }
  const old = handlers.fetch({ ...input, id: "old" })
  handlers.cancelFetch({ id: "old" })
  expect(await old).toEqual({ error: "aborted" })
  const current = handlers.fetch({ ...input, id: "current" })
  handlers.cancelFetch({ id: "old" })
  expect(active[1].signal.aborted).toBe(false)
  handlers.cancelFetch({ id: "current" })
  expect(await current).toEqual({ error: "aborted" })
  expect(await handlers.fetch({ ...input, id: "old", url: "http://opencode.internal/ok" })).toMatchObject({
    status: 200,
  })
  handlers.shutdown()
  expect(await handlers.fetch({ ...input, id: "later" })).toEqual({ error: "aborted" })
})

test("worker fetch bounds in-flight IDs and releases every slot on cancellation", async () => {
  const handlers = createWorkerFetchHandlers(() => new Promise<Response>(() => {}))
  const input = { url: "http://opencode.internal/slow", method: "GET", headers: {} }
  const pending = Array.from({ length: 256 }, (_, id) => handlers.fetch({ ...input, id: String(id) }))
  expect(await handlers.fetch({ ...input, id: "overflow" })).toEqual({ error: "busy" })
  pending.forEach((_, id) => handlers.cancelFetch({ id: String(id) }))
  expect((await Promise.all(pending)).every((result) => "error" in result && result.error === "aborted")).toBe(true)
  const next = handlers.fetch({ ...input, id: "overflow" })
  handlers.cancelFetch({ id: "overflow" })
  expect(await next).toEqual({ error: "aborted" })
})

test("worker failures settle RPC results without exposing raw errors", async () => {
  const handlers = createWorkerFetchHandlers(() => {
    throw new Error("private server detail")
  })
  expect(
    await handlers.fetch({ id: "failed", url: "http://opencode.internal/ok", method: "GET", headers: {} }),
  ).toEqual({ error: "failed" })
})
