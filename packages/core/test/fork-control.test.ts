import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ForkControl } from "@opencode/schema/fork-control"
import { ForkControlPlugin } from "@opencode/core/plugin/fork-control"
import { Goal } from "@opencode/core/goal"
import { MetaAgent } from "@opencode/core/meta-agent"
import { Collaboration } from "@opencode/core/collaboration"
import { Rpc } from "@opencode/core/rpc"
import { Bus } from "@opencode/core/bus"
import { Session } from "@opencode/core/session"
import { Job } from "@opencode/core/job"
import { SubagentModel } from "@opencode/core/subagent-model"
import { Agent } from "@opencode/core/agent"
import { Team } from "@opencode/core/team"
import { SessionExecution } from "@opencode/core/session/execution"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "./fixture/location"
import { promptLocationNode } from "./fixture/prompt-location"
import { globalProjectNode } from "./lib/project"
import { host } from "./plugin/host"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Goal.node,
      MetaAgent.node,
      Collaboration.node,
      Rpc.node,
      Session.node,
      Job.node,
      Team.node,
      SubagentModel.node,
      Agent.node,
    ]),
    [
      Location.node.replace(Layer.succeed(Location.Service, location({ directory: AbsolutePath.make("/rpc-fork") }))),
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      Bus.node.replace(Bus.configured({ persist: true })),
    ],
  ),
)

it.effect("encodes empty and configured fork controls through the real RPC registry", () =>
  Effect.gen(function* () {
    const rpc = yield* Rpc.Service
    const sessions = yield* Session.Service
    yield* ForkControlPlugin.Plugin.effect(host({ rpc: Object.assign(rpc.client, { register: rpc.register }) }))
    const session = yield* sessions.create({ location: { directory: AbsolutePath.make("/rpc-fork") } })
    const input = { sessionID: session.id }
    const before = yield* rpc.call(ForkControl.Definition.id, "state", input)
    expect(before).toEqual({
      agents: [{ sessionID: session.id, path: "/root", status: "idle" }],
      teams: [],
      workflows: [],
    })
    yield* rpc.call(ForkControl.Definition.id, "createGoal", {
      ...input,
      objective: "Finish migration",
      tokenBudget: 1000,
    })
    yield* rpc.call(ForkControl.Definition.id, "setReviewer", { ...input, basePrompt: "Verify evidence" })
    expect(yield* rpc.call(ForkControl.Definition.id, "state", input)).toMatchObject({
      goal: { objective: "Finish migration", status: "active" },
      reviewer: { enabled: true, basePrompt: "Verify evidence" },
    })
    yield* rpc.call(ForkControl.Definition.id, "updateGoal", { ...input, status: "abandoned" })
    yield* rpc.call(ForkControl.Definition.id, "clearReviewer", input)
    expect(yield* rpc.call(ForkControl.Definition.id, "state", input)).toMatchObject({ goal: { status: "abandoned" } })
  }),
)
