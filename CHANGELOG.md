# Changelog

This file tracks customizations made to this personal fork of opencode on top of upstream `dev`. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased] — 2026-05-29

### Added — TUI for the multi-agent tools (Claude-Code-style)

Bespoke renderers for the new tools in the session transcript (`cli/cmd/tui/routes/session/index.tsx`), matching opencode's theme + Claude Code's visual language (bullet/branch grammar, dim metadata, per-agent colors, live progress).

- **Workflow** — renders as a bordered block `▦ Workflow — <desc>` with a spinner while running, a `N units × M passes = K cells` summary, and a **live progress bar** (`████░░░░ 3/6 (50%)`) that fills as cells complete. On completion it shows the **findings count + color-coded severity breakdown** (critical/high → red, medium → warning, low → info, info → muted). Backed by the `workflow` tool now emitting live progress via `ctx.metadata` (`completed`, `findings`, `counts`, `failed`).
- **send_message** — inline `✉ <from> → <to>: <message>`, with the sender tinted by its agent color.
- **inbox** — inline `✉ Inbox · <team>: N messages`.
- **team_tasks** — bordered `☰ Team tasks — <team>` block rendering the shared task list.
- **memory** — bordered `◆ Memory (<scope>)` block showing the store contents.

Verified live in the dev TUI: the workflow progress bar animates `0/6 → 6/6` cleanly.

### Added — Agent memory + per-agent MCP scoping

Completes the richer-agent-frontmatter set (Claude-Code parity).

**Agent memory** — an agent declares `memory: "user" | "project" | "local"` and
gets a persistent markdown store that is read fresh into its context every turn
and is writable via a new `memory` tool, so durable facts survive across
sessions. Scopes: `user` → `~/.config/opencode/memory/<agent>.md`, `project` →
`<dir>/.opencode/memory/<agent>.md`, `local` → `<dir>/.opencode/memory/<agent>.local.md`.
Reads always hit disk (never the cached agent definition). Injected at the
system-prompt assembly point in `session/prompt.ts` (alongside skills/goal), so
subagents get their own memory too. _New: `src/memory/memory.ts`,
`src/tool/memory.ts(.txt)`._

**Per-agent `mcpServers`** — an agent declares `mcpServers: string[]` to scope
which MCP servers' tools it can see; omitted ⇒ all MCP tools (unchanged). MCP
tool keys are `sanitize(server)_sanitize(tool)`, so the filter lives in
`session/tools.ts` and naturally scopes spawned subagents (their agent def
carries the field). `sanitize` is now exported from `src/mcp/index.ts`.

Both fields are added to the agent config schema + runtime `Agent.Info`.

### Added — Multi-agent suite: fan-out workflow engine, forks, teams, lifecycle hooks, richer agents, batch

A Claude-Code-parity set of agent/subagent capabilities, all built into the agent
system (`packages/opencode`). Subagent fan-out is now bounded by a shared
concurrency cap (default **200**, up from effectively unbounded).

**Concurrency rail** — a `SubagentLimit` service: one shared semaphore gating all
subagent work (the `task` tool _and_ the workflow engine), so massive fan-outs
drain through a bounded window instead of stampeding the provider. Configurable
via `experimental.subagent_concurrency` (config) or `OPENCODE_SUBAGENT_CONCURRENCY`
(env), default 200. _`src/agent/subagent-limit.ts`._

**Workflow engine (`workflow` tool)** — a general orchestrator-worker / fan-out
primitive: spawn one subagent per UNIT × PASS, run them concurrently (bounded),
then reduce with a single synthesis subagent. In `findings` mode it parses each
cell's JSON, de-duplicates + ranks deterministically (cross-lens agreement
boosting), so it scales to thousands of files without overflowing the
synthesizer. _`src/tool/workflow.ts`, `src/workflow/finding.ts`._

**Code review fan-out (`/review`)** — the flagship workflow: a `review`
orchestrator agent fans out `review-security` / `review-logic` / `review-style`
reviewers over every changed file, then `review-synthesizer` returns one ranked
report. Verified end-to-end against a live model. _`src/agent/prompt/review-*.txt`._

**Forks** — `task({ fork: true })` spawns a subagent that inherits the parent
session's full conversation (via `Session.fork`, cut off before the in-progress
turn) instead of starting fresh. Bounded: a fork/subagent can never fork again.

**Agent teams & mailbox** — a `Team` service (roster + shared task list +
mailbox); `send_message` / `inbox` / `team_tasks` tools; and `task({ team, name })`
which registers a lead plus named teammates so concurrent subagents coordinate.
_`src/agent/team.ts`, `src/tool/{send_message,inbox,team_tasks}.ts`._

**Lifecycle hooks** — `subagent.start` / `subagent.stop` plugin events fire
around every subagent run; `tool.execute.before` gained deny + argument-rewrite
(PreToolUse gating); `tool.execute.after` (PostToolUse) already existed.
_`packages/plugin/src/index.ts`, `src/session/tools.ts`, `src/tool/task.ts`._

