import { Cause, Context, Effect, Layer, Queue, Stream } from "effect"
import { Headers } from "effect/unstable/http"
import { LLMError, TransportReason } from "../../schema"
import * as HttpTransport from "./http"
import type { Transport } from "./index"

export interface WebSocketRequest {
  readonly url: string
  readonly headers: Headers.Headers
}

export interface WebSocketConnection {
  readonly sendText: (message: string) => Effect.Effect<void, LLMError>
  readonly messages: Stream.Stream<string | Uint8Array, LLMError>
  readonly close: Effect.Effect<void, never>
}

export interface Interface {
  readonly open: (input: WebSocketRequest) => Effect.Effect<WebSocketConnection, LLMError>
}

type WebSocketConstructorWithHeaders = new (
  url: string,
  options?: { readonly headers?: Headers.Headers },
) => globalThis.WebSocket

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM/WebSocketExecutor") {}

const transportError = (
  method: string,
  message: string,
  input: { readonly url?: string; readonly kind?: string } = {},
) =>
  new LLMError({
    module: "WebSocketExecutor",
    method,
    reason: new TransportReason({ message, url: input.url, kind: input.kind }),
  })

const eventMessage = (event: Event) => {
  if ("message" in event && typeof event.message === "string") return event.message
  return event.type
}

const binaryMessage = (data: unknown) => {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return undefined
}

const waitOpen = (ws: globalThis.WebSocket, input: WebSocketRequest) => {
  if (ws.readyState === globalThis.WebSocket.OPEN) return Effect.void
  if (ws.readyState === globalThis.WebSocket.CLOSING || ws.readyState === globalThis.WebSocket.CLOSED) {
    return Effect.fail(
      transportError("open", `WebSocket closed before opening (state ${ws.readyState})`, {
        url: input.url,
        kind: "open",
      }),
    )
  }
  return Effect.callback<void, LLMError>((resume, signal) => {
    const cleanup = () => {
      ws.removeEventListener("open", onOpen)
      ws.removeEventListener("error", onError)
      ws.removeEventListener("close", onClose)
      signal.removeEventListener("abort", onAbort)
    }
    const onAbort = () => {
      cleanup()
      if (ws.readyState !== globalThis.WebSocket.CLOSED && ws.readyState !== globalThis.WebSocket.CLOSING)
        ws.close(1000)
    }
    const onOpen = () => {
      cleanup()
      resume(Effect.void)
    }
    const onError = (event: Event) => {
      cleanup()
      resume(
        Effect.fail(
          transportError("open", `Failed to open WebSocket: ${eventMessage(event)}`, { url: input.url, kind: "open" }),
        ),
      )
    }
    const onClose = (event: CloseEvent) => {
      cleanup()
      resume(
        Effect.fail(
          transportError("open", `WebSocket closed before opening with code ${event.code}`, {
            url: input.url,
            kind: "open",
          }),
        ),
      )
    }
    ws.addEventListener("open", onOpen, { once: true })
    ws.addEventListener("error", onError, { once: true })
    ws.addEventListener("close", onClose, { once: true })
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

const webSocketUrl = (value: string) =>
  Effect.try({
    try: () => {
      const url = new URL(value)
      if (url.protocol === "https:") {
        url.protocol = "wss:"
        return url.toString()
      }
      if (url.protocol === "http:") {
        url.protocol = "ws:"
        return url.toString()
      }
      throw new Error(`Unsupported WebSocket URL protocol ${url.protocol}`)
    },
    catch: (error) =>
      transportError("prepare", error instanceof Error ? error.message : "Invalid WebSocket URL", {
        url: value,
        kind: "websocket",
      }),
  })

export const open = (input: WebSocketRequest) =>
  Effect.try({
    try: () =>
      new (globalThis.WebSocket as unknown as WebSocketConstructorWithHeaders)(input.url, { headers: input.headers }),
    catch: (error) =>
      transportError("open", error instanceof Error ? error.message : "Failed to construct WebSocket", {
        url: input.url,
        kind: "open",
      }),
  }).pipe(Effect.flatMap((ws) => fromWebSocket(ws, input)))

export const layer: Layer.Layer<Service> = Layer.succeed(Service, Service.of({ open }))

// Attach a fresh per-request session (queue + listeners + send + cleanup) to an
// already-open WebSocket. The returned `cleanup` removes only the listeners and
// shuts down the per-call queue — it does NOT close the underlying socket.
// `fromWebSocket` composes `attach` with a socket-close step; the pool reuses
// `attach` without the close so the socket can serve another request.
const attach = (
  ws: globalThis.WebSocket,
  input: WebSocketRequest,
): Effect.Effect<WebSocketConnection & { readonly cleanup: Effect.Effect<void> }, LLMError> =>
  Effect.gen(function* () {
    yield* waitOpen(ws, input)
    const messages = yield* Queue.bounded<string | Uint8Array, LLMError | Cause.Done<void>>(128)

    const onMessage = (event: MessageEvent) => {
      if (typeof event.data === "string") return Queue.offerUnsafe(messages, event.data)
      const binary = binaryMessage(event.data)
      if (binary) return Queue.offerUnsafe(messages, binary)
      Queue.failCauseUnsafe(
        messages,
        Cause.fail(
          transportError("message", "Unsupported WebSocket message payload", { url: input.url, kind: "message" }),
        ),
      )
    }
    const onError = (event: Event) => {
      Queue.failCauseUnsafe(
        messages,
        Cause.fail(
          transportError("message", `WebSocket error: ${eventMessage(event)}`, { url: input.url, kind: "message" }),
        ),
      )
    }
    const onClose = (event: CloseEvent) => {
      if (event.code === 1000 || event.code === 1005) return Queue.endUnsafe(messages)
      Queue.failCauseUnsafe(
        messages,
        Cause.fail(
          transportError("message", `WebSocket closed with code ${event.code}`, { url: input.url, kind: "close" }),
        ),
      )
    }
    const cleanup = Effect.sync(() => {
      ws.removeEventListener("message", onMessage)
      ws.removeEventListener("error", onError)
      ws.removeEventListener("close", onClose)
    }).pipe(Effect.andThen(Queue.shutdown(messages)))

    ws.addEventListener("message", onMessage)
    ws.addEventListener("error", onError)
    ws.addEventListener("close", onClose)

    return {
      sendText: (message) =>
        Effect.try({
          try: () => ws.send(message),
          catch: (error) =>
            transportError("sendText", error instanceof Error ? error.message : "Failed to send WebSocket message", {
              url: input.url,
              kind: "write",
            }),
        }),
      messages: Stream.fromQueue(messages),
      cleanup,
      close: cleanup.pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (ws.readyState === globalThis.WebSocket.CLOSED || ws.readyState === globalThis.WebSocket.CLOSING) return
            ws.close(1000)
          }),
        ),
      ),
    }
  })

