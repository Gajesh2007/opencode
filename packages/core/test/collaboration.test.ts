import { expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { Collaboration } from "@opencode/core/collaboration"
import { Bus } from "@opencode/core/bus"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { promptLocationNode } from "./fixture/prompt-location"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Collaboration.node, Session.node]), [
    Bus.node.replace(Bus.configured({ persist: true })),
    Project.node.replace(globalProjectNode),
    LocationServiceMap.node.replace(promptLocationNode),
    SessionExecution.node.replace(SessionExecution.noopLayer),
  ]),
)

it.effect("resolves named child and sibling agents only inside their family", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const collaboration = yield* Collaboration.Service
    const root = yield* sessions.create({ location: { directory: AbsolutePath.make("/collaboration") } })
    const one = yield* sessions.create({ parentID: root.id })
    const two = yield* sessions.create({ parentID: root.id })
    yield* collaboration.register(root.id, one.id, "reader")
    yield* collaboration.register(root.id, two.id, "writer")
    const grandchild = yield* sessions.create({ parentID: one.id })
    expect((yield* collaboration.member(grandchild.id)).path).toBe("/root/reader/" + grandchild.id)
    yield* sessions.remove(grandchild.id)
    expect((yield* collaboration.resolve(one.id, "../writer")).session.id).toBe(two.id)
    expect((yield* collaboration.resolve(root.id, "reader")).path).toBe("/root/reader")
    expect((yield* collaboration.list(root.id)).map((member) => member.path).sort()).toEqual([
      "/root",
      "/root/reader",
      "/root/writer",
    ])
    const foreign = yield* sessions.create({ location: { directory: AbsolutePath.make("/elsewhere") } })
    expect(yield* collaboration.resolve(root.id, foreign.id).pipe(Effect.flip)).toBeInstanceOf(Collaboration.Invalid)
    expect(yield* collaboration.register(root.id, two.id, "reader").pipe(Effect.flip)).toBeInstanceOf(
      Collaboration.Invalid,
    )
  }),
)

it.effect("delivers a family message once without starting an idle recipient", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const collaboration = yield* Collaboration.Service
    const root = yield* sessions.create({ location: { directory: AbsolutePath.make("/collaboration") } })
    const child = yield* sessions.create({ parentID: root.id })
    yield* collaboration.register(root.id, child.id, "worker")
    yield* collaboration.send(root.id, "worker", "Review this change.")
    const messages = yield* collaboration.wait(child.id, 0)
    expect(messages).toEqual([{ from: "/root", text: "Message from /root:\nReview this change." }])
    expect(yield* collaboration.wait(child.id, 0)).toEqual([])
    expect((yield* sessions.active).size).toBe(0)
  }),
)

it.effect("wakes a waiting parent when a child sends a message", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const collaboration = yield* Collaboration.Service
    const root = yield* sessions.create({ location: { directory: AbsolutePath.make("/collaboration") } })
    const child = yield* sessions.create({ parentID: root.id })
    yield* collaboration.register(root.id, child.id, "worker")
    const waiting = yield* collaboration.wait(root.id, 60).pipe(Effect.forkChild({ startImmediately: true }))
    yield* collaboration.send(child.id, "/root", "Finished.")
    expect((yield* Fiber.join(waiting))[0]).toEqual({
      from: "/root/worker",
      text: "Message from /root/worker:\nFinished.",
    })
  }),
)
