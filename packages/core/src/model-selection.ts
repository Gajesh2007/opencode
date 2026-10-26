export * as ModelSelection from "./model-selection.js"

import type { Model } from "@opencode/schema/model"

export function supportsUltra(model: RoutingModel) {
  return (
    /(?:^|\/)gpt-5[.-]6(?:-(?:sol|terra))?$/.test(model.modelID) &&
    ["openai", "openrouter", "gateway"].includes(route(model) ?? "")
  )
}

type RoutingModel = {
  readonly modelID: string
  readonly package?: string
  readonly serviceTiers?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

export function route(model: RoutingModel) {
  const name = model.package ?? ""
  if (name.includes("vercel-ai-gateway") || name === "@ai-sdk/gateway") return "gateway"
  if (name.includes("openrouter")) return "openrouter"
  if (name.includes("anthropic")) return "anthropic"
  if (name.includes("openai") || name.includes("azure") || name.includes("mantle")) return "openai"
}

function defaults(model: RoutingModel): Record<string, Record<string, unknown>> {
  const id = model.modelID.toLowerCase()
  const provider = route(model)
  const opus = /opus[-.]?(?:4[-.][678]|5)/.test(id)
  if (provider === "anthropic") return opus ? { fast: { speed: "fast" } } : {}
  if (provider === "openrouter")
    return {
      throughput: { provider: { sort: "throughput" } },
      latency: { provider: { sort: "latency" } },
      cheapest: { provider: { sort: "price" } },
    }
  if (provider === "gateway")
    return {
      throughput: { gateway: { sort: "tps" } },
      latency: { gateway: { sort: "ttft" } },
      cheapest: { gateway: { sort: "cost" } },
      ...(/^(?:openai|google|vertex)\//.test(id)
        ? { priority: { gateway: { serviceTier: "priority" } }, flex: { gateway: { serviceTier: "flex" } } }
        : {}),
      ...(id.startsWith("anthropic/") && opus ? { fast: { upstream: { anthropic: { speed: "fast" } } } } : {}),
      ...(id === "moonshotai/kimi-k3" ? { fast: { gateway: { speed: "fast" } } } : {}),
    }
  if (provider !== "openai") return {}
  return {
    ...(/gpt-[456]|(?:^|\/)o[34]/.test(id) && !id.includes("gpt-5-nano")
      ? { priority: { serviceTier: "priority" } }
      : {}),
    ...(/gpt-5|(?:^|\/)o[34]/.test(id) ? { flex: { serviceTier: "flex" } } : {}),
    ...(/gpt-(?:6[-.]1-sol|6-astra|5[-.]6-sol)/.test(id) ? { ultrafast: { serviceTier: "ultrafast" } } : {}),
  }
}

export function tiers(model: RoutingModel): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries({ ...defaults(model), ...model.serviceTiers }).filter(([, value]) => !value.disabled),
  )
}

export function options(model: Model.Info, selection: Model.Ref) {
  const tier =
    selection.serviceTier && selection.serviceTier !== "default" ? tiers(model)[selection.serviceTier] : undefined
  const result = Object.fromEntries(
    Object.entries(tier ?? {}).filter(([key]) => key !== "headers" && key !== "disabled"),
  )
  if (selection.serviceTier === "default" && route(model) === "openai") result.serviceTier = "default"
  if (
    selection.reasoningMode &&
    route(model) === "gateway" &&
    /^openai\/gpt-5[.-]6-(?:sol|terra|luna)/.test(model.modelID)
  )
    result.reasoningMode = selection.reasoningMode
  if (selection.upstream && selection.upstream !== "default") {
    const key = route(model) === "gateway" ? "gateway" : route(model) === "openrouter" ? "provider" : undefined
    if (key) result[key] = { ...record(result[key]), only: [selection.upstream] }
  }
  return result
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {}
}
