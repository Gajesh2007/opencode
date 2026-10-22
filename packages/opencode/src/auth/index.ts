import path from "path"
import { createHash, randomUUID } from "node:crypto"
import { Effect, Layer, Record, Result, Schema, Context, Option } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")
const ENV_SNAPSHOT = "$opencode_auth_content"
const REVISIONS = "$opencode_auth_revisions"
const revisions = new WeakMap<Info, string>()
// Timestamps are not trusted to reveal a rewrite this soon after the previous
// one (same-millisecond or coarse-mtime writes), so recent files are re-read.
const SETTLE_MS = 2_000

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

function migrateOpenAIOAuth(data: Record<string, Info>) {
  if (data.openai?.type !== "oauth") return data
  const migrated = { ...data }
  migrated["openai-codex"] ??= migrated.openai
  delete migrated.openai
  return migrated
}

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
  conflict: Schema.optional(Schema.Boolean),
}) {}

function credential(info: Info | undefined) {
  const value = !info
    ? null
    : info.type === "oauth"
      ? [info.type, info.refresh, info.access, info.expires, info.accountId ?? null, info.enterpriseUrl ?? null]
      : info.type === "api"
        ? [info.type, info.key, Object.entries(info.metadata ?? {}).sort(([a], [b]) => a.localeCompare(b))]
        : [info.type, info.key, info.token]
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function fingerprint(info: Info | undefined) {
  // Only service-returned snapshots carry the private persisted revision needed
  // for a conditional write. Copying credentials deliberately loses that token.
  const revision = info && revisions.get(info)
  return `"${credential(info)}${revision ? `.${revision}` : ""}"`
}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info, expected?: string) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* AppFileSystem.Service
    const flock = yield* EffectFlock.Service
    const decode = Schema.decodeUnknownOption(Info)
    const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
    const decodeRevisions = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.String))
    const decodeEnv = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))
    const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      flock
        .withLock(effect, "auth.json", path.join(path.dirname(file), ".auth-locks"))
        .pipe(
          Effect.mapError((error) =>
            error instanceof EffectFlock.LockTimeoutError || error instanceof EffectFlock.LockCompromisedError
              ? new AuthError({ message: "Failed to lock auth data" })
              : error,
          ),
        )

    const read = Effect.fn("Auth.read")(function* () {
      const source = process.env.OPENCODE_AUTH_CONTENT ?? ""
      const env = Option.getOrUndefined(decodeEnv(source))
      const snapshot = env ? createHash("sha256").update(source).digest("hex") : undefined
      const disk: Record<string, unknown> = Option.getOrElse(
        decodeRecord(yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))),
        () => ({}),
      )
      const persisted = migrateOpenAIOAuth(
        Record.filterMap(disk, (value) => Result.fromOption(decode(value), () => undefined)),
      )
      const versions: Record<string, string> = Option.getOrElse(decodeRevisions(disk[REVISIONS]), () => ({}))
      const configured = migrateOpenAIOAuth(
        Record.filterMap(env ?? {}, (value) => Result.fromOption(decode(value), () => undefined)),
      )
      // Once this snapshot has been written, disk overrides it. Keep only env
      // providers that have never been persisted, without resurrecting removals.
      const effective =
        env && disk[ENV_SNAPSHOT] !== snapshot
          ? configured
          : {
              ...Object.fromEntries(
                Object.entries(configured).filter(([key]) => {
                  const norm = key.replace(/\/+$/, "")
                  return (
                    persisted[key] === undefined &&
                    persisted[norm] === undefined &&
                    versions[key] === undefined &&
                    versions[norm] === undefined
                  )
                }),
              ),
              ...persisted,
            }
      for (const [key, value] of Object.entries(effective)) {
        const norm = key.replace(/\/+$/, "")
        revisions.set(value, versions[key] ?? versions[norm] ?? credential(persisted[key] ?? persisted[norm]))
      }
      return {
        data: effective,
        persisted,
        versions,
        // Writers without an env override retain its marker so their account
        // changes remain visible to processes still using that snapshot.
        snapshot: snapshot ?? (typeof disk[ENV_SNAPSHOT] === "string" ? disk[ENV_SNAPSHOT] : undefined),
      }
    })

    const write = Effect.fn("Auth.write")(function* (
      data: Record<string, Info>,
      snapshot: string | undefined,
      versions: Record<string, string>,
    ) {
      const temporary = `${file}.${randomUUID()}.tmp`
      yield* fsys
        .writeFileString(
          temporary,
          JSON.stringify({ ...data, [REVISIONS]: versions, ...(snapshot && { [ENV_SNAPSHOT]: snapshot }) }, null, 2),
          {
            flag: "wx",
            mode: 0o600,
          },
        )
        .pipe(
          Effect.andThen(fsys.rename(temporary, file)),
          Effect.ensuring(fsys.remove(temporary).pipe(Effect.ignore)),
          Effect.mapError(fail("Failed to write auth data")),
        )
    })

    // Every model request reads credentials. Writers replace auth.json by atomic
    // rename, so an unchanged file identity means the parsed state is current:
    // serve it without the cross-process lock, which otherwise backs off for
    // 100ms+ whenever parallel sessions read at the same moment.
    let cache: { identity: string; source: string; data: Record<string, Info> } | undefined
    const identity = fsys.stat(file).pipe(
      Effect.map((info) => ({
        key: [
          Option.getOrUndefined(info.ino),
          String(info.size),
          Option.getOrUndefined(info.mtime)?.getTime(),
          Option.getOrUndefined(info.birthtime)?.getTime(),
        ].join(":"),
        settled: Date.now() - (Option.getOrUndefined(info.mtime)?.getTime() ?? Date.now()) > SETTLE_MS,
      })),
      Effect.orElseSucceed(() => ({ key: "missing", settled: true })),
    )

    const all = Effect.fn("Auth.all")(function* () {
      const source = process.env.OPENCODE_AUTH_CONTENT ?? ""
      // Stat before reading: a write landing in between only costs one more read.
      const current = yield* identity
      if (current.settled && cache?.identity === current.key && cache.source === source) return { ...cache.data }
      const state = yield* read().pipe(locked)
      cache = { identity: current.key, source, data: state.data }
      return { ...state.data }
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info, expected?: string) {
      const norm = key.replace(/\/+$/, "")
      const state = yield* read()
      if (expected !== undefined) {
        const current = state.data[norm] ?? state.data[key]
        const stored = state.persisted[norm] ?? state.persisted[key]
        // A stale environment may still select A after another process persists B.
        // Check disk identity too, and keep tombstones so removal cannot resurrect A.
        if (
          !current ||
          !revisions.has(current) ||
          fingerprint(current) !== expected ||
          ((stored !== undefined || state.versions[norm] !== undefined) && credential(stored) !== credential(current))
        )
          return yield* new AuthError({ message: "Authentication credentials changed", conflict: true })
      }
      if (norm !== key) delete state.persisted[key]
      delete state.persisted[norm + "/"]
      cache = undefined
      yield* write({ ...state.persisted, [norm]: info }, state.snapshot, { ...state.versions, [norm]: randomUUID() })
    }, locked)

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const state = yield* read()
      delete state.persisted[key]
      delete state.persisted[norm]
      delete state.persisted[norm + "/"]
      cache = undefined
      yield* write(state.persisted, state.snapshot, { ...state.versions, [norm]: randomUUID() })
    }, locked)

    return Service.of({ get, all, set, remove })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(EffectFlock.defaultLayer),
)

export * as Auth from "."
