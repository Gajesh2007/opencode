# Personal fork: full V2 migration

The target is the complete released OpenCode 2.1.4 source tree at
`74f8d4860f49c563909e6b039b0cc8b454ebce72`, with the custom behavior from
`Gajesh2007/opencode` at `48aee9586f153c47579b96f5cec196dfa4b6841a` carried forward.
The source branch and installed M5 Ultra binary remain unchanged while this
worktree is being validated. This document records work in progress, not a
completed migration or a deployment approval.

`fork-port-inventory.json` records every fork-only commit and changed path from
the shared ancestor. Generated files and benchmark recordings are included in
that inventory but are not substitutes for behavioral parity checks.

## Upstream foundation

- [x] Complete released V2 core, schema, protocol, server, client, CLI, TUI,
      web, desktop, plugin, storage migration and toolchain source.
- [x] Install the pinned Bun 1.4.4 dependencies without changing the existing
      fork checkout or its running processes.
- [x] Run the unmodified upstream `bun run check`: 34 package tasks passed.
- [ ] Validate V2 pairing with the iPhone client before switching the M5 service.
- [ ] Exercise migration against copies of the existing databases and settings.

## Fork behavior

- [x] Preserve agent memory, MCP allowlists, skill preload declarations and
      initial-prompt declarations in native V2 schemas and V1 config normalization.
- [x] Port user/project/local Markdown memory paths, reads, replacement and
      serialized appends; integrate the memory tool and fresh per-request context.
- [x] Apply agent MCP allowlists to the session's tool catalog and instructions.
- [x] Execute configured skill preloads with permission filtering.
- [x] Preserve `initialPrompt` declarations; the old fork stored but did not execute this field.
- [x] Port richer frontmatter and workflow declarations. The fork had no additional
      executable lifecycle-hook schema; native V2 plugin hooks own that surface.
- [x] Port canonical child-agent names, scoped messaging, follow-up turns and mailbox waits.
- [x] Add full and last-N-turn child context inheritance, fresh worktree placement,
      and `spawn_agent` / `task` / `task_status` compatibility tools.
- [x] Exercise fresh Git worktrees, named children, compatibility tools, inheritance
      and workflow fan-out through actual session and job services.
- [x] Port team membership, shared tasks, workflow fan-out, finding aggregation
      and synthesis, plus roster and workflow progress dialogs. V2 renders their
      tool results through its native tool-result presentation.
- [x] Port goal lifecycle, recorded usage budgets, continuation outbox, supervisor
      steering and three-consecutive-blocker handling. Include auxiliary review usage.
- [x] Add goal and reviewer controls through the V2 authenticated plugin RPC.
- [ ] Finish interruption/recovery integration coverage and persistent goal display.
- [x] Port optional per-step reasoning review, persistent configuration and UI controls.
- [x] Exercise auxiliary review through the LLM service boundary and charge child
      review usage to its root goal.
- [x] Preserve independent variant, service tier, upstream and Pro reasoning mode;
      persistent per-subagent model overrides; child inheritance; gateway billed
      cost; and native V2 throughput display.
- [x] Verify native V2 ownership of background jobs, OpenAI/Codex separation,
      WebSocket continuation, streamed tool execution and request warming. Port
      the fork-specific parent interruption behavior and configured child limit.
- [x] Retain the V2 model catalog, native Bedrock/Mantle transports, bounded native
      retry policy, and one-hour Anthropic prompt caching. Add the fork service-tier
      choices, custom tier headers, gateway cost metadata and Pro wire field.
      Provider internals are V2 implementations, not copies of the old SDK shims.
- [x] Port the installed Yukon session-attribution hook to the V2 shell plugin contract.
- [ ] Regenerate public clients; pass affected tests, full checks and builds.
- [ ] Back up the M5 installation, install the validated fork, verify the
      mobile session lifecycle and leave a fresh pairing QR on its screen.

## Validation scope

Validation uses isolated temporary homes, configuration, databases and in-process
LLM responses. No test accesses the user's provider credentials or production
inference services. The machine install is checked separately with read-only
health requests, one harmless shell command and one-time pairing credentials.

This is a V2 rebase with the custom features integrated into the new service
boundaries, not a line-for-line copy of V1 internals. V2 owns provider retries,
terminal presentation and lifecycle management. The old standalone remote web
implementation is superseded by V2's bundled web app and pairing API. Team
mailboxes remain process-local as in the fork; named agent messages and goal
continuations use V2's durable session inbox. FileVault and Tailscale changes are
machine setup, not source changes.

## Major V2 changes

The complete upstream tree brings these changes, not just the mobile handshake:

| Area              | V2 behavior                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Architecture      | Separate schema, AI, core, protocol, server, client, CLI and TUI packages with explicit service boundaries.                     |
| Runtime           | One durable background server shared by clients; locations and sessions are selected explicitly.                                |
| API               | Typed `/api` routes and generated clients replace the V1 route contract. The phone pairs against this contract.                 |
| Session execution | Durable inbox admission, queued versus steering inputs, process-global execution, interruption and restart claims.              |
| Data              | V1 import, durable event log, new projections, session forks and explicit workspace placement.                                  |
| Tools             | Native background jobs and shells, subagents, PTYs, permissions, structured results and streamed tool input.                    |
| Models            | Provider-neutral AI layer, native provider protocols, variants, model discovery, credentials/integrations and transport policy. |
| Performance       | Native WebSocket sessions, continuation recovery, request warming, streaming execution and location lifetime management.        |
| Configuration     | V1 normalization into V2 configuration; terminal settings move into `cli.json`.                                                 |
| Plugins           | New Effect and Promise contracts, scoped registration, typed hooks, plugin RPC and TUI extension surfaces.                      |
| Clients           | Updated terminal, web and desktop clients, mobile-compatible remote pairing and authenticated tunnel access.                    |
| Toolchain         | Bun 1.4.4, updated native dependencies and packaging/build verification.                                                        |

## Validation checkpoint

- Root `bun run check`: all 34 tasks pass.
- Full terminal suite: 1,549 passed, 2 skipped; the new dialogs also passed ten
  repeated runs at both 100- and 44-column widths under concurrent test load.
- Full AI suite: 1,829 passed, 28 skipped.
- Full core suite: 6,799 passed, 43 skipped, 8 failed. Seven failures reproduce
  in unmodified V2 with macOS's system Bash. The additional filesystem watcher
  timeout passes on a focused rerun (all 16 watcher tests pass).
- Migration, child-context/worktree, workflow, goal/reviewer budget, model routing
  and real plugin-RPC checks pass in their focused runs.
- Compiled macOS ARM64 server smoke: anonymous access is denied; pairing tokens
  work; sessions, goals, reviewers and subagent model choices persist across
  restart; shell execution and Yukon attribution work.
- M5 source data inspection found no saved sessions, goals or reviewer records.
- M5 installation and final phone pairing remain pending until the machine
  validation below is recorded.
