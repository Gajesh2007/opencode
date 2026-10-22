export * as ServerPairing from "./pairing"

import { randomBytes } from "node:crypto"

const TTL_SECONDS = 5 * 60
const TTL_MS = TTL_SECONDS * 1000

// One-time pairing codes. Process-global so every listener of this server can
// redeem a code issued through any other; swept lazily because codes are few
// and short-lived. Consumed codes are removed on first use.
const codes = new Map<string, number>()

export function issue(now = Date.now()) {
  const code = randomBytes(16).toString("base64url")
  codes.set(code, now + TTL_MS)
  sweep(now)
  return { code, expires_in: TTL_SECONDS }
}

export function consume(code: string, now = Date.now()) {
  sweep(now)
  const expires = codes.get(code)
  if (expires === undefined) return false
  codes.delete(code)
  return expires > now
}

function sweep(now: number) {
  for (const [code, expires] of codes) {
    if (expires <= now) codes.delete(code)
  }
}
