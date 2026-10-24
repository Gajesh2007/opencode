export * as PairingState from "./pairing-state"

import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { Option, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"

// This machine's pairing secrets, shared by every opencode process of the user:
// - `password`: generated when no OPENCODE_SERVER_PASSWORD is set. Paired devices' session tokens are signed
//   with it, so keeping it keeps them signed in across restarts; deleting the file signs every device out.
// - `route`: the random OpenTunnel subdomain for remote access. It keeps the public address unguessable, so it
//   is as sensitive as the password.
// - `remoteAccepted`: the user agreed once to expose the server to the internet.
export const Info = Schema.Struct({
  password: Schema.optional(Schema.String),
  route: Schema.optional(Schema.String),
  remoteAccepted: Schema.optional(Schema.Boolean),
})
export type Info = Schema.Schema.Type<typeof Info>

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Info))

export function file() {
  return path.join(Global.Path.config, "pairing.json")
}

/**
 * The saved state; empty when missing or corrupt. I/O errors throw: treating them as empty would make `password()`
 * replace a saved password it merely failed to read, signing out every paired device.
 */
export function read(): Info {
  const text = fs.existsSync(file()) ? fs.readFileSync(file(), "utf8") : ""
  return Option.getOrElse(decode(text), () => ({}))
}

export function write(info: Info) {
  const target = file()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  // Readable by the user only, and replaced atomically so a crash can't leave a truncated secret.
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(info, null, 2) + "\n", { mode: 0o600 })
  fs.renameSync(temp, target)
}

/** The saved server password, generated on first use. */
export function password() {
  const info = read()
  if (info.password) return info.password
  const next = randomBytes(32).toString("base64url")
  write({ ...info, password: next })
  return next
}

/** The saved remote-access route: 16 hex characters, generated on first use. */
export function route() {
  const info = read()
  if (info.route) return info.route
  const next = randomBytes(8).toString("hex")
  write({ ...info, route: next })
  return next
}

export function acceptRemote() {
  write({ ...read(), remoteAccepted: true })
}