**Richer agent frontmatter** — `effort` (low|medium|high|xhigh|max → model
variant), `skills` (preload skill content into the agent's system prompt),
`initialPrompt` (carried on the agent), and a declarative `workflow` block (turns
an agent into a fan-out orchestrator). _`src/config/agent.ts`, `src/agent/agent.ts`._

**Batch (`/batch`)** — a built-in `batch` orchestrator agent + command: split a
change into independent items and fan out worktree-isolated subagents that each
open a pull request (reuses `task({ worktree, background })` + `gh`).

**New files**: `src/agent/subagent-limit.ts`, `src/agent/team.ts`,
`src/workflow/finding.ts`, `src/tool/workflow.ts(.txt)`,
`src/tool/send_message.ts(.txt)`, `src/tool/inbox.ts(.txt)`,
`src/tool/team_tasks.ts(.txt)`, `src/agent/prompt/review-*.txt`,
`src/agent/prompt/batch-orchestrator.txt`, `src/command/template/batch.txt`, and
tests under `test/workflow/`, `test/tool/hooks.test.ts`, `test/agent/team.test.ts`.

### Added — `/provider` slash command: pin requests to a specific upstream

A fourth orthogonal model-dimension picker, after `model → variant → tier`.
Press `/provider` (or cycle via `upstream_cycle` keybind, unbound by default)
to pin all requests for the current model to a specific upstream provider.
Persisted per `${providerID}/${modelID}` in `model.json`, surfaced as a
`via <slug>` chip in the prompt footer (info-blue color), and chained into
the model-selection flow so a fresh model with available upstreams prompts
for one.

**Wire format** — translated in `session/llm/request.ts` based on the route:

| Route | Wire format |
|---|---|
| `@ai-sdk/gateway` | `providerOptions.gateway.only: [<slug>]` ([Vercel docs](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering)) |
| `@openrouter/ai-sdk-provider` | `providerOptions.openrouter.provider.only: [<slug>]` ([OpenRouter docs](https://openrouter.ai/docs/guides/routing/provider-selection)) |
| Direct providers | no-op (single upstream) |

The pin is merged AFTER the service tier so an explicit pin can't be
overridden by a sort-tier that emits its own `only`/`order` array.

**Static defaults** — `ProviderTransform.availableUpstreams(model)` returns the
hardcoded list per family (e.g. Anthropic → `anthropic`/`bedrock`/`vertex`;
GPT → `openai`/`azure`; Llama → `bedrock`/`fireworks`/`groq`/`together`/etc.).
Users can override per-model via `opencode.json`'s `upstreams` array.

**Dynamic discovery** — for OpenRouter routes, the picker fires
`GET https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints` on dialog
open (5s timeout, best-effort, public endpoint). Discovered slugs are
unioned with the hardcoded list and cached in-memory keyed by
`providerID/modelID` (not persisted — pure cache). Vercel AI Gateway has
no equivalent runtime API, so Gateway routes rely on the hardcoded list.

**New files**:
- `cli/cmd/tui/component/dialog-upstream.tsx` — picker with on-mount discovery.

**Touched**:
- `config/provider.ts`, `provider/provider.ts` — `upstreams: string[]` field +
  4 attach points + config override.
- `provider/transform.ts` — `availableUpstreams()` per-family defaults.
- `cli/cmd/tui/context/local.tsx` — `model.upstream` API (selected/list/set/
  cycle + `recordDiscovered`) mirroring variant/serviceTier.
- `cli/cmd/tui/component/dialog-{model,variant,service-tier}.tsx` — chain into
  upstream dialog when picking is needed.
- `cli/cmd/tui/config/keybind.ts` — `upstream_cycle` / `upstream_list` keybinds.
- `cli/cmd/tui/app.tsx` — `upstream.cycle` / `upstream.list` commands
  (`slashName: "provider"`).
- `session/message-v2.ts` — `upstream?: string` on `UserMessage.model`.
- `session/prompt.ts` — `upstream` on `PromptInput` / `CommandInput` +
  `createUserMessage`.
- `session/llm/request.ts` — translate pin into provider-specific options
  merged after tier.
- `cli/cmd/tui/component/prompt/index.tsx` — send `upstream` on
  session.prompt / session.command; footer indicator with `theme.info`
  color + "via" prefix.
- `@opencode-ai/sdk` regenerated.

### Confirmed — background subagents already run in parallel

(No code change; documenting capability discovered while reading the
TaskTool implementation.) Each `task(background=true)` invocation creates
its own `nextSession.id`, registers an independent `BackgroundJob`, and
forks via `Effect.forkIn(scope, { startImmediately: true })`. No
serialization between concurrent background tasks; the only collision
guard is against the SAME `task_id` running twice (for resume safety),
which doesn't apply to fresh task calls. The AI SDK supports parallel
tool calls on Claude Opus 4.x / GPT-5.x / etc., so the model can fire
several `task(background=true)` invocations in one tool-use turn and
they'll all run concurrently.

### Added — background subagents promoted from experimental to first-class

The `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` flag and the gating it implied
are gone. The TaskTool now unconditionally exposes:

- `background: true` — launches the subagent asynchronously, returns immediately
  with a `task_id`. The parent agent keeps working. When the subagent finishes,
  a synthetic user message with `<task_result>...</task_result>` is auto-injected
  into the parent session and the parent's loop auto-resumes if it was idle.
- `task_status(task_id, wait?)` — poll a background task, or block until done.

The runtime flag definition (`runtime-flags.ts:experimentalBackgroundSubagents`)
has been deleted. Tests that asserted the gating now assert that the parameters
and `task_status` tool are always visible.

### Added — `worktree: true` parameter on TaskTool

When set, the subagent runs inside a **fresh git worktree** branched off the
parent session's HEAD (`opencode-subagent/<slug>` branch under
`~/.local/share/opencode/data/worktree-subagent/<slug>/`). The subagent's
file edits land in the isolated directory — no conflicts with the parent
agent's in-progress work. The worktree path is reported in the tool output
so the LLM can decide to keep, merge, or clean it up later. Combine with
`background: true` for fully-parallel side-tasks.

Implementation note: `Session.create` gained an optional `directory` override
so subagent sessions can be scoped to a different working directory than the
parent's instance. Worktree creation itself shells out to `git worktree add`
directly rather than going through `Worktree.Service`, keeping the TaskTool's
Effect-layer surface narrow (the full service has a long dependency chain
that cascades through every test using `ToolRegistry`).

### Added — `Ctrl+B` mid-flight demotion: move a running subagent to background

Inspired by Claude Code's `Ctrl+B`. While a synchronous subagent tool call is
running, the user can press `Ctrl+B` (registered as `subagent.background`,
keybind `subagent_background`). The TUI publishes a `tui.subagent.demote`
event keyed on the current session. The TaskTool's sync waiter — which now
races `background.wait()` against `bus.subscribe(TuiEvent.SubagentDemote)` —
sees the event and returns the standard "background task started" stub to
the parent LLM. **The subagent fiber keeps running uninterrupted** — no
cancellation, no restart, no cache miss. When it eventually finishes, the
existing `inject()` path drops a synthetic user message into the parent
session and auto-resumes the loop, identical to LLM-elected background.

From the parent LLM's perspective, demoted and LLM-elected background are
indistinguishable: same stub format, same `task_id`, same eventual
completion notification. The LLM is told *"Background task started.
Continue your current work — you'll get the result when it lands."*

Tight-race handling: if the user presses Ctrl+B at the exact moment the
job finished, the demote handler checks `background.get(taskID)` first.
If the job is already complete, the actual result is returned inline
instead of forking a duplicate inject watcher.

### Changed — unified subagent dispatch

Sync and background paths now share infrastructure. Both register a
`BackgroundJob` and use its fiber to run `runTask()`. Sync mode awaits
`background.wait()` (raced against the demote signal); background mode
forks an `injectOnComplete` watcher and returns immediately. This let us
delete the separate `Effect.acquireUseRelease` sync path and the
`Effect.tap → Deferred.await(shouldInject)` inject-decision Deferred that
was deadlocking the fiber against the waiter (the pipeline couldn't
finish until the waiter set the Deferred, and the waiter awaited the
pipeline finishing). The fork-a-watcher design dodges that entirely.

### TUI bits

- New keybind `subagent_background: keybind("ctrl+b", "Move in-flight subagent to background")` (was unbound; `ctrl+b` removed from the `input_move_left` chord since `left` alone covers the cursor case).
- New TUI command `subagent.background` registered in `app.tsx` next to `variant.cycle` / `service_tier.cycle`. Reads the current session ID from `useRoute()`, publishes `TuiEvent.SubagentDemote` via `sdk.client.tui.publish`, and toasts "Subagent moved to background — you'll get the result when it finishes."
- New `BusEvent` `tui.subagent.demote` defined in `cli/cmd/tui/event.ts`. Schema: `{ sessionID }`.
- Server route `POST /tui/publish` extended to dispatch the new event type into the in-process `Bus.publish`.

### Files changed

- `packages/opencode/src/tool/task.ts` — unified flow + worktree creation + demote race + Description fields for background/worktree
- `packages/opencode/src/tool/task_status.ts` — drop experimental check
- `packages/opencode/src/tool/registry.ts` — `task_status` is always registered
- `packages/opencode/src/session/session.ts` — `Session.create` accepts optional `directory`
- `packages/opencode/src/effect/runtime-flags.ts` — delete `experimentalBackgroundSubagents`
- `packages/opencode/src/cli/cmd/tui/event.ts` — new `SubagentDemote` BusEvent
- `packages/opencode/src/cli/cmd/tui/config/keybind.ts` — `subagent_background` keybind + command map
- `packages/opencode/src/cli/cmd/tui/app.tsx` — new `subagent.background` command + name list entry
- `packages/opencode/src/server/routes/instance/httpapi/groups/tui.ts` — `TuiPublishPayload` union gains `EventTuiSubagentDemote`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/tui.ts` — dispatch on `SubagentDemote.type`
- 4 test files updated (`runtime-flags`, `registry`, `task`, `task_status`) — drop flag references, retarget assertions for the new behavior

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
