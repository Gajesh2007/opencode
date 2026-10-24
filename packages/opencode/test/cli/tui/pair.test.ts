import { describe, expect, test } from "bun:test"
import { Pair } from "@/cli/cmd/tui/util/pair"

const code = "AbCdEfGhIjKlMnOpQrStUv"
const remote = "https://0123456789abcdef.tunnel.example"
const lan = "http://192.168.1.20:4096"
const loopback = "http://127.0.0.1:4096"

describe("tui pairing", () => {
  test("only loopback hosts count as this machine's", () => {
    for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.8.9.1", "[::1]"])
      expect(Pair.isLoopback(host)).toBe(true)
    for (const host of ["192.168.1.20", "10.0.0.1", "example.com", "[fe80::1]", "0.0.0.0", "localhost.example.com"])
      expect(Pair.isLoopback(host)).toBe(false)
  })

  test("a client is local when it reaches the server through loopback or a wildcard bind", () => {
    expect(Pair.isLocal("http://127.0.0.1:4096/")).toBe(true)
    expect(Pair.isLocal("http://localhost:4096")).toBe(true)
    expect(Pair.isLocal("http://0.0.0.0:4096/")).toBe(true)
    expect(Pair.isLocal("http://[::]:4096/")).toBe(true)
    expect(Pair.isLocal(lan)).toBe(false)
    expect(Pair.isLocal(remote)).toBe(false)
  })

  test("links point at the connect route of each server URL", () => {
    expect(Pair.link(loopback, code)).toBe(`${loopback}/auth/connect/${code}`)
    expect(Pair.link(`${loopback}/`, code)).toBe(`${loopback}/auth/connect/${code}`)
    expect(Pair.link(remote, code)).toBe(`${remote}/auth/connect/${code}`)
  })

  test("the remote URL comes first only while connected", () => {
    const urls = [loopback, lan, remote]
    expect(Pair.order(urls, { enabled: true, state: "connected", url: remote })).toEqual([remote, loopback, lan])
    expect(Pair.order([loopback], { enabled: true, state: "connected", url: remote })).toEqual([remote, loopback])
    expect(Pair.order([loopback, lan], { enabled: true, state: "connecting" })).toEqual([loopback, lan])
    expect(Pair.order([loopback, lan], { enabled: false, state: "off" })).toEqual([loopback, lan])
    expect(Pair.order([loopback, lan], undefined)).toEqual([loopback, lan])
  })

  test("unusable server URLs are dropped", () => {
    expect(Pair.order(["not a url", loopback, loopback], undefined)).toEqual([loopback])
  })

  test("this device's link goes through the first loopback URL, as localhost", () => {
    expect(Pair.localLink([lan, loopback], code)).toBe(`http://localhost:4096/auth/connect/${code}`)
    expect(Pair.localLink(["http://[::1]:5000"], code)).toBe(`http://localhost:5000/auth/connect/${code}`)
    expect(Pair.localLink([lan, remote], code)).toBeUndefined()
  })

  test("the app's QR payload carries the code and every URL another device can reach", () => {
    const content = Pair.qrContent("app", code, [remote, loopback, lan])
    expect(JSON.parse(content ?? "")).toEqual({ code, urls: [remote, lan] })
  })

  test("the browser QR code is a plain link through the best reachable URL", () => {
    expect(Pair.qrContent("browser", code, [remote, loopback, lan])).toBe(`${remote}/auth/connect/${code}`)
    expect(Pair.qrContent("browser", code, [loopback, lan])).toBe(`${lan}/auth/connect/${code}`)
  })

  test("there is no QR code when only this machine can reach the server", () => {
    expect(Pair.qrContent("app", code, [loopback, "http://localhost:4096"])).toBeUndefined()
    expect(Pair.qrContent("browser", code, [loopback])).toBeUndefined()
  })

  test("the countdown rounds up to whole seconds and stops at zero", () => {
    const now = 1_000_000
    expect(Pair.secondsLeft(now + 300_000, now)).toBe(300)
    expect(Pair.secondsLeft(now + 59_001, now)).toBe(60)
    expect(Pair.secondsLeft(now + 1, now)).toBe(1)
    expect(Pair.secondsLeft(now, now)).toBe(0)
    expect(Pair.secondsLeft(now - 5_000, now)).toBe(0)
    expect(Pair.clock(300)).toBe("5:00")
    expect(Pair.clock(61)).toBe("1:01")
    expect(Pair.clock(9)).toBe("0:09")
    expect(Pair.clock(0)).toBe("0:00")
  })

  test("remote access settles once it is off, connected, or stopped", () => {
    expect(Pair.settled({ enabled: false, state: "off" })).toBe(true)
    expect(Pair.settled({ enabled: true, state: "connected", url: remote })).toBe(true)
    expect(Pair.settled({ enabled: true, state: "error", error: "Certificate issuance failed" })).toBe(true)
    expect(Pair.settled({ enabled: true, state: "provisioning" })).toBe(false)
    expect(Pair.settled({ enabled: true, state: "connecting" })).toBe(false)
  })

  test("remote access states read as status lines", () => {
    expect(Pair.remoteSummary({ enabled: false, state: "off" })).toEqual({ tone: "muted", text: "Off", busy: false })
    expect(Pair.remoteSummary({ enabled: true, state: "connected", url: remote })).toEqual({
      tone: "success",
      text: "On",
      busy: false,
    })
    expect(Pair.remoteSummary({ enabled: true, state: "provisioning" })).toEqual({
      tone: "warning",
      text: "Setting up, this can take a minute…",
      busy: true,
    })
    expect(Pair.remoteSummary({ enabled: true, state: "connecting" }).text).toBe("Connecting…")
    expect(Pair.remoteSummary({ enabled: true, state: "connecting", error: "Tunnel closed" }).text).toBe(
      "Connecting… (Tunnel closed)",
    )
    expect(Pair.remoteSummary({ enabled: true, state: "error", error: "Certificate issuance failed" })).toEqual({
      tone: "error",
      text: "Certificate issuance failed",
      busy: false,
    })
    expect(Pair.remoteSummary({ enabled: true, state: "error" }).text).toBe("Remote access stopped")
  })

  test("failed requests explain themselves", () => {
    const response = (status: number) => new Response(null, { status })
    expect(Pair.failure({ error: {}, response: response(401) })).toBe("The server rejected this client's credentials.")
    expect(Pair.failure({ error: {}, response: response(404) })).toContain("does not support pairing")
    expect(
      Pair.failure({
        error: { _tag: "InvalidRequestError", message: "Pairing requires a server password" },
        response: response(400),
      }),
    ).toBe("Pairing requires a server password")
    expect(Pair.failure({ error: { data: { message: "Bad payload" } }, response: response(400) })).toBe("Bad payload")
    expect(Pair.failure({ error: "<html>Bad Gateway</html>", response: response(502) })).toBe(
      "The server responded with HTTP 502.",
    )
    expect(Pair.failure({ error: new TypeError("Unable to connect") })).toBe("Unable to connect")
    expect(Pair.failure({ error: {} })).toBe("Could not reach the server.")
  })
})
