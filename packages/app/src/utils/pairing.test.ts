import { describe, expect, test } from "bun:test"
import { createPairingRedeemer, isMixedContent, pairingLink, redeemPairingLink } from "./pairing"

const token = "1767225600.signature"
const pairing = { url: "http://192.168.1.2:4096", username: "opencode", password: token }
const link = { urls: ["http://192.168.1.2:4096", "http://100.64.0.3:4096"], code: "abc" }

function fakeFetch(handler: (request: Request) => Response | Promise<Response>) {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof globalThis.fetch
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

const spent = () => json({ _tag: "UnauthorizedError", message: "Pairing link expired or already used" }, 401)

const unreachable = () => {
  throw new TypeError("Failed to fetch")
}

describe("pairing link", () => {
  test("reads the server address and code from opencode pair links", () => {
    expect(pairingLink(" http://192.168.1.2:49374/auth/connect/abc_DEF-123 ")).toEqual({
      urls: ["http://192.168.1.2:49374"],
      code: "abc_DEF-123",
    })
  })

  test("reads every server address from opencode pair QR codes", () => {
    expect(
      pairingLink(
        JSON.stringify({ code: "abc_DEF-123", urls: ["http://192.168.1.2:49374", "http://100.64.0.3:49374"] }),
      ),
    ).toEqual({
      urls: ["http://192.168.1.2:49374", "http://100.64.0.3:49374"],
      code: "abc_DEF-123",
    })
  })

  test("merges QR code addresses that name the same server", () => {
    expect(
      pairingLink(JSON.stringify({ code: "abc", urls: ["http://192.168.1.2:49374/", "http://192.168.1.2:49374"] })),
    ).toEqual({ urls: ["http://192.168.1.2:49374"], code: "abc" })
  })

  test("rejects other URLs", () => {
    expect(pairingLink("http://192.168.1.2:49374/auth/connect/")).toBeUndefined()
    expect(pairingLink("http://192.168.1.2:49374/auth/connect/abc/extra")).toBeUndefined()
    expect(pairingLink("http://192.168.1.2:49374/connect#abc")).toBeUndefined()
    expect(pairingLink("opencode-ios://auth/connect/abc")).toBeUndefined()
    expect(pairingLink("192.168.1.2:49374")).toBeUndefined()
    expect(pairingLink("http://localhost:4096")).toBeUndefined()
  })

  test("rejects malformed QR payloads", () => {
    expect(pairingLink(JSON.stringify({ code: "abc", urls: [] }))).toBeUndefined()
    expect(pairingLink(JSON.stringify({ code: "a/b", urls: ["http://192.168.1.2:49374"] }))).toBeUndefined()
    expect(pairingLink(JSON.stringify({ code: "abc", urls: ["opencode-ios://host"] }))).toBeUndefined()
    expect(pairingLink(JSON.stringify({ urls: ["http://192.168.1.2:49374"] }))).toBeUndefined()
    expect(pairingLink("{not json")).toBeUndefined()
  })

  test("rejects QR code addresses with credentials, a query, or a fragment", () => {
    expect(pairingLink(JSON.stringify({ code: "abc", urls: ["http://user:pass@192.168.1.2:49374"] }))).toBeUndefined()
    expect(pairingLink(JSON.stringify({ code: "abc", urls: ["http://192.168.1.2:49374/?next=1"] }))).toBeUndefined()
    expect(pairingLink(JSON.stringify({ code: "abc", urls: ["http://192.168.1.2:49374/#top"] }))).toBeUndefined()
  })
})

describe("mixed content", () => {
  test("flags plain HTTP servers from HTTPS pages", () => {
    expect(isMixedContent("https://app.example.com/", "http://192.168.1.2:4096")).toBe(true)
  })

  test("allows HTTPS servers, loopback servers, and HTTP pages", () => {
    expect(isMixedContent("https://app.example.com/", "https://opencode.example.com")).toBe(false)
    expect(isMixedContent("https://app.example.com/", "http://localhost:4096")).toBe(false)
    expect(isMixedContent("https://app.example.com/", "http://dev.localhost:4096")).toBe(false)
    expect(isMixedContent("https://app.example.com/", "http://127.0.0.1:4096")).toBe(false)
    expect(isMixedContent("https://app.example.com/", "http://[::1]:4096")).toBe(false)
    expect(isMixedContent("http://192.168.1.2:4096/", "http://192.168.1.3:4096")).toBe(false)
  })
})

describe("redeemPairingLink", () => {
  test("exchanges the code for a session token", async () => {
    const requests: Request[] = []
    const fetch = fakeFetch((request) => {
      requests.push(request)
      return json({ token })
    })

    expect(await redeemPairingLink({ urls: [pairing.url], code: "abc" }, fetch)).toEqual({ type: "paired", pairing })
    expect(requests.map((request) => request.url)).toEqual(["http://192.168.1.2:4096/auth/connect/abc"])
    // The server answers requests that accept HTML with a cookie and a redirect instead of the token.
    expect(requests[0]?.headers.get("accept") ?? "").not.toContain("text/html")
  })

  test("keeps the first address when another address spent the code first", async () => {
    const fetch = fakeFetch(async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/global/health")
        return request.headers.get("authorization") === `Basic ${btoa(`opencode:${token}`)}`
          ? json({ healthy: true, version: "1.0.0" })
          : json({}, 401)
      if (url.hostname === "100.64.0.3") return json({ token })
      await Bun.sleep(20)
      return spent()
    })

    expect(await redeemPairingLink(link, fetch)).toEqual({ type: "paired", pairing })
  })

  test("keeps the address that answered when the first address is unreachable", async () => {
    const fetch = fakeFetch((request) =>
      new URL(request.url).hostname === "192.168.1.2" ? unreachable() : json({ token }),
    )

    expect(await redeemPairingLink(link, fetch)).toEqual({
      type: "paired",
      pairing: { ...pairing, url: "http://100.64.0.3:4096" },
    })
  })

  test("reports a code any server refused as expired", async () => {
    expect(await redeemPairingLink(link, fakeFetch(spent))).toEqual({ type: "expired" })
    expect(
      await redeemPairingLink(
        link,
        fakeFetch((request) => (new URL(request.url).hostname === "192.168.1.2" ? unreachable() : spent())),
      ),
    ).toEqual({ type: "expired" })
  })

  test("reports servers that did not answer with a token as unreachable", async () => {
    expect(await redeemPairingLink(link, fakeFetch(unreachable))).toEqual({ type: "unreachable" })
    expect(
      await redeemPairingLink(
        link,
        fakeFetch(() => new Response("<!doctype html>", { headers: { "content-type": "text/html" } })),
      ),
    ).toEqual({ type: "unreachable" })
  })
})

