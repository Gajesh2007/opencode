import { ServerAuth } from "@/server/auth"
import { Effect, Encoding, Layer, Redacted } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi"
import { hasPtyConnectTicketURL } from "@/server/shared/pty-ticket"
import { isPublicUIPath } from "@/server/shared/public-ui"
import { UnauthorizedError } from "../errors"

const AUTH_TOKEN_QUERY = "auth_token"
const UNAUTHORIZED = 401
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

// Avoid HttpApiSecurity alternatives here: Effect security middleware wraps the
// full handler, so a downstream failure can make the next auth alternative run
// and remap an authorized NotFound into Unauthorized.
export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  "@opencode/ExperimentalHttpApiAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

export class V2Authorization extends HttpApiMiddleware.Service<V2Authorization>()(
  "@opencode/ExperimentalHttpApiV2Authorization",
  {
    error: UnauthorizedError,
  },
) {}

function emptyCredential() {
  return {
    username: "",
    password: Redacted.make(""),
  }
}

function validateCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
  request: HttpServerRequest.HttpServerRequest,
) {
  return Effect.gen(function* () {
    if (!ServerAuth.required(config)) return yield* effect
    if (!ServerAuth.authorized(credential, config) && !authorizedSessionCookie(request, config)) {
      yield* challenge(request)
      return yield* new HttpApiError.Unauthorized({})
    }
    return yield* effect
  })
}

// Browsers show a native credentials prompt for a Basic challenge even on fetch, which would stall the web app
// before it can show its own sign-in screen. Only non-browser clients and page navigations get the challenge.
function challengeRequest(request: HttpServerRequest.HttpServerRequest) {
  const mode = request.headers["sec-fetch-mode"]
  return mode === undefined || mode === "navigate"
}

function challenge(request: HttpServerRequest.HttpServerRequest) {
  if (!challengeRequest(request)) return Effect.void
  return HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
  )
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        // The user-id cannot contain a colon but the password can (RFC 7617), so split at the first one.
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return {
          username: header.slice(0, separator),
          password: Redacted.make(header.slice(separator + 1)),
        }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  return credentialFromURL(new URL(request.url, "http://localhost"), request)
}

function credentialFromURL(url: URL, request: HttpServerRequest.HttpServerRequest) {
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

// Session cookies issued by pairing links are accepted anywhere the password is.
function authorizedSessionCookie(request: HttpServerRequest.HttpServerRequest, config: ServerAuth.Info) {
  const token = request.cookies[ServerAuth.sessionCookieName(request.headers.host)]
  if (!token) return false
  // Same-site pages on other ports still send this cookie, so only same-origin requests may use it.
  const origin = request.headers.origin
  if (origin !== undefined && URL.parse(origin)?.host !== request.headers.host) return false
  return ServerAuth.verifySession(token, config)
}

function validateRawCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
  request: HttpServerRequest.HttpServerRequest,
) {
  if (!ServerAuth.required(config)) return effect
  if (!ServerAuth.authorized(credential, config) && !authorizedSessionCookie(request, config))
    return Effect.succeed(
      HttpServerResponse.empty({
        status: UNAUTHORIZED,
        headers: challengeRequest(request) ? { "www-authenticate": WWW_AUTHENTICATE } : undefined,
      }),
    )
  return effect
}

export const authorizationRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config)) return (effect) => effect

    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (isPublicUIPath(request.method, url.pathname)) return yield* effect
        if (hasPtyConnectTicketURL(url)) return yield* effect
        return yield* credentialFromURL(url, request).pipe(
          Effect.flatMap((credential) => validateRawCredential(effect, credential, config, request)),
        )
      })
  }),
)

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config)) return Authorization.of((effect) => effect)
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* credentialFromRequest(request).pipe(
          Effect.flatMap((credential) => validateCredential(effect, credential, config, request)),
        )
      }),
    )
  }),
)

export const v2AuthorizationLayer = Layer.effect(
  V2Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config)) return V2Authorization.of((effect) => effect)
    return V2Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* credentialFromRequest(request).pipe(
          Effect.flatMap((credential) =>
            Effect.gen(function* () {
              if (ServerAuth.authorized(credential, config) || authorizedSessionCookie(request, config))
                return yield* effect
              yield* challenge(request)
              return yield* new UnauthorizedError({ message: "Authentication required" })
            }),
          ),
        )
      }),
    )
  }),
)
