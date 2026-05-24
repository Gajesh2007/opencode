# Changelog

This file tracks customizations made to this personal fork of opencode on top of upstream `dev`. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased] — 2026-05-24

### Added — `/tier` slash command, cycle action, footer indicator

Mirroring the existing `/variants` flow exactly. Pickable from the prompt with `/tier`, hidden when the active model exposes no tiers. New keybinding `service_tier_cycle` (unbound by default — `ctrl+t` is already variant cycle) cycles through the available tiers in place. The active tier renders in the bottom-line footer in `theme.success` (green) right after the variant chip, with the same fade-in animation.

Files: `cli/cmd/tui/app.tsx` (command + name list + import), `cli/cmd/tui/config/keybind.ts` (two new keybinds + command mapping), `cli/cmd/tui/component/prompt/index.tsx` (`showServiceTier` memo + `serviceTierMetaAlpha` + footer chip).

### Added — assistant message footer shows resolved Gateway provider + TPS

Each completed assistant turn now ends with `▣ Agent · model · via <provider> · <duration> · <N> tok/s`:

- `via <provider>` — captured from `providerMetadata.gateway.routing.resolvedProvider` (with fallback to `finalProvider`) on each `step-finish` event in the processor. Persisted as `provider_resolved` on the `Assistant` message. Only renders when present, so direct-provider calls stay clean.
- `<N> tok/s` — `tokens.output / duration_ms`. Uses provider-reported token count (exact, no chars/token guesswork). Only renders after `time.completed` is set and at least one output token was produced.

Files: `session/message-v2.ts` (`provider_resolved` field on Assistant), `session/processor.ts` (capture in step-finish), `cli/cmd/tui/feature-plugins/system/session-v2.tsx` (memo + render), SDK regenerated.

### Added — live streaming TPS in prompt footer

While the model is generating, the prompt footer shows `~<N> tok/s live` (green) that updates every 100ms. Disappears the instant the message completes (the final realized TPS still sits on the message itself).

- Source: streamed `text`-field characters from `message.part.delta` events, divided by `CHARS_PER_TOKEN_APPROX = 4` and elapsed time since the first delta (not request-send — that would bake in TTFT and skew the rate down).
- Filters `field === "text"` so tool-call argument JSON streaming doesn't inflate the count.
- 100ms wall-clock ticker only fires when a stream is active; idle UI pays nothing.

Two TPS numbers, intentionally:

| | Live | Final |
|---|---|---|
| Source | streamed chars ÷ 4 ÷ elapsed | reported output tokens ÷ duration |
| Where | prompt footer (transient) | message footer (persisted) |
| Precision | ~5–10% off (chars/token varies) | exact |

Tune `CHARS_PER_TOKEN_APPROX` in `cli/cmd/tui/context/streaming-metrics.tsx` if your typical workload skews (code ≈ 3.0, prose ≈ 4.5).

Files: `cli/cmd/tui/context/streaming-metrics.tsx` (new), `cli/cmd/tui/app.tsx` (provider wiring), `cli/cmd/tui/component/prompt/index.tsx` (footer chip).

### Fixed — cost reflects Vercel AI Gateway's actual debit when routed through it

Previously, `Session.getUsage` computed cost purely from token counts × `model.cost.input/output` (sourced from models.dev). For any Gateway route that involves a tier modifier or sort-based upstream change, that local math diverges from what Vercel actually debits from AI Gateway credits — a request with `/tier fast` on Opus 4.6/4.7 was reported at 1/6 of its real cost.

`Session.getUsage` now prefers `providerMetadata.gateway.cost` (decimal string, the authoritative debit amount) when present and falls back to the local computation for direct-provider calls. Same downstream display path; just the right number now.

File: `session/session.ts`.

## [Unreleased] — 2026-05-23

### Added — service tier selector (model picker → tier picker)

After picking a model in the TUI, a new "Select service tier" dialog appears (mirroring the existing variant flow). Tier choice persists per `${providerID}/${modelID}` in `~/.local/share/opencode/state/model.json` and rides along on each user message as `info.model.serviceTier`. Picker chain is now `model → variant (if any) → service tier (if any)`.

Built-in tiers per provider, derived in `provider/transform.ts → serviceTiers(model)`:

