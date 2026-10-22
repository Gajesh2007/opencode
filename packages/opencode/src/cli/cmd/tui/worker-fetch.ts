import type { Rpc } from "@/util/rpc"

type FetchInput = {
  id: string
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

type FetchResult =
  | { status: number; headers: Record<string, string>; body: string }
  | { error: "aborted" | "failed" | "busy" }

type FetchRpc = {
  fetch: (input: FetchInput) => Promise<FetchResult>
  cancelFetch: (input: { id: string }) => void
}

export function createWorkerFetch(client: Pick<ReturnType<typeof Rpc.client<FetchRpc>>, "call">): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (request.signal.aborted) throw new DOMException("Aborted", "AbortError")
    const id = crypto.randomUUID()
    const reader = request.body?.getReader()
    const aborted = Promise.withResolvers<never>()
    let sent = false
    const abort = () => {
      aborted.reject(new DOMException("Aborted", "AbortError"))
      void reader?.cancel().catch(() => {})
      if (sent) void client.call("cancelFetch", { id }).catch(() => {})
    }
    request.signal.addEventListener("abort", abort, { once: true })
    try {
      return await Promise.race([
        aborted.promise,
        (async () => {
          const decoder = new TextDecoder()
          let body = reader ? "" : undefined
          while (reader) {
            const chunk = await reader.read()
            if (chunk.done) break
            body += decoder.decode(chunk.value, { stream: true })
          }
          if (reader) body += decoder.decode()
          if (request.signal.aborted) throw new DOMException("Aborted", "AbortError")
          // Both messages use the same FIFO RPC channel; the worker registers the ID before its first await.
          sent = true
          const result = await client.call("fetch", {
            id,
            url: request.url,
            method: request.method,
            headers: Object.fromEntries(request.headers.entries()),
            body,
          })
          if (request.signal.aborted || ("error" in result && result.error === "aborted"))
            throw new DOMException("Aborted", "AbortError")
          if ("error" in result) throw new Error("Worker fetch failed")
          return new Response(result.body, { status: result.status, headers: result.headers })
        })(),
      ])
    } finally {
      request.signal.removeEventListener("abort", abort)
      reader?.releaseLock()
    }
  }
  return fn as typeof fetch
}

export function createWorkerFetchHandlers(handle: (request: Request) => Response | Promise<Response>) {
  const active = new Map<string, AbortController>()
  let closed = false
  return {
    async fetch(input: FetchInput): Promise<FetchResult> {
      if (closed) return { error: "aborted" }
      if (active.size >= 256 || active.has(input.id)) return { error: "busy" }
      const controller = new AbortController()
      active.set(input.id, controller)
      const aborted = Promise.withResolvers<FetchResult>()
      const abort = () => aborted.resolve({ error: "aborted" })
      controller.signal.addEventListener("abort", abort, { once: true })
      try {
        return await Promise.race([
          aborted.promise,
          (async (): Promise<FetchResult> => {
            const response = await handle(
              new Request(input.url, {
                method: input.method,
                headers: input.headers,
                body: input.body,
                signal: controller.signal,
              }),
            )
            return {
              status: response.status,
              headers: Object.fromEntries(response.headers.entries()),
              body: await response.text(),
            }
          })(),
        ])
      } catch {
        // RPC has no rejection envelope: always settle it, without exposing server errors or request data.
        return { error: controller.signal.aborted ? "aborted" : "failed" }
      } finally {
        controller.signal.removeEventListener("abort", abort)
        active.delete(input.id)
      }
    },
    cancelFetch(input: { id: string }) {
      active.get(input.id)?.abort()
    },
    shutdown() {
      closed = true
      active.forEach((controller) => controller.abort())
      active.clear()
    },
  }
}
