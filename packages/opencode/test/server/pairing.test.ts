import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ServerAuth } from "../../src/server/auth"
import { ServerPairing } from "../../src/server/pairing"
import { ServerInfo } from "../../src/server/server-info"
import { PairingConnectApi } from "../../src/server/routes/instance/httpapi/groups/server"
import { pairingConnectHandlers } from "../../src/server/routes/instance/httpapi/handlers/server"
import { authorizationRouterMiddleware } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const config = (password: string) =>
  ({ password: Option.some(password), username: "opencode" }) satisfies ServerAuth.Info

describe("ServerPairing codes", () => {
  test("issued codes are single-use", () => {
    const { code } = ServerPairing.issue()
    expect(ServerPairing.consume(code)).toBe(true)
    expect(ServerPairing.consume(code)).toBe(false)
  })

  test("unknown codes are rejected", () => {
    expect(ServerPairing.consume("missing")).toBe(false)
  })

  test("codes expire after their TTL", () => {
    const { code, expires_in } = ServerPairing.issue(0)
    expect(expires_in).toBe(300)
    expect(ServerPairing.consume(code, 300_001)).toBe(false)
  })

  test("codes are url-safe and distinct", () => {
    const a = ServerPairing.issue()
    const b = ServerPairing.issue()
    expect(a.code).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.code).not.toBe(b.code)
  })

  test("keeps at most 1000 live codes, evicting the oldest", () => {
    const oldest = ServerPairing.issue()
    const newer = Array.from({ length: 1000 }, () => ServerPairing.issue())

    expect(ServerPairing.consume(oldest.code)).toBe(false)
    expect(newer.filter((issued) => !ServerPairing.consume(issued.code))).toEqual([])
  })
})

describe("ServerAuth sessions", () => {
  test("issued session verifies and is accepted as the password", () => {
    const cfg = config("secret")
    const token = ServerAuth.issueSession(cfg)
    expect(token).toBeDefined()
    expect(ServerAuth.verifySession(token!, cfg)).toBe(true)
    expect(
      ServerAuth.authorized({ username: "opencode", password: Redacted.make(token!) }, cfg),
    ).toBe(true)
  })

  test("sessions expire", () => {
    const cfg = config("secret")
    const token = ServerAuth.issueSession(cfg, 0)!
    expect(ServerAuth.verifySession(token, cfg, 0)).toBe(true)
    expect(ServerAuth.verifySession(token, cfg, (30 * 24 * 60 * 60 + 1) * 1000)).toBe(false)
  })

  test("rotating the password revokes every session", () => {
    const token = ServerAuth.issueSession(config("old"))!
    expect(ServerAuth.verifySession(token, config("new"))).toBe(false)
  })

  test("tampered or malformed tokens are rejected", () => {
    const cfg = config("secret")
    const token = ServerAuth.issueSession(cfg)!
    expect(ServerAuth.verifySession(`${token}x`, cfg)).toBe(false)
    expect(ServerAuth.verifySession("not-a-token", cfg)).toBe(false)
    expect(ServerAuth.verifySession("123.only", cfg)).toBe(false)
  })

  test("no password configured means no sessions", () => {
    const cfg = { password: Option.none<string>(), username: "opencode" } satisfies ServerAuth.Info
    expect(ServerAuth.issueSession(cfg)).toBeUndefined()
    expect(ServerAuth.verifySession("anything", cfg)).toBe(false)
  })

  test("session cookie name carries the port to keep local servers apart", () => {
    expect(ServerAuth.sessionCookieName("localhost:4096")).toBe("opencode_session_4096")
    expect(ServerAuth.sessionCookieName(undefined)).toBe("opencode_session")
  })
})

describe("ServerInfo connectionURLs", () => {
  test("specific hosts stay unchanged", () => {
    expect(ServerInfo.connectionURLs("http://127.0.0.1:4096")).toEqual(["http://127.0.0.1:4096"])
  })

  test("IPv4 wildcard bindings expand to loopback plus interface addresses", () => {
    const urls = ServerInfo.connectionURLs("http://0.0.0.0:4096")
    expect(urls[0]).toBe("http://127.0.0.1:4096")
    for (const url of urls.slice(1)) {
      const hostname = new URL(url).hostname
      expect(hostname).not.toBe("127.0.0.1")
      expect(url.endsWith(`:${new URL(url).port}`)).toBe(true)
    }
  })
})

const probeRoute = HttpRouter.use((router) =>
  router.add("GET", "/probe", () => Effect.succeed(HttpServerResponse.text("ok"))),
)

