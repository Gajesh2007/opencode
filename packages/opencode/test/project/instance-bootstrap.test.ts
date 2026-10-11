import { afterEach, expect, spyOn } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { bootstrap as cliBootstrap } from "../../src/cli/bootstrap"
import { InstanceLayer } from "../../src/project/instance-layer"
import { InstanceStore } from "../../src/project/instance-store"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { waitGlobalBusEvent } from "../server/global-bus"
import { AppRuntime } from "../../src/effect/app-runtime"
import { GoalDriver } from "../../src/session/goal-driver"
import { Goal } from "../../src/session/goal"
import { Session } from "../../src/session/session"
import { SessionStatus } from "../../src/session/status"
import { SessionRunState } from "../../src/session/run-state"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"

const it = testEffect(Layer.mergeAll(InstanceLayer.layer, CrossSpawnSpawner.defaultLayer))

// InstanceBootstrap must run before any code touches the instance —
// originally tracked by PRs #25389 and #25449, now a permanent
// invariant. The plugin config hook writes a marker file; the test
// bodies deliberately avoid Plugin/config directly. The marker only
// appears if InstanceBootstrap ran at the instance boundary.
//
// The boundaries below are transport-agnostic and stay.

afterEach(async () => {
  await disposeAllInstances()
})

const bootstrapFixture = Effect.gen(function* () {
  const dir = yield* tmpdirScoped({ git: true })
  const marker = path.join(dir, "config-hook-fired")
  const pluginFile = path.join(dir, "plugin.ts")
  yield* Effect.promise(() =>
    Bun.write(
      pluginFile,
      [
        `const MARKER = ${JSON.stringify(marker)}`,
        "export default async () => ({",
        "  config: async () => {",
        '    await Bun.write(MARKER, "ran")',
        "  },",
        "})",
        "",
      ].join("\n"),
    ),
  )
  yield* Effect.promise(() =>
    Bun.write(
      path.join(dir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: [pathToFileURL(pluginFile).href],
      }),
    ),
  )
  return { directory: dir, marker }
})

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for CLI bootstrap instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

it.live("InstanceStore.provide runs InstanceBootstrap before effect", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const store = yield* InstanceStore.Service

    yield* store.provide({ directory: tmp.directory }, Effect.succeed("ok"))

    expect(existsSync(tmp.marker)).toBe(true)
  }),
)

it.live("CLI bootstrap runs InstanceBootstrap before callback", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture

    yield* Effect.promise(() => cliBootstrap(tmp.directory, async () => "ok"))

    expect(existsSync(tmp.marker)).toBe(true)
  }),
)

it.live("application bootstrap initializes its goal driver", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const driver = yield* Effect.promise(() => AppRuntime.runPromise(GoalDriver.Service))
    const init = spyOn(driver, "init")
    try {
      yield* Effect.promise(() => cliBootstrap(tmp.directory, async () => "ok"))
      expect(init).toHaveBeenCalled()
    } finally {
      init.mockRestore()
    }
  }),
)

it.live("application idle events start a rate-limit cooldown", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    yield* Effect.promise(() =>
      AppRuntime.runPromise(
        InstanceStore.Service.use((store) =>
          store.provide(
            { directory: tmp.directory },
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const goals = yield* Goal.Service
              const status = yield* SessionStatus.Service
              const runs = yield* SessionRunState.Service
              const session = yield* sessions.create({})
              const user = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                agent: "build",
                model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
                time: { created: Date.now() },
              })
              yield* sessions.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "assistant",
                parentID: user.id,
                agent: "build",
                mode: "build",
                providerID: user.model.providerID,
                modelID: user.model.modelID,
                path: { cwd: tmp.directory, root: tmp.directory },
                time: { created: Date.now(), completed: Date.now() },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                error: new MessageV2.APIError({
                  message: "Rate limited",
                  statusCode: 429,
                  isRetryable: true,
                }).toObject(),
              })
              yield* goals.create({ sessionID: session.id, objective: "Test automatic cooldown" })
              try {
                yield* status.set(session.id, { type: "idle" })
                for (let i = 0; i < 100 && (yield* status.get(session.id)).type !== "retry"; i++)
                  yield* Effect.promise(() => Bun.sleep(5))
                expect((yield* status.get(session.id)).type).toBe("retry")
              } finally {
                yield* runs.cancel(session.id)
                yield* goals.clear(session.id)
              }
            }),
          ),
        ),
      ),
    )
  }),
)

it.live("CLI bootstrap disposes the instance when the callback rejects", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const disposed = yield* waitDisposed(tmp.directory).pipe(Effect.forkScoped)

    const exit = yield* Effect.promise(() =>
      cliBootstrap(tmp.directory, async () => Promise.reject(new Error("boom"))),
    ).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ message: "boom" })
    yield* Fiber.join(disposed)
  }),
)

it.live("InstanceStore.reload runs InstanceBootstrap", () =>
  Effect.gen(function* () {
    const tmp = yield* bootstrapFixture
    const store = yield* InstanceStore.Service

    yield* store.reload({ directory: tmp.directory })

    expect(existsSync(tmp.marker)).toBe(true)
  }),
)
