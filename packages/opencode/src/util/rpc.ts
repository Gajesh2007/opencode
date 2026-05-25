type Definition = {
  [method: string]: (input: any) => any
}

// We pass plain JS objects through `postMessage` and rely on the host's
// structured-clone algorithm rather than JSON.stringify / JSON.parse on each
// hop. Bus events (the hottest payload, `rpc.event` for `global.event`) fire
// thousands of times per LLM response in the default TUI configuration where
// the server runs in a Web Worker; the JSON round-trip used to be the single
// biggest serializer cost on the per-token path.
//
// All payloads carried through here are plain data (strings, numbers, plain
// objects, no class instances with methods). Structured clone is therefore a
// strict superset of the prior JSON behaviour for these shapes.

type Envelope =
  | { type: "rpc.request"; method: string; input: unknown; id: number }
  | { type: "rpc.result"; result: unknown; id: number }
  | { type: "rpc.event"; event: string; data: unknown }

export function listen(rpc: Definition) {
  onmessage = async (evt: MessageEvent<Envelope>) => {
    const msg = evt.data
    if (msg.type === "rpc.request") {
      const result = await rpc[msg.method](msg.input)
      postMessage({ type: "rpc.result", result, id: msg.id } satisfies Envelope)
    }
  }
}

export function emit(event: string, data: unknown) {
  postMessage({ type: "rpc.event", event, data } satisfies Envelope)
}

export function client<T extends Definition>(target: {
  postMessage: (data: Envelope) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<Envelope>) => any) | null
}) {
  const pending = new Map<number, (result: any) => void>()
  const listeners = new Map<string, Set<(data: any) => void>>()
  let id = 0
  target.onmessage = (evt) => {
    const msg = evt.data
    if (msg.type === "rpc.result") {
      const resolve = pending.get(msg.id)
      if (resolve) {
        resolve(msg.result)
        pending.delete(msg.id)
      }
      return
    }
    if (msg.type === "rpc.event") {
      const handlers = listeners.get(msg.event)
      if (handlers) {
        for (const handler of handlers) {
          handler(msg.data)
        }
      }
    }
  }
  return {
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
      const requestId = id++
      return new Promise((resolve) => {
        pending.set(requestId, resolve)
        target.postMessage({ type: "rpc.request", method: method as string, input, id: requestId })
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      let handlers = listeners.get(event)
      if (!handlers) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => {
        handlers!.delete(handler)
      }
    },
  }
}

export * as Rpc from "./rpc"
