import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

/**
 * The configured token count at which a session compacts before its model
 * requires it: `compaction.subagent_threshold` for a session another session
 * spawned, else `compaction.threshold`. Undefined when neither applies.
 */
export function threshold(input: { cfg: Config.Info; subagent?: boolean }) {
  return (input.subagent ? input.cfg.compaction?.subagent_threshold : undefined) ?? input.cfg.compaction?.threshold
}

export function usable(input: {
  cfg: Config.Info
  model: Provider.Model
  outputTokenMax?: number
  subagent?: boolean
}) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  const window = input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  // A threshold only ever compacts earlier than the model's window does.
  const configured = threshold(input)
  return configured === undefined ? window : Math.min(window, configured)
}

export function isOverflow(input: {
  cfg: Config.Info
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
  /** The session was spawned by another session (it has a parent). */
  subagent?: boolean
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
