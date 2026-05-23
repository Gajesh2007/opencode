/**
 * Wire-format verification for service tiers + prompt caching.
 *
 * Exercises the pure transformation functions (ProviderTransform.serviceTiers,
 * .options, .providerOptions, .message) against fake models and asserts the
 * routed shape. No API calls, no live model lookups. Run with:
 *
 *   bun run script/check-service-tier-wire.ts
 *
 * Exits 0 on success, 1 if any assertion fails.
 */

import { ProviderTransform } from "../src/provider/transform"
import type { Provider } from "../src/provider/provider"
import type { ModelMessage } from "ai"

type FakeModel = {
  apiNpm: string
  apiId: string
  id?: string
  providerID?: string
  reasoning?: boolean
}

function makeModel(f: FakeModel): Provider.Model {
  const id = f.id ?? f.apiId
  return {
    id: id as any,
    providerID: (f.providerID ?? "test") as any,
    api: { npm: f.apiNpm, id: f.apiId } as any,
    name: id,
    capabilities: {
      reasoning: f.reasoning ?? false,
      temperature: false,
      tools: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    } as any,
    cost: { input: 0, output: 0 } as any,
    limit: { context: 200_000, output: 32_000 } as any,
    status: "ga" as any,
    options: {},
    headers: {},
    release_date: "2025-01-01",
    variants: {},
    serviceTiers: {},
  }
}

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`  ✓ ${label}`)
    return
  }
  failures++
  console.log(`  ✗ ${label}`)
  console.log(`      expected: ${e}`)
  console.log(`      actual:   ${a}`)
}

function pick<T extends Record<string, any>>(obj: T, ...keys: string[]) {
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]))
}

console.log("\n=== ServiceTier defaults ===")

{
  console.log("@ai-sdk/anthropic claude-opus-4-7")
  const m = makeModel({ apiNpm: "@ai-sdk/anthropic", apiId: "claude-opus-4-7", providerID: "anthropic" })
  const tiers = ProviderTransform.serviceTiers(m)
  check("offers fast tier", Object.keys(tiers).sort(), ["fast"])
  check("fast → { speed: 'fast' }", tiers.fast, { speed: "fast" })
}

{
  console.log("@ai-sdk/anthropic claude-sonnet-4-6 (no fast)")
  const m = makeModel({ apiNpm: "@ai-sdk/anthropic", apiId: "claude-sonnet-4-6", providerID: "anthropic" })
  check("no tiers for sonnet", Object.keys(ProviderTransform.serviceTiers(m)), [])
}

{
  console.log("@ai-sdk/openai gpt-5.5")
  const m = makeModel({ apiNpm: "@ai-sdk/openai", apiId: "gpt-5.5", providerID: "openai" })
  const tiers = ProviderTransform.serviceTiers(m)
  check("offers priority + flex", Object.keys(tiers).sort(), ["flex", "priority"])
  check("priority shape", tiers.priority, { serviceTier: "priority" })
  check("flex shape", tiers.flex, { serviceTier: "flex" })
}

{
  console.log("@ai-sdk/openai gpt-5-nano (priority excluded)")
  const m = makeModel({ apiNpm: "@ai-sdk/openai", apiId: "gpt-5-nano", providerID: "openai" })
  const tiers = ProviderTransform.serviceTiers(m)
  check("only flex (no priority for nano)", Object.keys(tiers).sort(), ["flex"])
}

{
  console.log("@ai-sdk/gateway anthropic/claude-opus-4.7")
  const m = makeModel({
    apiNpm: "@ai-sdk/gateway",
    apiId: "anthropic/claude-opus-4.7",
    id: "anthropic/claude-opus-4.7",
    providerID: "vercel",
  })
  const tiers = ProviderTransform.serviceTiers(m)
  check(
    "offers fast + sort tiers (no priority/flex on anthropic upstream)",
    Object.keys(tiers).sort(),
    ["cheapest", "fast", "latency", "throughput"],
  )
  check("fast routes flat { speed: 'fast' }", tiers.fast, { speed: "fast" })
  check("throughput uses gateway.sort: tps", tiers.throughput, { gateway: { sort: "tps" } })
}

{
  console.log("@ai-sdk/gateway openai/gpt-5.5")
  const m = makeModel({
    apiNpm: "@ai-sdk/gateway",
    apiId: "openai/gpt-5.5",
    id: "openai/gpt-5.5",
    providerID: "vercel",
  })
  const tiers = ProviderTransform.serviceTiers(m)
  check(
    "openai upstream offers all 5",
    Object.keys(tiers).sort(),
    ["cheapest", "flex", "latency", "priority", "throughput"],
  )
  check("priority uses gateway.serviceTier", tiers.priority, { gateway: { serviceTier: "priority" } })
}

{
  console.log("@openrouter/ai-sdk-provider anthropic/claude-opus-4.6")
  const m = makeModel({
    apiNpm: "@openrouter/ai-sdk-provider",
    apiId: "anthropic/claude-opus-4.6",
    id: "openrouter/anthropic/claude-opus-4.6",
    providerID: "openrouter",
  })
  const tiers = ProviderTransform.serviceTiers(m)
  check("offers sort tiers", Object.keys(tiers).sort(), ["cheapest", "latency", "throughput"])
  check("throughput uses provider.sort", tiers.throughput, { provider: { sort: "throughput" } })
}

console.log("\n=== ProviderTransform.providerOptions (key routing) ===")

