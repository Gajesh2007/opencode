import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { WorkspaceID } from "@/control-plane/schema"
import { Server } from "@/server/server"
import { Goal } from "@/session/goal"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { MessageID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffectShared } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"

// Let HTTP initialize GoalDriver; the fixture only shares its lower-level state.
const it = testEffectShared(
  Layer.mergeAll(Session.defaultLayer, SessionStatus.defaultLayer, SessionRunState.defaultLayer, Goal.defaultLayer),
)

it.instance("HTTP runtime initializes goal cooldown continuation", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const headers = { "x-opencode-directory": directory }
    const initial = yield* Effect.promise(async () => Server.Default().app.request("/session/status", { headers }))
    expect(initial.status).toBe(200)
    const sessions = yield* Session.Service
    const goals = yield* Goal.Service
    const runs = yield* SessionRunState.Service
    const status = yield* SessionStatus.Service
    const workspaceID = WorkspaceID.ascending()
    const chat = yield* sessions.create({ title: "HTTP goal recovery fixture", workspaceID })
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: chat.id,
      role: "user",
      agent: "build",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      time: { created: Date.now() },
    })
    yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: chat.id,
      role: "assistant",
      parentID: user.id,
      agent: "build",
      mode: "build",
      providerID: user.model.providerID,
      modelID: user.model.modelID,
      path: { cwd: directory, root: directory },
      time: { created: Date.now(), completed: Date.now() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      error: new MessageV2.APIError({ message: "Rate limited", statusCode: 429, isRetryable: true }).toObject(),
    })
    yield* goals.create({ sessionID: chat.id, objective: "Continue after a temporary rate limit" })
    try {
      const retryEvent = yield* waitGlobalBusEvent({
        predicate: (event) =>
          event.payload.type === "session.status" &&
          event.payload.properties.sessionID === chat.id &&
          event.payload.properties.status.type === "retry",
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* status.set(chat.id, { type: "idle" })
      const observed = yield* pollWithTimeout(
        Effect.gen(function* () {
          const response = yield* Effect.promise(async () =>
            Server.Default().app.request("/session/status", { headers }),
          )
          const statuses: Record<string, SessionStatus.Info> = yield* Effect.promise(() => response.json())
          const current = statuses[chat.id]
          return current?.type === "retry" ? current : undefined
        }),
        "HTTP runtime never started the goal cooldown",
      )
      expect(observed.attempt).toBe(1)
      expect(observed.next).toBeGreaterThan(Date.now())
      expect((yield* Fiber.join(retryEvent)).workspace).toBe(workspaceID)
    } finally {
      yield* runs.cancel(chat.id)
      yield* goals.clear(chat.id)
      yield* sessions.remove(chat.id)
    }
  }),
)
