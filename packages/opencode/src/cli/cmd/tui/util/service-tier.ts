import type { AssistantMessage } from "@opencode-ai/sdk/v2"

export function serviceTier(message: Pick<AssistantMessage, "service_tier_requested" | "service_tier">) {
  const requested = message.service_tier_requested
  const served = message.service_tier
  const downgraded = !!requested && ["ultrafast", "priority", "reserved"].includes(requested) && served === "default"
  const text = requested
    ? served
      ? requested === served
        ? `${served} (served)`
        : `${requested} -> ${served}${downgraded ? " (downgraded)" : " (served)"}`
      : `${requested} requested, served unknown`
    : served
      ? `${served} (served)`
      : undefined
  return { text, downgraded }
}
