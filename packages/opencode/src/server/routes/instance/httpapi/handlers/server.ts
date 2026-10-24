import { Duration, Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ServerAuth } from "@/server/auth"
import { ServerInfo } from "@/server/server-info"
import { ServerPairing } from "@/server/pairing"
import { RemoteAccess } from "@/server/remote"
import { InvalidRequestError, UnauthorizedError } from "../errors"
import { PairingConnectApi } from "../groups/server"
import { RootHttpApi } from "../api"

export const serverHandlers = HttpApiBuilder.group(RootHttpApi, "server", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* ServerAuth.Config

    return handlers
      .handle(
        "pair",
        Effect.fn("ServerHttpApi.pair")(function* () {
          if (!ServerAuth.required(auth))
            return yield* new InvalidRequestError({
              message: "Pairing requires a server password; set OPENCODE_SERVER_PASSWORD and restart the server",
            })
          return ServerPairing.issue()
        }),
      )
      .handle(
        "remote",
        Effect.fn("ServerHttpApi.remote")(function* () {
          return RemoteAccess.status()
        }),
      )
      .handle(
        "remoteUpdate",
        Effect.fn("ServerHttpApi.remoteUpdate")(function* (ctx) {
          if (!ctx.payload.enabled) return RemoteAccess.disable()
          // An open server must never be reachable from the internet.
          if (!ServerAuth.required(auth))
            return yield* new InvalidRequestError({
              message: "Remote access requires a server password; set OPENCODE_SERVER_PASSWORD and restart the server",
            })
          const target = ServerInfo.target()
          if (target === undefined)
            return yield* new InvalidRequestError({ message: "Remote access requires a network listener" })
          return RemoteAccess.enable({ target })
        }),
      )
  }),
)

export const pairingConnectHandlers = HttpApiBuilder.group(PairingConnectApi, "server.connect", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* ServerAuth.Config

    return handlers.handle(
      "connect",
      Effect.fn("ServerHttpApi.connect")(function* (ctx) {
        const request = yield* HttpServerRequest.HttpServerRequest
        // Browser navigations ask for HTML; everything else is an API client that wants the token.
        const browser = request.headers.accept?.includes("text/html") ?? false
        const token = ServerPairing.consume(ctx.params.code) ? ServerAuth.issueSession(auth) : undefined
        if (token === undefined) {
          if (!browser) return yield* new UnauthorizedError({ message: "Pairing link expired or already used" })
          return HttpServerResponse.text(
            "This pairing link expired or was already used. Run `opencode pair` to get a new one.",
            { status: 401 },
          )
        }
        if (!browser) return { token }
        return HttpServerResponse.redirect("/").pipe(
          HttpServerResponse.setCookieUnsafe(ServerAuth.sessionCookieName(request.headers.host), token, {
            path: "/",
            httpOnly: true,
            sameSite: "lax",
            maxAge: Duration.seconds(ServerAuth.SESSION_TTL_SECONDS),
          }),
        )
      }),
    )
  }),
)
