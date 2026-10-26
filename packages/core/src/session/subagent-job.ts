export * as SubagentJob from "./subagent-job.js"

import { Context, Effect, Layer, Scope, Semaphore } from "effect"
import { Node } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Job } from "../job.js"
import { Session } from "../session.js"
import { SubagentCompletion } from "./subagent-completion.js"

type Recovery = Extract<Job.Recovery, { kind: "subagent" }>

export interface Interface {
  start: (recovery: Recovery, limiter?: Semaphore.Semaphore) => Effect.Effect<Job.Info>
  background: (recovery: Recovery) => Effect.Effect<void>
  notify: (recovery: Recovery, startedAt: number) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentJob") {}

const make: Effect.Effect<Interface, never, Session.Service | Job.Service | Scope.Scope> = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const jobs = yield* Job.Service
  const scope = yield* Scope.Scope
  // Jobs and their completion observers outlive the plugin that launched them.
  // Fork with the global context too, rather than retaining the caller's location.
  const context = yield* Effect.context<never>()
  // One observer per job generation, including continuations of the same child.
  const notifications = new Set<string>()

  const notify = Effect.fn("SubagentJob.notify")(function* (recovery: Recovery, startedAt: number) {
    const key = `${recovery.childSessionID}:${startedAt}`
    if (notifications.has(key)) return
    notifications.add(key)
    yield* Effect.gen(function* () {
      const info = (yield* jobs.wait({ id: recovery.childSessionID })).info
      if (info) {
        const parent = yield* sessions.get(recovery.parentSessionID).pipe(Effect.orElseSucceed(() => undefined))
        if (!parent) return
        const active = yield* sessions.active
        yield* SubagentCompletion.deliver(sessions, jobs, {
          ...info,
          recovery,
          resume: parent.outcome === "interrupted" && !active.has(parent.id) ? false : undefined,
        })
      }
    }).pipe(
      Effect.ensuring(Effect.sync(() => notifications.delete(key))),
      Effect.forkIn(scope, { startImmediately: true }),
      Effect.setContext(context),
    )
  })

  return Service.of({
    start: (recovery: Recovery, limiter) =>
      jobs
        .start({
          id: recovery.childSessionID,
          type: "subagent",
          title: recovery.description,
          metadata: {},
          recovery,
          run: Effect.gen(function* () {
            yield* sessions.resume(recovery.childSessionID)
            let messages = yield* sessions.messages({ sessionID: recovery.childSessionID, order: "desc", limit: 20 })
            let assistant = messages.find(
              (message) =>
                message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
            )
            if (assistant && SubagentCompletion.text(assistant) === SubagentCompletion.NO_TEXT) {
              yield* sessions.synthetic({
                sessionID: recovery.childSessionID,
                resume: false,
                text: "Provide your final written response for the parent agent, including findings and remaining limitations. Do not repeat completed tool work.",
              })
              yield* sessions.resume(recovery.childSessionID)
              messages = yield* sessions.messages({ sessionID: recovery.childSessionID, order: "desc", limit: 20 })
              assistant = messages.find(
                (message) =>
                  message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
              )
            }
            return SubagentCompletion.text(assistant)
          }).pipe((effect) => (limiter ? limiter.withPermit(effect) : effect)),
        })
        .pipe(Effect.setContext(context)),
    background: Effect.fn("SubagentJob.background")(function* (recovery: Recovery) {
      const info = yield* jobs.background(recovery.childSessionID)
      if (info) yield* notify(recovery, info.started_at)
    }),
    notify,
  })
})

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Service,
  layer: Layer.effect(Service, make),
  deps: [Session.node, Job.node],
})