export const fromWebSocket = (
  ws: globalThis.WebSocket,
  input: WebSocketRequest,
): Effect.Effect<WebSocketConnection, LLMError> =>
  attach(ws, input).pipe(
    Effect.map((session) => ({
      sendText: session.sendText,
      messages: session.messages,
      close: session.close,
    })),
  )

// =============================================================================
// Pooled executor — shared, long-lived WebSocket connections for OpenAI
// Responses WebSocket mode (and any future protocol that benefits from a
// connection-scoped server cache).
// =============================================================================
//
// Why a pool?  Without it every `LLMClient.stream(...)` call performs a fresh
// TLS+WebSocket handshake to OpenAI, which voids the entire latency win of
// WebSocket mode versus HTTP. With pooling, every step in an agent loop after
// the first reuses the same underlying socket: TLS state is hot, the
// connection-scoped server cache (the article's biggest optimization) keeps
// `previous_response_id` references resolvable, and TTFT collapses.
//
// Design constraints from OpenAI's WebSocket Mode spec:
// - One in-flight `response.create` per connection. We serialize implicitly by
//   acquiring a busy flag on `open()` and releasing it on `close()`; if a
//   second concurrent call arrives we fall back to opening a new socket so
//   nothing blocks. The single-loop opencode session naturally serializes,
//   so this is the common case.
// - 60-minute hard connection limit. We track `openedAt` and refuse to reuse a
//   socket past that age.
// - Connection-local cache evicts on error; we keep the pool entry on
//   normal close but drop it on unexpected close or send error.

export interface PoolOptions {
  /** How long an idle socket stays warm before the sweeper closes it. */
  readonly idleTtlMillis?: number
  /** Hard upper bound on a socket's lifetime (OpenAI: 60 minutes). */
  readonly maxAgeMillis?: number
}

interface PoolEntry {
  readonly ws: globalThis.WebSocket
  readonly key: string
  readonly openedAt: number
  busy: boolean
  idleTimer?: ReturnType<typeof setTimeout>
}

const DEFAULT_IDLE_TTL_MS = 30_000
const DEFAULT_MAX_AGE_MS = 55 * 60 * 1000 // a few minutes under OpenAI's 60-min hard limit

const keyFor = (input: WebSocketRequest) => {
  const auth = (input.headers as unknown as Record<string, string>).authorization ?? ""
  return `${input.url}\u0000${auth}`
}

const isHealthy = (entry: PoolEntry, maxAge: number) =>
  !entry.busy &&
  entry.ws.readyState === globalThis.WebSocket.OPEN &&
  Date.now() - entry.openedAt < maxAge

