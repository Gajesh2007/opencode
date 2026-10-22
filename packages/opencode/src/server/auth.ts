export * as ServerAuth from "./auth"

import { ConfigService } from "@/effect/config-service"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Config as EffectConfig, Context, Option, Redacted } from "effect"
import { createHmac, timingSafeEqual } from "node:crypto"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export class Config extends ConfigService.Service<Config>()("@opencode/ServerAuthConfig", {
  password: EffectConfig.string("OPENCODE_SERVER_PASSWORD").pipe(EffectConfig.option),
  username: EffectConfig.string("OPENCODE_SERVER_USERNAME").pipe(EffectConfig.withDefault("opencode")),
}) {}

export type Info = Context.Service.Shape<typeof Config>

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

// Session tokens issued by pairing links are accepted anywhere the password is.
export function authorized(credentials: DecodedCredentials, config: Info) {
  if (Option.isNone(config.password) || credentials.username !== config.username) return false
  const password = Redacted.value(credentials.password)
  return password === config.password.value || verifySession(password, config)
}

// Sessions are signed with a key derived from the server password, so rotating the password revokes every session.
export function issueSession(config: Info, now = Date.now()) {
  if (Option.isNone(config.password)) return
  const expires = String(Math.floor(now / 1000) + SESSION_TTL_SECONDS)
  return `${expires}.${sign(config.password.value, expires)}`
}

export function verifySession(token: string, config: Info, now = Date.now()) {
  if (Option.isNone(config.password)) return false
  const parts = token.split(".")
  if (parts.length !== 2) return false
  const expires = Number(parts[0])
  if (!Number.isSafeInteger(expires) || expires * 1000 <= now) return false
  const expected = Buffer.from(sign(config.password.value, parts[0]))
  const actual = Buffer.from(parts[1])
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// Browsers share cookies across ports on the same host, so the name carries the port to keep local servers apart.
export function sessionCookieName(host: string | undefined) {
  const port = URL.parse(`http://${host ?? ""}`)?.port
  return port ? `opencode_session_${port}` : "opencode_session"
}

function sign(password: string, payload: string) {
  const key = createHmac("sha256", password).update("opencode-session-v1").digest()
  return createHmac("sha256", key).update(payload).digest("base64url")
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
