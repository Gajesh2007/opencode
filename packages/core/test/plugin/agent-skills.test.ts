import { expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Location } from "@opencode/core/location"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { AgentSkillsPlugin } from "@opencode/core/plugin/agent-skills"
import { Skill } from "@opencode/core/skill"
import { Session } from "@opencode/core/session"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { FSUtil } from "@opencode/util/fs-util"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import path from "node:path"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const context = (): SessionHooks["context"] => ({
  sessionID: Session.ID.make("ses_skill_preload"),
  agent: Agent.ID.make("reviewer"),
  model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") }),
  system: [],
  messages: [],
  tools: {},
  options: {},
})

it.live("preloads configured skills once and respects skill permissions", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const skills = yield* Skill.Service
    const hooks = yield* PluginHooks.Service
    const plugins = yield* Plugin.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const file = AbsolutePath.make(path.join(location.directory, "review", "SKILL.md"))
    yield* fs.writeWithDirs(file, "Review source before editing.")
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("reviewer"), (agent) => {
        agent.skills = ["review", "review", "missing", "secret"]
        agent.permissions.push({ action: "skill", resource: "secret", effect: "deny" })
      }),
    )
    yield* skills.transform((editor) => {
      editor.add({
        id: Skill.ID.make("review"),
        name: Skill.Name.make("review"),
        path: file,
        content: "Review source before editing.",
      })
      editor.add({
        id: Skill.ID.make("secret"),
        name: Skill.Name.make("secret"),
        path: file,
        content: "Private skill.",
      })
    })
    yield* AgentSkillsPlugin.Plugin.effect(yield* PluginHost.make(plugins))
    const event = context()
    yield* hooks.trigger("session", "context", event)
    expect(event.system).toHaveLength(1)
    expect(event.system[0].text).toContain("Review source before editing.")
    expect(event.system[0].text).not.toContain("Private skill.")
  }),
)