export const pool = (options: PoolOptions = {}): Interface => {
  const idleTtl = options.idleTtlMillis ?? DEFAULT_IDLE_TTL_MS
  const maxAge = options.maxAgeMillis ?? DEFAULT_MAX_AGE_MS
  const entries = new Map<string, PoolEntry>()

  const evict = (entry: PoolEntry) => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entries.delete(entry.key)
    if (
      entry.ws.readyState !== globalThis.WebSocket.CLOSED &&
      entry.ws.readyState !== globalThis.WebSocket.CLOSING
    ) {
      try {
        entry.ws.close(1000)
      } catch {
        // ignore — socket might already be tearing down
      }
    }
  }

  const armIdle = (entry: PoolEntry) => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      // If the entry is still parked when the idle timer fires, close it. If a
      // request grabbed it in the meantime, `busy` would be true and we leave
      // it alone — the next release will re-arm.
      if (entry.busy) return
      evict(entry)
    }, idleTtl)
  }

  const acquire = (input: WebSocketRequest) =>
    Effect.gen(function* () {
      const key = keyFor(input)
      const existing = entries.get(key)
      if (existing && isHealthy(existing, maxAge)) {
        if (existing.idleTimer) clearTimeout(existing.idleTimer)
        existing.busy = true
        return existing
      }
      if (existing) evict(existing)

      const ws = yield* Effect.try({
        try: () =>
          new (globalThis.WebSocket as unknown as WebSocketConstructorWithHeaders)(input.url, {
            headers: input.headers,
          }),
        catch: (error) =>
          transportError("open", error instanceof Error ? error.message : "Failed to construct WebSocket", {
            url: input.url,
            kind: "open",
          }),
      })
      const entry: PoolEntry = { ws, key, openedAt: Date.now(), busy: true }
      entries.set(key, entry)
      return entry
    })

  const open = (input: WebSocketRequest): Effect.Effect<WebSocketConnection, LLMError> =>
    Effect.gen(function* () {
      const entry = yield* acquire(input)
      const session = yield* attach(entry.ws, input).pipe(
        Effect.tapCause(() => Effect.sync(() => evict(entry))),
      )
      const release = Effect.sync(() => {
        entry.busy = false
        // Re-check health: if the socket died while we were using it, evict
        // instead of returning it to the pool.
        if (
          entry.ws.readyState !== globalThis.WebSocket.OPEN ||
          Date.now() - entry.openedAt >= maxAge
        ) {
          evict(entry)
          return
        }
        armIdle(entry)
      })
      return {
        sendText: (message) =>
          session.sendText(message).pipe(Effect.tapCause(() => Effect.sync(() => evict(entry)))),
        messages: session.messages,
        close: session.cleanup.pipe(Effect.andThen(release)),
      }
    })

  return { open }
}

export const poolLayer = (options: PoolOptions = {}): Layer.Layer<Service> =>
  Layer.sync(Service, () => Service.of(pool(options)))

export const messageText = (message: string | Uint8Array, decoder: TextDecoder) =>
  typeof message === "string" ? message : decoder.decode(message)

export interface JsonPrepared {
  readonly url: string
  readonly headers: Headers.Headers
  readonly message: string
}

export interface JsonInput<Body, Message> {
  readonly toMessage: (body: Body | Record<string, unknown>) => Effect.Effect<Message, LLMError>
  readonly encodeMessage: (message: Message) => string
}

export type JsonPatch<Body, Message> = Partial<JsonInput<Body, Message>>

export interface JsonTransport<Body, Message> extends Transport<Body, JsonPrepared, string> {
  readonly with: (patch: JsonPatch<Body, Message>) => JsonTransport<Body, Message>
}

export const json = <Body, Message>(input: JsonInput<Body, Message>): JsonTransport<Body, Message> => ({
  id: "websocket-json",
  with: (patch) => json({ ...input, ...patch }),
  prepare: (prepareInput) =>
    Effect.gen(function* () {
      const parts = yield* HttpTransport.jsonRequestParts({
        ...prepareInput,
      })
      return {
        url: yield* webSocketUrl(parts.url),
        headers: parts.headers,
        message: input.encodeMessage(yield* input.toMessage(parts.jsonBody)),
      }
    }),
  frames: (prepared, _request, runtime) => {
    const webSocket = runtime.webSocket
    if (!webSocket) {
      return Stream.fail(
        transportError("json", "WebSocket JSON transport requires WebSocketExecutor.Service", {
          url: prepared.url,
          kind: "websocket",
        }),
      )
    }
    const decoder = new TextDecoder()
    return Stream.unwrap(
      Effect.gen(function* () {
        const connection = yield* Effect.acquireRelease(
          webSocket.open({ url: prepared.url, headers: prepared.headers }),
          (connection) => connection.close,
        )
        yield* connection.sendText(prepared.message)
        return connection.messages.pipe(Stream.map((message) => messageText(message, decoder)))
      }),
    )
  },
})

export const jsonTransport = {
  id: "websocket-json",
  with: json,
} as const

export const WebSocketExecutor = {
  Service,
  layer,
  open,
  fromWebSocket,
  messageText,
  pool,
  poolLayer,
} as const

export const WebSocketTransport = {
  json,
  jsonTransport,
} as const