const pairingServer = (auth: Layer.Layer<ServerAuth.Config>) =>
  HttpRouter.serve(
    Layer.mergeAll(
      HttpApiBuilder.layer(PairingConnectApi).pipe(
        Layer.provide(pairingConnectHandlers),
        Layer.provide(schemaErrorLayer),
      ),
      probeRoute.pipe(Layer.provide(authorizationRouterMiddleware.layer)),
    ).pipe(Layer.provide(auth)),
    { disableListenLog: true, disableLogger: true },
  ).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const secretLayer = ServerAuth.Config.layer({ password: Option.some("secret"), username: "opencode" })
const noAuthLayer = ServerAuth.Config.layer({ password: Option.none(), username: "opencode" })

const itSecret = testEffect(pairingServer(secretLayer))
const itNoAuth = testEffect(pairingServer(noAuthLayer))

const get = (path: string, headers?: Record<string, string>) =>
  HttpClientRequest.get(path).pipe(
    headers ? HttpClientRequest.setHeaders(headers) : (request) => request,
    HttpClient.execute,
  )

const connect = (code: string, headers?: Record<string, string>) => get(`/auth/connect/${code}`, headers)

const PairingToken = Schema.Struct({ token: Schema.String })

const redeemJSON = (code: string) =>
  Effect.gen(function* () {
    const response = yield* connect(code)
    const body = yield* Effect.orDie(Schema.decodeUnknownEffect(PairingToken)(yield* response.json))
    return { response, body }
  })

describe("pairing link redemption", () => {
  itSecret.live("issues a session token for API clients", () =>
    Effect.gen(function* () {
      const { code } = ServerPairing.issue()
      const { response, body } = yield* redeemJSON(code)

      expect(response.status).toBe(200)
      expect(body.token).toMatch(/^\d+\./)
      expect(ServerAuth.verifySession(body.token, config("secret"))).toBe(true)
    }),
  )

  itSecret.live("codes work exactly once", () =>
    Effect.gen(function* () {
      const { code } = ServerPairing.issue()
      const first = yield* connect(code)
      const second = yield* connect(code)

      expect(first.status).toBe(200)
      expect(second.status).toBe(401)
    }),
  )

  itSecret.live("the token works as the basic auth password", () =>
    Effect.gen(function* () {
      const { code } = ServerPairing.issue()
      const { body } = yield* redeemJSON(code)

      const [withToken, wrongPassword] = yield* Effect.all(
        [
          get("/probe", { authorization: ServerAuth.header({ password: body.token }) ?? "" }),
          get("/probe", { authorization: ServerAuth.header({ password: "wrong" }) ?? "" }),
        ],
        { concurrency: "unbounded" },
      )

      expect(withToken.status).toBe(200)
      expect(wrongPassword.status).toBe(401)
    }),
  )

  itSecret.live("browsers get a session cookie and a redirect to the web UI", () =>
    Effect.gen(function* () {
      // The layerTest client follows redirects inside fetch, so drive the
      // browser flow with a manual-redirect fetch against the real listener.
      const server = yield* HttpServer.HttpServer
      if (server.address._tag !== "TcpAddress") return yield* Effect.die(new Error("expected TcpAddress"))
      const base = `http://${server.address.hostname}:${server.address.port}`
      const { code } = ServerPairing.issue()
      const redirect = yield* Effect.promise(() =>
        fetch(`${base}/auth/connect/${code}`, {
          headers: { accept: "text/html" },
          redirect: "manual",
        }),
      )

      expect(redirect.status).toBe(302)
      expect(redirect.headers.get("location")).toBe("/")
      const setCookie = redirect.headers.get("set-cookie") ?? ""
      const [cookie] = setCookie.split(";")
      expect(cookie).toContain("opencode_session_")
      expect(setCookie).toContain("HttpOnly")

      // The session cookie authenticates the browser like the password does.
      const [withCookie, withoutCookie] = yield* Effect.all(
        [get("/probe", { cookie }), Effect.promise(() => fetch(`${base}/probe`).then((response) => response.status))],
        { concurrency: "unbounded" },
      )
      expect(withCookie.status).toBe(200)
      expect(withoutCookie).toBe(401)
    }),
  )

  itNoAuth.live("servers without a password cannot issue sessions", () =>
    Effect.gen(function* () {
      const { code } = ServerPairing.issue()
      const response = yield* connect(code)

      expect(response.status).toBe(401)
    }),
  )
})
