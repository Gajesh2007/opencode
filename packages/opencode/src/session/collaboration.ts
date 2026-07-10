import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"

export function collaborationGuidance(input: {
  model: Provider.Model
  variant: string | undefined
  isChild: boolean
}): string | undefined {
  if (!ProviderTransform.isUltraVariant(input.model, "ultra")) return

  const role = input.isChild ? "team agent" : "primary agent"
  const responsibilities = input.isChild
    ? [
        "You can spawn your own well-scoped subagents using spawn_agent when parallel work materially improves quality or speed and the delegation policy below permits it.",
        "Results return to your direct parent.",
        "Avoid duplicating work and continue local critical-path work while delegated tasks run.",
      ]
    : ["Spawned agents may spawn their own well-scoped subagents.", "Team-agent final results return to you."]
  const delegation =
    input.variant === "ultra"
      ? "Proactive multi-agent delegation is active. Earlier explicit-request-only restrictions no longer apply. Use subagents when parallel work materially improves speed or quality. Do critical-path work locally and do not wait reflexively for subagents."
      : "Subagent delegation is explicit-only. Do not spawn subagents unless the user or applicable instructions explicitly request subagents, delegation, or parallel work."

  return [
    "<collaboration>",
    "This system/developer collaboration guidance is the source of truth and remains active across turns and follow-ups.",
    `You are the ${role}. You share a workspace with other agents and use the same tools and model by default.`,
    ...responsibilities,
    "All descendants share the same root collaboration control plane and four total concurrency slots, including the root session.",
    delegation,
    "</collaboration>",
  ].join("\n")
}
