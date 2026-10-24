import { describe, expect, test } from "bun:test"
import { OpenTunnelAttachError, OpenTunnelClientError } from "@opentunnel/client"
import { fatal, run, validRoute, type Connect, type Connection, type RunEvent } from "../src/index"

function connection(url: string) {
  const closed = Promise.withResolvers<void>()
  const value: Connection = { url, closed: closed.promise, close: async () => closed.resolve() }
  return { value, closed }
}

describe("tunnel", () => {
  test("classifies only unrecoverable setup failures as fatal", () => {
    expect(fatal(new OpenTunnelClientError({ message: "attach", cause: new OpenTunnelAttachError("bad-token") }))).toBe(
      true,
    )
    expect(fatal(new OpenTunnelClientError({ message: "Certificate issuance failed: denied" }))).toBe(true)
    expect(fatal(new OpenTunnelClientError({ message: "unsupported proxy scheme socks5:" }))).toBe(true)
    expect(fatal(new OpenTunnelClientError({ message: "network unreachable" }))).toBe(false)
    expect(fatal(new Error("Certificate issuance failed"))).toBe(false)
    expect(fatal(undefined)).toBe(false)
  })

  test("accepts random hex routes", () => {
    expect(validRoute("0123456789abcdef")).toBe(true)
    expect(validRoute("Not A Label")).toBe(false)
  })

  test("publishes the URL, retries transient failures, and stops when aborted", async () => {
    const controller = new AbortController()
    const events: RunEvent[] = []
    const first = connection("https://r.example.test")
    const attempts = [
      () => Promise.reject(new OpenTunnelClientError({ message: "network unreachable" })),
      () => Promise.resolve(first.value),
    ]
    const done = run({
      route: "r",
      target: "127.0.0.1:1",
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event)
        if (event.type === "connected") controller.abort()
      },
      connect: () => attempts.shift()?.() ?? Promise.reject(new Error("no more attempts")),
    })
    await done
    expect(events.map((event) => event.type)).toEqual(["connecting", "retrying", "connecting", "connected", "stopped"])
    expect(events.find((event) => event.type === "connected")).toEqual({
      type: "connected",
      url: "https://r.example.test",
    })
  })

  test("stops for good on a fatal failure", async () => {
    const events: RunEvent[] = []
    await run({
      route: "r",
      target: "127.0.0.1:1",
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      connect: () => Promise.reject(new OpenTunnelClientError({ message: "Certificate issuance failed: quota" })),
    })
    expect(events).toEqual([{ type: "connecting" }, { type: "stopped", error: "Certificate issuance failed: quota" }])
  })

  test("passes the route, target, and signal to the transport", async () => {
    const controller = new AbortController()
    const calls: Parameters<Connect>[0][] = []
    await run({
      route: "r",
      target: "127.0.0.1:1",
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "retrying") controller.abort()
      },
      connect: (input) => {
        calls.push(input)
        return Promise.reject(new Error("unreachable"))
      },
    })
    expect(calls).toEqual([{ route: "r", target: "127.0.0.1:1", signal: controller.signal }])
  })

  test("returns as soon as it is aborted while waiting to retry", async () => {
    const controller = new AbortController()
    const events: RunEvent[] = []
    const started = performance.now()
    await run({
      route: "r",
      target: "127.0.0.1:1",
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event)
        // Listeners may turn remote access off from inside the callback, before the backoff starts.
        if (event.type === "retrying") controller.abort()
      },
      connect: () => Promise.reject(new OpenTunnelClientError({ message: "network unreachable" })),
    })
    expect(events.map((event) => event.type)).toEqual(["connecting", "retrying", "stopped"])
    expect(performance.now() - started).toBeLessThan(500)
  })

  test("closes the attached connection once aborted", async () => {
    const controller = new AbortController()
    const events: RunEvent[] = []
    const first = connection("https://r.example.test")
    const done = run({
      route: "r",
      target: "127.0.0.1:1",
      signal: controller.signal,
      onEvent: (event) => events.push(event),
      connect: () => Promise.resolve(first.value),
    })
    await until(() => events.some((event) => event.type === "connected"))
    controller.abort()
    await done
    expect(events.map((event) => event.type)).toEqual(["connecting", "connected", "stopped"])
  })

  test("reconnects after an attached connection closes", async () => {
    const controller = new AbortController()
    const events: RunEvent[] = []
    const first = connection("https://r.example.test")
    await run({
      route: "r",
      target: "127.0.0.1:1",
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event)
        if (event.type === "connected") void first.value.close()
        if (event.type === "retrying") controller.abort()
      },
      connect: () => Promise.resolve(first.value),
    })
    expect(events).toEqual([
      { type: "connecting" },
      { type: "connected", url: "https://r.example.test" },
      { type: "retrying", error: "Tunnel closed", delay: 1_000 },
      { type: "stopped" },
    ])
  })

  test("stops for good when an attached connection fails fatally", async () => {
    const events: RunEvent[] = []
    const first = connection("https://r.example.test")
    await run({
      route: "r",
      target: "127.0.0.1:1",
      signal: new AbortController().signal,
      onEvent: (event) => {
        events.push(event)
        if (event.type === "connected")
          first.closed.reject(
            new OpenTunnelClientError({ message: "attach", cause: new OpenTunnelAttachError("bad-token") }),
          )
      },
      connect: () => Promise.resolve(first.value),
    })
    expect(events.map((event) => event.type)).toEqual(["connecting", "connected", "stopped"])
    expect(events.at(-1)).toEqual({ type: "stopped", error: "attach" })
  })
})

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 2_000
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("condition never held")
    await Bun.sleep(1)
  }
}
