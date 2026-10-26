export * as AgentSkillsPlugin from "./agent-skills.js"

import { SystemPart } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect } from "effect"
import { Agent } from "../agent.js"
import { Permission } from "../permission.js"
import { Skill } from "../skill.js"

export const Plugin = define({
  id: "opencode.agent.skills",
  effect: Effect.fn("AgentSkillsPlugin")(function* (ctx) {
    const agents = yield* Agent.Service
    const skills = yield* Skill.Service
    const fs = yield* FSUtil.Service
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const agent = yield* agents.get(event.agent)
        if (!agent?.skills?.length) return
        const available = yield* skills.list()
        const selected = new Set<Skill.ID>()
        for (const name of agent.skills) {
          const skill = available.find((item) => item.id === name || item.name === name)
          if (!skill || selected.has(skill.id)) continue
          if (Permission.evaluate("skill", skill.id, agent.permissions).effect === "deny") continue
          selected.add(skill.id)
          const prepared = yield* Skill.prepare(fs, skill)
          event.system.push(SystemPart.make(prepared.output))
        }
      }).pipe(Effect.catch((error) => Effect.logWarning("Unable to preload agent skills", { error }))),
    )
  }),
})