| Provider (npm) | Models | Tiers offered | Wire format |
|---|---|---|---|
| `@ai-sdk/anthropic`, `@ai-sdk/google-vertex/anthropic` | Opus 4.6 / 4.7 only | `fast` | `providerOptions.anthropic.speed = "fast"` (SDK auto-adds `anthropic-beta: fast-mode-2026-02-01`, 6× price, ~2.5× output TPS) |
| `@ai-sdk/openai` | gpt-4 / gpt-5 family / o3 / o4-mini (excl. nano for priority) | `priority`, `flex` | `providerOptions.openai.serviceTier = "..."` |
| `@ai-sdk/gateway` | all models | `throughput` / `latency` / `cheapest` | `providerOptions.gateway.sort = "tps" / "ttft" / "cost"` |
| `@ai-sdk/gateway` | OpenAI / Google / Vertex upstreams | + `priority`, `flex` | `providerOptions.gateway.serviceTier = "..."` |
| `@ai-sdk/gateway` | Anthropic Opus 4.6 / 4.7 upstreams | + `fast` | Flat `{ speed: "fast" }` which the gateway routes under the upstream slug → `providerOptions.anthropic.speed`. Matches the [Vercel changelog](https://vercel.com/changelog/opus-4-6-fast-mode-available-on-ai-gateway). |
| `@openrouter/ai-sdk-provider` | all | `throughput` / `latency` / `cheapest` | `providerOptions.openrouter.provider.sort = "throughput" / "latency" / "price"` |

Tier entries support an optional `headers` field at the top level. `session/llm/request.ts` extracts it and spreads it into the request headers before merging the rest into `params.options`. Useful for beta gates the SDK doesn't auto-inject.

Users can also drop a `serviceTiers` block in `opencode.json` — same shape as `variants` (`Record<tierName, { disabled?: boolean, headers?: {...}, ...providerOptions }>`). Setting `disabled: true` removes a built-in.

Intentional gaps:
- **Direct `@ai-sdk/anthropic` Priority Tier** is not offered — the SDK's Zod schema is closed and has no `serviceTier` field. Use Gateway (`anthropic/...`) once Vercel adds Anthropic Priority Tier.
- Tier choice is not yet persisted on the session DB row, so a cold session-continue after a restart starts on standard until you reselect. The TUI's `model.json` does carry the choice across launches per model.

### Changed — Anthropic prompt caching defaults to 1h on the system prompt

Anthropic's `cache_control: { type: "ephemeral" }` defaults to a 5-minute TTL. For long coding sessions, the system prompt easily outlives that window. `provider/transform.ts → applyCaching` now splits the breakpoints:

- **System messages (first 2)** → `{ type: "ephemeral", ttl: "1h" }` — pays back the 2× cache-write cost as soon as the prefix is reused beyond 5 min.
- **Trailing turn pair** → `{ type: "ephemeral" }` (5 min) — transient, gets superseded next turn.

Ordering constraint (Anthropic requires 1h breakpoints before 5m ones in the request) is satisfied because system messages already lead the array. GA on Anthropic API as of [the 1h cache GA rollout](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) — no beta header required, supported on all active Claude models.

The same shape (`cacheControl: { type: "ephemeral", ttl: "1h" }`) is applied for the `openrouter`, `openaiCompatible`, and `alibaba` provider keys, since those proxy to Anthropic. Bedrock is left at `cachePoint: { type: "default" }` because `@ai-sdk/amazon-bedrock` doesn't expose a 1h knob.

### Fixed — prompt caching now reaches Anthropic via Vercel AI Gateway

Previously, `applyCaching` was skipped entirely for `@ai-sdk/gateway` models. Gateway-Anthropic relied on `providerOptions.gateway.caching: "auto"`, which only inserts a single 5-minute breakpoint at the end of static content — bypassing the 1h split above.

Now, for Anthropic upstreams (`model.api.id` starts with `anthropic/`):
- `gateway.caching: "auto"` is **not** set, since we're placing breakpoints ourselves
- `applyCaching` runs and attaches per-message `providerOptions.anthropic.cacheControl`, which the Vercel gateway forwards to the Anthropic upstream

Non-Anthropic gateway upstreams (OpenAI / Google / DeepSeek) keep `gateway.caching: "auto"` because they cache implicitly.

### Added — `script/check-service-tier-wire.ts`

Pure unit-style wire-format check: constructs fake models, runs `ProviderTransform.serviceTiers / .options / .providerOptions / .message` against them, asserts that each provider's selected tier + cache breakpoints land at the right key with the right value. No API calls. Run via:

```
bun run packages/opencode/script/check-service-tier-wire.ts
```

Currently covers 22 assertions across direct Anthropic, direct OpenAI, Gateway (Anthropic and OpenAI upstreams), and OpenRouter.

### Files changed

- `packages/opencode/src/config/provider.ts` — `serviceTiers` schema for `opencode.json`
- `packages/opencode/src/provider/provider.ts` — `serviceTiers` on Model schema + four attach points (gitlab discovery, `fromModelsDevModel`, database parse merge, final config merge)
- `packages/opencode/src/provider/transform.ts` — `serviceTiers(model)` defaults, gateway-anthropic caching fix, 1h/5m TTL split in `applyCaching`
- `packages/opencode/src/session/message-v2.ts` — `serviceTier` on UserMessage `model`
- `packages/opencode/src/session/prompt.ts` — `serviceTier` on `PromptInput` / `CommandInput` / `createUserMessage` / command executor
- `packages/opencode/src/session/llm/request.ts` — fold `model.serviceTiers[selected]` into params options; extract `headers` field
- `packages/opencode/src/cli/cmd/tui/context/local.tsx` — `serviceTier` store API (selected / list / set / cycle) mirroring variant
- `packages/opencode/src/cli/cmd/tui/component/dialog-service-tier.tsx` — new picker dialog
- `packages/opencode/src/cli/cmd/tui/component/dialog-variant.tsx` — chains into the tier dialog after a variant is chosen
- `packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx` — chains into the tier dialog after model select when no variant
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` — passes `serviceTier` on `session.prompt` and `session.command` calls
- `packages/opencode/script/check-service-tier-wire.ts` — new
- `packages/sdk/js/src/v2/gen/*` — regenerated from the updated server schemas
