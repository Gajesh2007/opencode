import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"
import { SchemaErrorMiddleware } from "../middleware/schema-error"
import { InvalidRequestError, UnauthorizedError } from "../errors"

export const PAIRING_CONNECT_PATH = "/auth/connect/:code"

export const RemoteStatus = Schema.Struct({
  enabled: Schema.Boolean,
  // "provisioning": this device has no tunnel yet; issuing its certificate can take a minute.
  state: Schema.Literals(["off", "provisioning", "connecting", "connected", "error"]),
  url: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "RemoteStatus" })
export type RemoteStatus = typeof RemoteStatus.Type

export const RemoteUpdate = Schema.Struct({
  enabled: Schema.Boolean,
})

export const PairingCode = Schema.Struct({
  code: Schema.String,
  expires_in: Schema.Int,
}).annotate({ identifier: "PairingCode" })
export type PairingCode = typeof PairingCode.Type

export const PairingSession = Schema.Struct({
  token: Schema.String,
}).annotate({ identifier: "PairingSession" })
export type PairingSession = typeof PairingSession.Type

// Secured by RootHttpApi's Authorization middleware, like every other root group.
// Deliberately no GET /api/info here: a ServerInfo-shaped body at that path makes
// clients that probe both contracts classify this server as OpenCode 2.x, but the
// v2 /api surface of this server is experimental. The app-facing info lives at
// /global/info, and /global/health is what contract probes should match on.
export const ServerApi = HttpApi.make("server").add(
  HttpApiGroup.make("server")
    .add(
      HttpApiEndpoint.post("pair", "/api/pair", {
        success: described(PairingCode, "Short-lived, single-use pairing code"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "server.pair",
          summary: "Create pairing code",
          description: "Create a short-lived, single-use code for a /auth/connect/:code pairing link.",
        }),
      ),
      HttpApiEndpoint.get("remote", "/api/remote", {
        success: described(RemoteStatus, "Remote access status"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "server.remote",
          summary: "Get remote access status",
          description: "Whether this server is reachable from the internet through its OpenTunnel route, and at which URL.",
        }),
      ),
      HttpApiEndpoint.post("remoteUpdate", "/api/remote", {
        payload: RemoteUpdate,
        success: described(RemoteStatus, "Remote access status after the change"),
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "server.remoteUpdate",
          summary: "Turn remote access on or off",
          description:
            "Expose this server to the internet through an end-to-end encrypted OpenTunnel route, or stop. Requires a server password and a network listener. The tunnel attaches in the background; poll server.remote for its URL. Clients must ask the user before enabling it the first time.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "server", description: "Server routes." })),
)

// Redeeming a pairing link must work without credentials — the code itself is
// the credential — so this group deliberately carries no Authorization middleware.
export const PairingConnectApi = HttpApi.make("pairing")
  .add(
    HttpApiGroup.make("server.connect")
      .add(
        HttpApiEndpoint.get("connect", PAIRING_CONNECT_PATH, {
          params: { code: Schema.String },
          success: described(PairingSession, "Session token usable as the server password"),
          error: UnauthorizedError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "server.connect",
            summary: "Redeem pairing code",
            description:
              "Redeem a pairing code. Browsers receive a session cookie and a redirect to the web UI; requests that accept JSON receive a session token to use as the password.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "pairing", description: "Pairing link redemption." })),
  )
  .middleware(SchemaErrorMiddleware)