describe("createPairingRedeemer", () => {
  test("reuses the token of a code it already redeemed", async () => {
    const requests: string[] = []
    const redeem = createPairingRedeemer(
      fakeFetch((request) => {
        requests.push(request.url)
        return requests.length === 1 ? json({ token }) : spent()
      }),
    )

    expect(await redeem({ urls: [pairing.url], code: "abc" })).toEqual({ type: "paired", pairing })
    expect(await redeem({ urls: [pairing.url], code: "abc" })).toEqual({ type: "paired", pairing })
    // An address the user edited since wins: the token works on every address of the server.
    expect(await redeem({ urls: ["http://localhost:4096"], code: "abc" })).toEqual({
      type: "paired",
      pairing: { ...pairing, url: "http://localhost:4096" },
    })
    expect(requests).toHaveLength(1)
  })

  test("tries a code again when no server answered", async () => {
    const requests: string[] = []
    const redeem = createPairingRedeemer(
      fakeFetch((request) => {
        requests.push(request.url)
        return requests.length === 1 ? unreachable() : json({ token })
      }),
    )

    expect(await redeem({ urls: [pairing.url], code: "abc" })).toEqual({ type: "unreachable" })
    expect(await redeem({ urls: [pairing.url], code: "abc" })).toEqual({ type: "paired", pairing })
  })
})
