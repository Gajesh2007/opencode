import { NodeFileSystem } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "@/config/config"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MetaAgent } from "../../src/session/metaagent"
import { SessionStatus } from "../../src/session/status"
import { Snapshot } from "../../src/snapshot"
import * as Log from "@opencode-ai/core/util/log"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { SyncEvent } from "@/sync"
import { EventV2Bridge } from "@/event-v2-bridge"

void Log.init({ print: false })

const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  LLM.defaultLayer,
  Provider.defaultLayer,
  status,
  SyncEvent.defaultLayer,
  EventV2Bridge.defaultLayer,
  MetaAgent.defaultLayer,
).pipe(Layer.provideMerge(infra))
const env = Layer.mergeAll(TestLLMServer.layer, deps)

const it = testEffect(env)

it.live("session.metaagent set applies defaults and enables", () =>
  provideTmpdirServer(
    () =>
      Effect.gen(function* () {
        const meta = yield* MetaAgent.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({})

        const result = yield* meta.set({ sessionID: chat.id, basePrompt: "think in first principles" })
        expect(result.enabled).toBe(true)
        expect(result.basePrompt).toBe("think in first principles")
        expect(result.model).toEqual(MetaAgent.DEFAULT_MODEL)
        expect(result.effort).toBe(MetaAgent.DEFAULT_EFFORT)

        const got = yield* meta.get(chat.id)
        expect(got?.basePrompt).toBe("think in first principles")
        expect(got?.enabled).toBe(true)
      }),
  ),
)

it.live("session.metaagent set merges fields without clobbering", () =>
  provideTmpdirServer(
    () =>
      Effect.gen(function* () {
        const meta = yield* MetaAgent.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({})

        yield* meta.set({ sessionID: chat.id, basePrompt: "reason like David Deutsch" })
        yield* meta.set({ sessionID: chat.id, effort: "high" })

        const got = yield* meta.get(chat.id)
        expect(got?.basePrompt).toBe("reason like David Deutsch")
        expect(got?.effort).toBe("high")
        expect(got?.enabled).toBe(true)
      }),
  ),
)

it.live("session.metaagent clear disables and get returns undefined", () =>
  provideTmpdirServer(
    () =>
      Effect.gen(function* () {
        const meta = yield* MetaAgent.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({})

        expect(yield* meta.get(chat.id)).toBeUndefined()
        yield* meta.set({ sessionID: chat.id, basePrompt: "x" })
        expect((yield* meta.get(chat.id))?.enabled).toBe(true)
        yield* meta.clear(chat.id)
        expect(yield* meta.get(chat.id)).toBeUndefined()
      }),
  ),
)

it.live("session.metaagent set enabled:false keeps config but disables", () =>
  provideTmpdirServer(
    () =>
      Effect.gen(function* () {
        const meta = yield* MetaAgent.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({})

        yield* meta.set({ sessionID: chat.id, basePrompt: "keep me" })
        yield* meta.set({ sessionID: chat.id, enabled: false })

        const got = yield* meta.get(chat.id)
        expect(got?.enabled).toBe(false)
        expect(got?.basePrompt).toBe("keep me")
      }),
  ),
)
