import { createMemo, onMount } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"

const UPSTREAM_DESCRIPTIONS: Record<string, string> = {
  anthropic: "Anthropic's first-party API (anthropic.com).",
  bedrock: "AWS Bedrock — Anthropic / Mistral / Meta / Cohere upstream.",
  vertex: "Google Cloud Vertex AI — Anthropic / Google / Mistral upstream.",
  google: "Google AI Studio (Gemini API).",
  openai: "OpenAI's first-party API (api.openai.com).",
  azure: "Microsoft Azure OpenAI Service.",
  mistral: "Mistral's first-party API.",
  deepseek: "DeepSeek's first-party API.",
  fireworks: "Fireworks AI — fast open-weights inference.",
  groq: "Groq — LPU-accelerated open-weights inference.",
  together: "Together AI — open-weights inference.",
  deepinfra: "DeepInfra — open-weights inference.",
  novita: "Novita AI — open-weights inference.",
  xai: "xAI (Grok) first-party API.",
}

export function DialogUpstream() {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()

  // Kick off dynamic discovery once when the dialog mounts. We do this here
  // rather than at model-select time so the network call is paid only when
  // the user actually opens the picker. OpenRouter exposes a per-model
  // endpoints list; Vercel AI Gateway has no equivalent runtime API, so we
  // fall back to the hardcoded list from availableUpstreams() for those.
  onMount(() => {
    const m = local.model.current()
    if (!m) return
    const provider = sync.data.provider.find((x) => x.id === m.providerID)
    const info = provider?.models[m.modelID]
    if (!info) return
    if (info.api.npm !== "@openrouter/ai-sdk-provider") return
    void discoverOpenrouterUpstreams(info.api.id)
      .then((slugs) => local.model.upstream.recordDiscovered(slugs))
      .catch(() => {
        // Best-effort: a missing/erroring discovery call just leaves us with
        // the hardcoded list. Don't toast — the user can still pick from it.
      })
  })

  const options = createMemo(() => {
    return [
      {
        value: "default",
        title: "Default",
        description: "Let the gateway pick (sort by health/latency unless a service tier overrides).",
        onSelect: () => {
          dialog.clear()
          local.model.upstream.set(undefined)
        },
      },
      ...local.model.upstream.list().map((slug) => ({
        value: slug,
        title: slug,
        description: UPSTREAM_DESCRIPTIONS[slug],
        onSelect: () => {
          dialog.clear()
          local.model.upstream.set(slug)
        },
      })),
    ]
  })

  return (
    <DialogSelect<string>
      options={options()}
      title={"Pin upstream provider"}
      current={local.model.upstream.selected()}
      flat={true}
    />
  )
}

/**
 * Hit OpenRouter's per-model endpoints endpoint and return the list of upstream
 * provider slugs that currently serve the model. The slugs map 1:1 to what the
 * `provider.only` / `provider.order` arrays accept, so the dialog can drop them
 * straight into the local-store list. No auth — the endpoints listing is a
 * public catalog. Returns empty on any failure so the caller can no-op safely.
 *
 * The OpenRouter model id we receive looks like "anthropic/claude-opus-4.7" —
 * we split on the first "/" into author + slug. Trailing variants like
 * "claude-opus-4.7-fast" or "claude-opus-4.7:nitro" are kept intact since
 * OpenRouter's API uses those same identifiers as the resource path.
 */
async function discoverOpenrouterUpstreams(modelApiId: string): Promise<string[]> {
  const slash = modelApiId.indexOf("/")
  if (slash <= 0) return []
  const author = encodeURIComponent(modelApiId.slice(0, slash))
  // Strip ":variant" suffixes (e.g. ":nitro", ":floor") since the endpoints
  // listing is keyed on the base slug, not the routing variant.
  const slugRaw = modelApiId.slice(slash + 1)
  const slug = encodeURIComponent(slugRaw.split(":")[0])
  const url = `https://openrouter.ai/api/v1/models/${author}/${slug}/endpoints`
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) return []
  const body = (await res.json()) as { data?: { endpoints?: Array<{ provider_name?: string; tag?: string }> } }
  const endpoints = body.data?.endpoints ?? []
  // OpenRouter's `provider_name` is the human display name ("Anthropic",
  // "AWS Bedrock"); the slug used in routing is `tag` (e.g. "anthropic",
  // "bedrock"). Some endpoint entries only have one or the other depending
  // on payload version, so fall back gracefully.
  const slugs = endpoints
    .map((e) => e.tag ?? e.provider_name?.toLowerCase().replace(/\s+/g, "-"))
    .filter((s): s is string => typeof s === "string" && s.length > 0)
  // Deduplicate while preserving order — earliest entries tend to be the
  // canonical providers in OpenRouter's response.
  return Array.from(new Set(slugs))
}
