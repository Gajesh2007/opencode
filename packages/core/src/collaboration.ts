export * as Collaboration from "./collaboration.js"

import { makeGlobalNode, Node } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Deferred, Effect, Context, Layer, Option, Schema, Stream } from "effect"
import path from "node:path"
import { Session } from "./session.js"
import { Job } from "./job.js"
import { Bus } from "./bus.js"
import { KeyedMutex } from "./effect/keyed-mutex.js"
import { SessionEvent } from "./session/event.js"

const Identity = Schema.Struct({ root: Session.ID, path: Schema.String, sessionID: Session.ID })
const decodeIdentity = Schema.decodeUnknownOption(Identity)
export type Member = {
  readonly session: Session.Info
  readonly root: Session.ID
  readonly path: string
  readonly status: string
}
export class Invalid extends Schema.TaggedError<Invalid>()("Collaboration.Invalid", { message: Schema.String }) {}

export interface Interface {
  readonly register: (parent: Session.ID, child: Session.ID, name?: string) => Effect.Effect<Member, Invalid>
  readonly member: (id: Session.ID) => Effect.Effect<Member>
  readonly list: (id: Session.ID) => Effect.Effect<ReadonlyArray<Member>>
  readonly resolve: (id: Session.ID, target: string) => Effect.Effect<Member, Invalid>
  readonly send: (from: Session.ID, target: string, message: string) => Effect.Effect<Member, Invalid>
  readonly wait: (
    id: Session.ID,
    timeout: number,
  ) => Effect.Effect<ReadonlyArray<{ from: string; text: string }>, Invalid>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/Collaboration") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const bus = yield* Bus.Service
    const mutex = yield* KeyedMutex.make<Session.ID>()

    const children = Effect.fn("Collaboration.children")(function* (parentID: Session.ID) {
      const result: Session.Info[] = []
      let cursor: Session.ListCursor | undefined
      do {
        const page = yield* sessions.list({ parentID, limit: 500, ...(cursor ? { cursor } : {}) }).pipe(Effect.orDie)
        result.push(...page.data)
        cursor = page.cursor.next
      } while (cursor)
      return result
    })
    const member: Interface["member"] = Effect.fn("Collaboration.member")(function* (id) {
      const session = yield* sessions.get(id).pipe(Effect.orDie)
      const recorded = Option.getOrUndefined(decodeIdentity(session.metadata?.collaboration))
      const identity = recorded?.sessionID === session.id ? recorded : undefined
      const inherited = session.parentID ? yield* member(session.parentID) : undefined
      return {
        session,
        root: identity?.root ?? inherited?.root ?? session.id,
        path: identity?.path ?? (inherited ? `${inherited.path}/${session.id}` : "/root"),
        status:
          (yield* jobs.get(id))?.status ?? ((yield* sessions.active).has(id) ? "running" : (session.outcome ?? "idle")),
      }
    })
    const list: Interface["list"] = Effect.fn("Collaboration.list")(function* (id) {
      const root = yield* member((yield* member(id)).root)
      const result: Member[] = [root]
      const pending = [root.session.id]
      while (pending.length) {
        const parent = pending.pop()
        if (parent === undefined) break
        for (const child of yield* children(parent)) {
          result.push(yield* member(child.id))
          pending.push(child.id)
        }
      }
      return result
    })
    const resolve: Interface["resolve"] = Effect.fn("Collaboration.resolve")(function* (id, target) {
      const current = yield* member(id)
      const requested = target.startsWith("/") ? path.posix.normalize(target) : path.posix.resolve(current.path, target)
      const found = (yield* list(id)).find((item) => item.session.id === target || item.path === requested)
      if (!found) return yield* new Invalid({ message: `Unknown agent in this family: ${target}` })
      return found
    })
    const inbox = Effect.fn("Collaboration.inbox")(function* (id: Session.ID) {
      return (yield* sessions.inbox(id).pipe(Effect.orDie)).filter(
        (item) =>
          item.type === "synthetic" &&
          (item.payload.metadata?.source === "collaboration" || item.payload.metadata?.source === "subagent"),
      )
    })
    return Service.of({
      member,
      list,
      resolve,
      register: (parentID, childID, name) =>
        mutex.withLock(parentID)(
          Effect.gen(function* () {
            const parent = yield* member(parentID)
            const child = yield* sessions.get(childID).pipe(Effect.orDie)
            if (child.parentID !== parentID)
              return yield* new Invalid({ message: "Only a direct parent may name its child agent." })
            const segment = name ?? childID
            if (!/^[a-zA-Z0-9_-]+$/.test(segment))
              return yield* new Invalid({
                message: "Agent names must contain letters, numbers, underscores or hyphens.",
              })
            const target = `${parent.path}/${segment}`
            for (const existing of yield* children(parentID)) {
              if (existing.id !== childID && (yield* member(existing.id)).path === target)
                return yield* new Invalid({ message: `Agent name is already used: ${segment}` })
            }
            yield* sessions
              .setMetadata({
                sessionID: childID,
                metadata: { ...child.metadata, collaboration: { root: parent.root, path: target, sessionID: childID } },
              })
              .pipe(Effect.orDie)
            return yield* member(childID)
          }),
        ),
      send: Effect.fn("Collaboration.send")(function* (id, target, message) {
        if (!message.trim() || message.length > 64000)
          return yield* new Invalid({ message: "Agent messages must contain 1–64000 characters." })
        const from = yield* member(id)
        const to = yield* resolve(id, target)
        yield* sessions
          .synthetic({
            sessionID: to.session.id,
            resume: false,
            text: `Message from ${from.path}:\n${message}`,
            metadata: { source: "collaboration", from: from.path },
          })
          .pipe(Effect.orDie)
        return to
      }),
      wait: (id, timeout) =>
        mutex.withLock(id)(
          Effect.gen(function* () {
            if (!Number.isFinite(timeout) || timeout < 0 || timeout > 600)
              return yield* new Invalid({ message: "Wait timeout must be between 0 and 600 seconds." })
            const signal = yield* Deferred.make<void>()
            yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
              Stream.filter(
                (event) =>
                  event.data.sessionID === id &&
                  event.data.item.type === "synthetic" &&
                  (event.data.item.payload.metadata?.source === "collaboration" ||
                    event.data.item.payload.metadata?.source === "subagent"),
              ),
              Stream.runForEach(() => Deferred.succeed(signal, undefined)),
              Effect.forkScoped({ startImmediately: true }),
            )
            if (!(yield* inbox(id)).length)
              yield* Deferred.await(signal).pipe(Effect.timeoutOption(`${timeout} seconds`))
            const messages = yield* inbox(id)
            const result: { from: string; text: string }[] = []
            for (const item of messages) {
              if (item.type !== "synthetic") continue
              yield* sessions.cancelInbox({ sessionID: id, inboxID: item.id }).pipe(Effect.orDie)
              result.push({ from: String(item.payload.metadata?.from ?? "agent"), text: item.payload.text })
            }
            return result
          }).pipe(Effect.scoped),
        ),
    })
  }),
)

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = makeGlobalNode({
  service: Service,
  layer,
  deps: [Session.node, Job.node, Bus.node],
})
