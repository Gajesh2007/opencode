export * as ForkAgentsPlugin from "./fork-agents.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Agent } from "../agent.js"
import batch from "./fork-prompts/batch-orchestrator.txt"
import review from "./fork-prompts/review-orchestrator.txt"
import security from "./fork-prompts/review-security.txt"
import logic from "./fork-prompts/review-logic.txt"
import style from "./fork-prompts/review-style.txt"
import synthesis from "./fork-prompts/review-synthesizer.txt"
import steer from "./fork-prompts/steer.txt"
import reasoning from "./fork-prompts/reasoning-reviewer.txt"

export const Plugin = define({
  id: "opencode.fork-agents",
  effect: Effect.fn("ForkAgentsPlugin")(function* (ctx) {
    yield* ctx.agent.transform((editor) => {
      for (const [id, system] of Object.entries({
        review,
        batch,
        "review-security": security,
        "review-logic": logic,
        "review-style": style,
        "review-synthesizer": synthesis,
        steer,
        "reasoning-reviewer": reasoning,
      })) {
        editor.update(Agent.ID.make(id), (agent) => {
          agent.mode = "subagent"
          agent.hidden = id !== "review" && id !== "batch"
          agent.system = system
          agent.description =
            id === "review"
              ? "Coordinate multi-lens review and synthesize ranked findings."
              : id === "batch"
                ? "Coordinate independent worktree-isolated changes."
                : "Specialist for " + id
          if (id === "batch") return
          agent.permissions = [{ action: "*", resource: "*", effect: "deny" }]
          if (id === "review" || id === "steer" || (id.startsWith("review-") && id !== "review-synthesizer"))
            agent.permissions.push(
              ...["read", "grep", "glob"].map((action) => ({ action, resource: "*", effect: "allow" as const })),
            )
          if (id === "review")
            agent.permissions.push(
              { action: "workflow", resource: "*", effect: "allow" },
              { action: "subagent", resource: "review-*", effect: "allow" },
            )
        })
      }
    })
  }),
})