{
  console.log("Gateway anthropic upstream — flat speed routes under anthropic slug")
  const m = makeModel({
    apiNpm: "@ai-sdk/gateway",
    apiId: "anthropic/claude-opus-4.7",
    id: "anthropic/claude-opus-4.7",
    providerID: "vercel",
  })
  const routed = ProviderTransform.providerOptions(m, { speed: "fast" })
  check("speed lands at anthropic.speed", routed, { anthropic: { speed: "fast" } })
}

{
  console.log("Gateway openai upstream — gateway.serviceTier passes through")
  const m = makeModel({
    apiNpm: "@ai-sdk/gateway",
    apiId: "openai/gpt-5.5",
    id: "openai/gpt-5.5",
    providerID: "vercel",
  })
  const routed = ProviderTransform.providerOptions(m, { gateway: { serviceTier: "priority" } })
  check("gateway.serviceTier preserved", routed, { gateway: { serviceTier: "priority" } })
}

{
  console.log("Direct OpenAI — serviceTier routes under openai key")
  const m = makeModel({ apiNpm: "@ai-sdk/openai", apiId: "gpt-5.5", providerID: "openai" })
  const routed = ProviderTransform.providerOptions(m, { serviceTier: "priority" })
  check("openai.serviceTier", routed, { openai: { serviceTier: "priority" } })
}

{
  console.log("OpenRouter — provider.sort routes under openrouter key")
  const m = makeModel({
    apiNpm: "@openrouter/ai-sdk-provider",
    apiId: "anthropic/claude-opus-4.6",
    id: "openrouter/anthropic/claude-opus-4.6",
    providerID: "openrouter",
  })
  const routed = ProviderTransform.providerOptions(m, { provider: { sort: "throughput" } })
  check("openrouter.provider.sort", routed, { openrouter: { provider: { sort: "throughput" } } })
}

console.log("\n=== Cache TTL split (1h on system, 5m on trailing) ===")

function findCacheControl(msg: ModelMessage, providerKey: string) {
  const fromMsg = (msg.providerOptions as any)?.[providerKey]?.cacheControl
  if (fromMsg) return fromMsg
  if (!Array.isArray(msg.content)) return undefined
  const last = msg.content[msg.content.length - 1] as any
  return last?.providerOptions?.[providerKey]?.cacheControl
}

const baseMsgs = (): ModelMessage[] => [
  { role: "system", content: "System prompt" },
  { role: "user", content: [{ type: "text", text: "Hello" }] },
  { role: "assistant", content: [{ type: "text", text: "Hi" }] },
  { role: "user", content: [{ type: "text", text: "Latest" }] },
]

{
  console.log("Direct @ai-sdk/anthropic")
  const m = makeModel({ apiNpm: "@ai-sdk/anthropic", apiId: "claude-opus-4-7", providerID: "anthropic" })
  const out = ProviderTransform.message(baseMsgs(), m, {})
  const sys = out.find((m) => m.role === "system")!
  const last = out[out.length - 1]
  check("system → ttl: 1h", findCacheControl(sys, "anthropic"), { type: "ephemeral", ttl: "1h" })
  check("trailing user → 5m (no ttl)", findCacheControl(last, "anthropic"), { type: "ephemeral" })
}

{
  console.log("Gateway anthropic upstream")
  const m = makeModel({
    apiNpm: "@ai-sdk/gateway",
    apiId: "anthropic/claude-opus-4.7",
    id: "anthropic/claude-opus-4.7",
    providerID: "vercel",
  })
  const out = ProviderTransform.message(baseMsgs(), m, {})
  const sys = out.find((m) => m.role === "system")!
  const last = out[out.length - 1]
  check("system → ttl: 1h (anthropic key)", findCacheControl(sys, "anthropic"), { type: "ephemeral", ttl: "1h" })
  check("trailing → 5m", findCacheControl(last, "anthropic"), { type: "ephemeral" })

  // Also verify gateway.caching: "auto" is NOT set for anthropic upstream
  // (because we're doing manual breakpoints instead).
  const baseOpts = ProviderTransform.options({ model: m, sessionID: "test" })
  check("gateway.caching: auto disabled for anthropic upstream", baseOpts.gateway, undefined)
}

{
  console.log("Gateway openai upstream — auto-caching still enabled")
  const m = makeModel({
    apiNpm: "@ai-sdk/gateway",
    apiId: "openai/gpt-5.5",
    id: "openai/gpt-5.5",
    providerID: "vercel",
  })
  const baseOpts = ProviderTransform.options({ model: m, sessionID: "test" })
  check("gateway.caching: auto present for non-anthropic upstream", baseOpts.gateway, { caching: "auto" })
}

{
  console.log("OpenRouter anthropic model — 1h cacheControl on system")
  const m = makeModel({
    apiNpm: "@openrouter/ai-sdk-provider",
    apiId: "anthropic/claude-opus-4.6",
    id: "openrouter/anthropic/claude-opus-4.6",
    providerID: "openrouter",
  })
  const out = ProviderTransform.message(baseMsgs(), m, {})
  const sys = out.find((m) => m.role === "system")!
  // openrouter SDK key for cacheControl namespace stays "openrouter".
  check("system → openrouter.cacheControl ttl: 1h", findCacheControl(sys, "openrouter"), {
    type: "ephemeral",
    ttl: "1h",
  })
}

console.log()
if (failures > 0) {
  console.log(`FAIL — ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log("OK — all assertions passed")
