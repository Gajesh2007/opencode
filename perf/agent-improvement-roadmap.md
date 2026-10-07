# Agent Improvement Roadmap

Consolidated research, product ideas, implementation candidates, and planning estimates from the October 2026 discussion.

**Status:** planning document with a working-tree implementation checkpoint below. P1/P2 repairs, F1 per-child selection, the separately requested goal-interruption pause, and the user-approved Bedrock no-output retry policy have been verified locally. This document does not authorize deployment or publication of session material.

**Evidence cutoff:** October 6, 2026, 23:30 UTC. Source references describe the checkout inspected during the discussion, including existing uncommitted work; they are not proof of what every historical session executed.

Private session IDs, message excerpts, and the full evidence ledger remain in the separate local audit. This repository-facing report retains aggregate observations and sanitized examples, not raw transcripts or credentials.

## Working-Tree Status: October 6, 2026

This checkpoint records implementation after the original audit, not a deployed runtime. The backlog, estimates, historical evidence, and original investigation sequence remain planning context below.

| Item              | Current Status                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1                | Confirmed and repaired. Two baseline cases using the real permission service reproduced a default child's inability to follow up a completed grandchild despite permitted spawning. Collaboration follow-up now uses inherited `spawn_agent` authority, and model-visible capability follows that authority while preserving explicit follow-up denials. Legacy Task remains independently denied where previously denied. |
| P2                | Confirmed and repaired. Seventeen short completions and two large completions reproduced stalled parent wakeup when the latest placeholder was outside the bounded inbox batch. Eligibility now checks the full pending queue, and successful delivery rechecks remaining eligible completions without increasing model-visible batch limits.                                                                              |
| F1                | Implemented and verified in the working tree. Creation and idle resumption support per-child `model`, model-specific `variant`, and explicit `reset_model`, with ownership, admission, persistence, and configured provider/model restrictions covered by regression tests.                                                                                                                                                |
| Goal interruption | Implemented and verified in the working tree, with independent review clear. Explicit stop pauses automatic goal pings and invalidates stale steering; the pause is runtime-only, not persisted across restart.                                                                                                                                                                                                            |
| Bedrock retries   | Implemented and verified in the working tree. The user explicitly approved default-on retries for known AWS Runtime/Mantle routes; custom non-AWS overrides are excluded. Raw-helper, full LLM-service, processor, and neighboring regression checks pass. See the policy, opt-out, and billing limits below.                                                                                                              |
| P3 / F2           | P3 remains conditional on explicitly scoped finite-cap compatibility; no cap or scheduler redesign is included. F2 active-child switching remains deferred.                                                                                                                                                                                                                                                                |

P2 preserves newer genuine user intent, ordinary `send_message` non-waking behavior, and cancellation. A failed or aborted latest parent assistant blocks autonomous wakeup; ordinary mail and late child results do not reauthorize work. Genuine new parent work can restore eligibility. Rechecks stop on failed, aborted, or non-progressing loops. This is not a restart-recovery or acknowledgement-durability redesign.

The new P1/P2 regression files are `packages/opencode/test/agent/subagent-followup-permission.test.ts` and `packages/opencode/test/agent/subagent-parent-wakeup.test.ts`. Their initial 9 permission and 15 wakeup cases passed, including three-run stability checks. F1 coverage includes `packages/opencode/test/agent/child-model.test.ts` and `packages/opencode/test/tool/task-model-selection.test.ts`. These use isolated fixtures and deterministic prompt operations, not live model calls.

Final independent verification recorded **1,002 unique targeted tests passing across 35 files, zero failures, one snapshot, and 3,963 assertions**. This comprises 671 agent/coordination tests, 126 prompt/goal/HTTP/Runner tests, 23 filtered provider-admission cases, and 182 Bedrock/new-and-existing cases. Separately, 101 concurrency/retention/cancellation cases passed three executions each, totaling 303 repeat executions; these are not additional unique cases. Final package typechecking exited zero. Intended-file formatting checks passed apart from the independently proven pre-existing `test/session/goal-driver.test.ts` formatting warning; that fixture's change adds only two dependency/import lines and leaves its existing style untouched. Command bodies are recorded under Validation Strategy below.

The runtime has not been deployed or restarted, and historical session databases were not modified. No end-to-end performance, cost, or user-supervision improvement has been measured or claimed. Other backlog items remain unimplemented by this scoped work unless separately recorded.

## Executive Summary

The objective is to make OpenCode produce correct, authorized, useful results with less user supervision and better use of parallel work. Token throughput and agent count are supporting measurements, not the objective.

The discussion produced three kinds of work:

1. **Reproduce specific correctness gaps first:** child follow-up permissions and parent wakeups under completion bursts. Test finite-cap nested scheduling as an optional configuration, not as a reason to introduce a cap.
2. **Build an explicitly requested capability:** let the parent choose each child's model and effort, including changes during an existing conversation. Deliver creation/idle-follow-up support first, then active changes at the next safe request boundary.
3. **Evaluate broader improvements:** more proactive delegation, focused context, reviewer cadence, resource coordination, and provider choices. Their benefits are hypotheses until representative tasks demonstrate them.

Prefer repairing existing session, delegation, result, and permission modules over adding another orchestration framework, task-contract language, or evidence database. Keep implementation and policy local to the modules that already own the behavior.

## Decision Record

These are the latest conclusions of the discussion. They supersede broader priorities suggested early in the audit.

| Topic                    | Current Position                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Immediate work           | P1/P2, F1, goal interruption, and the explicitly approved Bedrock retry policy are verified in the working tree; deployment is separate. |
| Finite concurrency       | Test nested-work deadlocks when a finite cap is configured. Unlimited remains the current default; a cap is not a requirement.           |
| Restart recovery         | Do not make a broad recovery redesign a repair priority without a concrete failing scenario.                                             |
| Ownership transitions    | Do not prioritize a new ownership state machine from historical scope mistakes alone. Establish a current failing transition first.      |
| Proactive delegation     | A model-independent policy is promising, but is not established as the highest-leverage improvement. Evaluate before broad rollout.      |
| Model and effort control | Explicitly requested feature. Scope settings to a child session, preserve user authority, and switch only at safe boundaries.            |
| Verification             | Task-specific and evidence-based. Neither mandatory full suites/reviews everywhere nor blanket removal of verification is supported.     |
| Measurement              | Track integrated success, end-to-end latency, user interventions, and cost alongside narrow regression-test results.                     |
| Implementation scope     | This report records ideas and a proposed sequence, not approval to build the entire backlog.                                             |

## First Principles

The useful unit of performance is a correctly completed task, not a model response.

```text
Time to an accepted outcome depends on:
  model and tool work on the critical path
  + coordination and delivery delay
  + human intervention and approval wait
  + rework from wrong assumptions, scope drift, or premature completion
```

This is a conceptual decomposition, not a formula to populate by adding the existing database durations. Concurrent operations overlap, historical records can be copied, and some timing fields are unreliable.

From the user's perspective, completion should mean the requested behavior works in the intended place, with the appropriate evidence and authority. From an agent's perspective, the harness should expose usable results, applicable tools, honest progress, current constraints, and clear dependencies. The model should not have to compensate for contradictory permissions or reconstruct whether a child result was delivered.

More agents help when independent useful work outweighs setup, duplicated context, shared-resource contention, and integration cost. The aim is more useful concurrency, not maximizing launched sessions.

## Research Basis

The initial audit used twelve subagents. Three further focused investigations examined parallelism controls, delegation blockers, and model-switching semantics.

| Research Surface             | Coverage                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Primary session census       | 5,273 pre-cutoff sessions: 417 roots and 4,856 children.                                                                                 |
| Cross-store roots            | 557 distinct root IDs after deduplicating 51 overlapping roots across two databases. Root does not guarantee human origin.               |
| Execution metadata           | 95 stratified sessions, 47 roots and 48 children, containing 10,477 messages and 40,757 parts.                                           |
| OpenCode behavior            | 244 nonsynthetic user-text records screened; 192 human candidates retained across 33 roots; 20 contextual anchors across 15 roots.       |
| d-inference behavior         | 28 time-stratified roots with 429 user-text messages, plus correction screening across 219 roots and 3,736 user-text occurrences.        |
| Other projects               | 50 in-scope screened root records, including eight harness-shaped records; selected contextual windows and positive controls.            |
| Source and workflow research | OpenCode runtime, tools, coordination, providers, UI, and tests; d-inference build, test, benchmark, release, and operational practices. |

Sampling was not population-proportional or a randomized efficacy study. Behavioral samples overlap metadata samples. Some roots are probes or generated assignments, and forks can copy history under new IDs. Nonsynthetic text does not authenticate human authorship. The live database could update existing records after the creation cutoff.

Consequently, the evidence supports qualitative needs and diagnostic candidates, not an overall failure rate, satisfaction rate, model ranking, or improvement/worsening trend. Static source findings were not reproduced during the audit. Historical incidents are useful regression scenarios, not proof that today's code caused them or still exhibits them.

### User Friction

| Observed Pattern      | Sanitized Example                                                                                                   | Implication                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Unusable delegation   | A child finished without a usable answer; another completion did not reach the parent.                              | Distinguish execution completion, usable output, and delivery.                          |
| Ambiguous progress    | The user could not tell whether children were queued, running, or inaccessible.                                     | Expose actual state and blocking reason.                                                |
| Supervision burden    | The user intervened over apparently stalled or looping delegated work.                                              | Reliable continuation matters more than simply spawning more agents.                    |
| Premature completion  | Goal mode was initially delivered as a passive tracker rather than an automatic continuation loop.                  | Check requested behavior, not only infrastructure or passing unit tests.                |
| Proxy success         | Completed execution and passing tests did not establish coherent inference output.                                  | Acceptance criteria must match the functional outcome.                                  |
| Wrong target          | A requested model was replaced with an easier evaluation target; priority was confused with ultrafast.              | Preserve exact target and option meanings.                                              |
| Wrong integration     | Repeated restart advice preceded discovering a change to a catalog the active picker did not use.                   | Trace the real runtime consumer and treat the user's observation as evidence.           |
| Scope and authority   | Work occurred in the wrong checkout; a production restart surprised the user during a release.                      | Use explicit execution targets and existing permission checks at consequential actions. |
| Publication ambiguity | Notes described as posted existed only locally; an external comment required sanitization.                          | State destination and distinguish local, submitted, accepted, and published.            |
| Verification mismatch | Some broad tests/reviews were unnecessary; elsewhere the user demanded canonical benchmarks and extensive research. | Select verification according to the task and uncertainty.                              |

Positive examples included protecting another session's edits, checking live merge/worktree state before cleanup, explaining why force-push would not fix a hook delay, and reporting focused versus unrun checks honestly. Explicit requests for expensive research and broad parallelism constrain any proposal to impose universal budgets or low caps.

### Quantitative Signals

These are unweighted observations from the metadata sample, not population estimates or proof of waste. Tool-entry figures use the audit's timestamp-consistency filter, which does not repair instrumentation or prove provenance.

| Signal                 | Observation                                                                                                                           | Interpretation Limit                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Truncated reads        | 1,427 of 3,371 read calls, 42.3%.                                                                                                     | Omitted content may not have been needed. Only one exact-input repeat followed a truncated read in the repeat analysis. |
| Coordination traffic   | 614 status/inbox/wait calls across 29 sessions.                                                                                       | Waiting may overlap useful child work.                                                                                  |
| Repeated status inputs | 200 extra identical-input occurrences among 482 task-status calls.                                                                    | Repeated observations can be legitimate when state changes.                                                             |
| Wrapper errors         | 188 of 12,666 tool entries had error status; 91 were reads.                                                                           | Not a task-failure rate or a classification of expected versus unexpected errors.                                       |
| Command outcomes       | 361 completed bash entries reported nonzero exit metadata.                                                                            | Tool completion is not command success; nonzero exits are not necessarily agent failures.                               |
| Prompt-volume proxy    | Reported input plus cache-read/write tokens had a median of about 222k and p95 of about 611k across 7,130 tokenful assistant records. | Not unique useful information, exact cross-provider prompt size, or a measured latency penalty.                         |
| Context growth         | 64 of 65 sessions with at least ten tokenful records ended at least twice their starting proxy.                                       | Useful history also grows naturally.                                                                                    |
| Compaction             | 13 compaction parts across five sessions, twelve manual and one automatic.                                                            | Does not prove broken automatic compaction; effective settings, versions, and model limits were not reconstructed.      |
| Delegation breadth     | One root had 164 direct children and 289 descendants; another reached depth seven.                                                    | Does not establish excessive, simultaneous, or ineffective work.                                                        |
| Attribution            | 350 messages predated their containing session; 53 tool-call IDs appeared across sampled sessions.                                    | New row IDs are not proof of newly executed work.                                                                       |

Do not use stored tool-duration sums to claim that polling consumed a particular fraction of runtime or that shell execution is nearly free. Metadata updates can reset a tool's stored start time. Assistant lifecycles include preparation, tools, retries, and cleanup. Forks copy usage and embedded timestamps. These are retained-history records, not an immutable execution or billing ledger.

## Existing Capabilities

Do not rebuild these capabilities or present them as new work. This table records the audit baseline; the working-tree checkpoint above records subsequent changes.

| Capability             | Current Behavior                                                                                                                               | Caveat                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Agent concurrency      | Unlimited unless explicitly capped. `OPENCODE_SUBAGENT_CONCURRENCY` overrides `experimental.subagent_concurrency`.                             | Repository configs inspected did not set a cap; running-process/global settings were not established.             |
| Task                   | Fresh specialists, background work, resumption, forks, and isolated worktrees.                                                                 | Worktrees start from HEAD, not uncommitted parent edits. Task forks cannot recursively fork.                      |
| Spawn                  | Immediate return, shared workspace, recursive registered collaboration, fresh context by default.                                              | Ordinary Task/workflow children without collaboration registration cannot simply use this path.                   |
| Workflow               | Units-by-passes fan-out with optional synthesis and per-workflow concurrency.                                                                  | Total-cell ceiling is not a concurrency target. Outcome handling needs investigation.                             |
| Tool concurrency       | Default AI SDK dispatch can start subsequent tool calls without waiting for earlier handlers.                                                  | The inspected native runtime defaults to ten concurrent handlers per request; this is not a global agent ceiling. |
| Prompts                | Existing instructions already encourage independent parallel tool calls and delegation.                                                        | More repetitions of the same instruction are unlikely to solve structural problems.                               |
| Collaboration          | Persisted mail, claims, follow-up claims, descendant cancellation, and result recovery mechanisms.                                             | Particular permission, wakeup, and acknowledgement paths still warrant reproduction.                              |
| Permission inheritance | Parent restrictions and plan-mode edit constraints have targeted coverage.                                                                     | New features must not widen delegated authority.                                                                  |
| Compaction             | Anchored summaries, recent-tail preservation, old-output pruning machinery, and protected skill outputs.                                       | Default semantics and actual request admission deserve validation.                                                |
| Model controls         | User-facing agent-type model/variant/tier overrides.                                                                                           | Not equivalent to parent-controlled, per-child-session settings.                                                  |
| Resource retention     | Sparse history hydration, bounded SSE queues, background-result receipts, inactive debug-view cleanup, and AI SDK stream-retention mitigation. | Saved gains are workload-specific; receipts are not a claim of cross-restart job durability.                      |

## Rewards And Effort

Effort estimates are focused engineer-days for someone familiar with the code, including relevant tests. They are planning ranges, not commitments. Parallel investigations can shorten elapsed time; implementation estimates cannot simply be divided by the number of agents.

High reward means a potentially important correctness, control, or supervision improvement. It does not promise a measured latency percentage. Conditional items only matter when their trigger is present. Estimates overlap and should not be added into one project total without rescoping.

### First Reproductions

| ID  | Work                                             | Expected Reward                                                                                        | Reproduction | Narrow Repair If Confirmed |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------ | -------------------------- |
| P1  | Child follow-up permission consistency.          | High for recursive collaboration; removes contradictory behavior and unnecessary replacement children. | 0.5-1 day    | 0.5-1.5 days               |
| P2  | Parent wakeup beyond inbox batch limits.         | High for broad parallel work; reduces manual retrieval and stalled integration.                        | 0.5-1 day    | 1-2 days                   |
| P3  | Nested orchestration under optional finite caps. | High for capped compositions; limited direct benefit under unlimited defaults.                         | 0.5-1 day    | 2-4 days                   |

First checkpoint: 1-2 engineer-days for P1/P2 reproductions, largely parallelizable. P3 adds 0.5-1 engineer-day only when finite-cap compatibility is in scope; it is not required for this initial checkpoint. Reproduction results determine whether and how to repair each path.

### Requested Feature

| ID  | Work                                                                                                                    | Expected Reward                                                        | Effort              |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------- |
| F1  | Explicit per-child model and effort at creation and idle follow-up, with consistent resolution across delegation paths. | High controllability; cost/latency improvement remains to be measured. | 2-4 days            |
| F2  | Active-child selection changes applied at the next safe request boundary, with pending/applied visibility.              | Adaptation during long tasks without restarting the conversation.      | Additional 3-6 days |

The earlier E4 idea, consistent child-model selection, is incorporated into F1/F2. It is not a separate duplicate project.

### Follow-On Candidates

| ID  | Work                                                                               | Expected Reward                                                         | Effort             |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------ |
| P4  | Truthful child/workflow outcomes: failed, empty, malformed, partial, and clean.    | High correctness value; prevents unusable reviews appearing successful. | 1-2 days           |
| P5  | Preserve tool start time through metadata updates.                                 | High diagnostic value, not a demonstrated speedup.                      | 0.5-1 day          |
| P6  | Small end-to-end regression set based on real corrections and successful controls. | High potential quality value; evaluates the requested behavior.         | 2-4 days initially |
| P7  | Reproduce auxiliary reviewer/steering failure handling and bound auxiliary calls.  | Medium-high reliability value.                                          | 1-2 days           |
| P8  | Reproduce cancellation during goal steering and scheduling.                        | High safety value if reachable; incidence unknown.                      | 1-3 days           |
| P9  | Verify and reconcile omitted/enabled/disabled pruning settings.                    | Potential medium context/cost benefit.                                  | 0.5-2 days         |

P4 and P5 are attractive small candidates after the initial reproductions. These estimates include focused validation, not an assumption that source inspection already proved a production failure.

### Experiments

| ID  | Work                                                                                 | Potential Reward                                                     | Effort                                           | Promotion Requirement                                                          |
| --- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| E1  | Model-independent proactive delegation policy.                                       | More useful parallel work without repeated user prompting.           | 1-2 days implementation plus 2-4 days evaluation | Better integrated success/latency or fewer interventions at acceptable cost.   |
| E2  | Focused child briefs, bounded retrieval, and source-attributed context measurements. | Lower cost and irrelevant context; potentially faster investigation. | 2-4 days                                         | No increase in missed constraints, rediscovery, or integration failures.       |
| E3  | Lens-only versus selective versus every-step review.                                 | Less serial overhead while retaining valuable corrections.           | 2-4 days                                         | Matched-task quality and latency/cost evidence, including unavailable reviews. |
| E5  | Provider/tier comparison on realistic agent tasks.                                   | Potentially large inference-latency gains with price tradeoffs.      | 2-4 days plus API spend                          | Accepted-task quality and actual total cost, not writing throughput alone.     |

E1 must preserve explicit task-level delegation opt-outs, including "no more forking," across follow-ups and model/effort changes. Evaluation must demonstrate that prohibited delegation stays disabled even when the parent remains authorized to continue working directly.

Automatic model escalation/downgrading is a later experiment, distinct from F1/F2's explicit parent-controlled capability. Its effort is not yet sized.

## Reproduction Details

The scenarios and source line numbers below retain the pre-repair audit plan. P1/P2 results are recorded in the working-tree checkpoint above; P3 remains conditional.

### P1: Follow-Up Permissions

At the audit baseline, spawn asked for `spawn_agent` permission, while collaboration follow-up asked for `task`. Default child session permissions could deny `task` without denying spawn. Visibility was filtered by tool name, so a follow-up tool could remain visible although its internal authorization rejected it.

Reproduce root -> default child -> grandchild -> grandchild completion -> child follow-up using the real permission service. Cover inherited allow, ask, and deny rules. Existing tests with a no-op permission callback do not establish this behavior.

If confirmed, align collaboration follow-up authorization, tool visibility, and inherited policy. Do not globally enable legacy Task or remove parent restrictions to work around the discrepancy.

Sources: `packages/opencode/src/agent/subagent-run.ts:223,338`; `agent/subagent-permissions.ts:26-41`; `session/llm/request.ts:244-249` relative to the same `src` directory.

### P2: Parent Wakeup

The audit baseline wake path checked whether the latest user-message ID appeared in the returned inbox batch. That batch is limited to sixteen messages and approximately 24,000 formatted characters. The latest completion can be outside it even when eligible work is pending.

Hold the parent busy, accumulate seventeen short completions, then make it idle without an intervening drain. Also test two large results crossing the character limit, several batches, and a newer genuine user turn. Require eventual eligible delivery without a manual second loop or overriding newer user intent.

If confirmed, check eligibility using queue metadata rather than the payload-limited display batch, and recheck after the resumed loop. Preserve bounded context delivery and the non-waking behavior of ordinary `send_message`. This is a liveness investigation, not proof that all results are lost. Acknowledgement durability and broad restart recovery are separate investigations, not additions to P2's immediate scope.

Sources: `packages/opencode/src/agent/subagent-run.ts:75-90`; `agent/collaboration.ts:40-85,776-789`; `session/prompt.ts:1615` relative to the same `src` directory.

### P3: Optional Caps

Task holds a permit for an entire child turn. Workflow cells acquire the same limiter. A Task-launched review orchestrator at cap one can wait for descendants that cannot acquire capacity. With cap N, N waiting orchestrators can form the same hold-and-wait condition.

Test real nested Task -> review -> Workflow composition at cap one, multiple orchestrators at cap N, and cancellation while queued. Direct workflow-cap tests are not enough.

If confirmed and finite-cap support is required, make waiting orchestrators yield/reacquire capacity safely rather than bypass descendant limits. Background mode or merely raising a finite cap does not eliminate the dependency cycle. Do not introduce a finite cap as part of this work.

Sources: `packages/opencode/src/tool/task.ts:468`; `tool/workflow.ts:191`; `agent/subagent-limit.ts:5-39` relative to the same `src` directory.

## Per-Child Models

The parent should be able to set a particular subagent's model and effort, including during an existing chat. This is an explicit product request, not a claim that automatic routing already improves performance.

### Use Cases

- Assign a suitable lower-cost model to bounded extraction or navigation.
- Increase effort when a child's problem requires deeper reasoning.
- Change models while retaining useful discovery and tool results.
- Reduce effort for subsequent mechanical work after the difficult decision is resolved.
- Keep different children on different selections without changing every instance of an agent type.

Switching can incur cold-cache/history costs. A stronger model does not automatically fix an infrastructure error, and changing models does not erase earlier assumptions or create an independent review.

### Existing Gaps

At the audit baseline, `Agent.setSubagentModel` was keyed by agent name and affected non-primary agent definitions. It is not an appropriate per-child storage mechanism. Task honored selected-agent settings; spawn explicitly inherited the parent model; follow-up normally preserved the child's latest user-message selection. None of the three tool interfaces exposed the requested per-call selection. The verified F1 working-tree implementation now addresses this gap without changing global agent-role defaults.

The main session loop resolves `lastUser.model`, not merely session metadata. Retries reuse captured request input. A UI-only or metadata-only update would not implement safe live switching.

Sources: `packages/opencode/src/agent/agent.ts:111,598-628`; `tool/task.ts:318-334`; `agent/subagent-run.ts:241-245,344-350`; `session/prompt.ts:1270-1319` relative to the same `src` directory.

### F1: Creation And Follow-Up

**Verified working-tree API, not a deployment claim:** `task`, `spawn_agent`, and `followup_task` accept optional `model`, `variant`, and `reset_model` fields. `model` uses `provider/model`; `variant` uses the selected model's supported reasoning-effort vocabulary, not a universal effort enum or a service-tier setting.

- `variant: "default"` clears named effort. An effort-only change retains the child's current model. A model change does not silently carry the previous model's effort to an incompatible destination.
- `reset_model: true` recomputes current selected-agent/parent defaults and cannot be combined with `model` or `variant`. Omission is not a reset: idle resumption preserves the child's latest effective selection.
- Selections persist per child across its resumed conversation, without changing agent-role defaults, siblings, or existing descendants. Successful results report effective model and variant.
- Busy resumes must reject without changing selection. Only the direct parent may explicitly change or reset an existing child's selection; this is not broader subtree administration.
- Explicit selections must respect the configured provider/model/variant catalog and required text/tool capabilities. Incompatible service-tier or upstream pins must reject rather than silently remap. This does not introduce new user-lock, spending, or automatic-routing policy systems.

The original design and validation goals below remain context. F1's creation and idle-resumption behavior is included in the passing 671-test focused sweep; active-child changes remain F2.

Extend existing creation and idle-follow-up interfaces with optional model and model-supported effort selection. Reuse the existing model-specific variant vocabulary internally rather than inventing a universal effort enum. Consolidate selection rules in the module that owns child execution.

| Situation                            | Proposed Semantics                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| New child with explicit selection    | Validate first, then start with that selection.                                                               |
| New child without explicit selection | Preserve documented defaults, resolving specialist settings and parent inheritance consistently.              |
| Idle child follow-up with selection  | Change that child's selection while preserving its conversation.                                              |
| Follow-up without selection          | Preserve the child's effective selection.                                                                     |
| Effort-only change                   | Keep the current model and validate the requested effort.                                                     |
| Model change                         | Resolve a valid destination effort explicitly; never silently carry an unsupported old variant across models. |
| Busy follow-up in F1                 | Reject without partial mutation; active changes belong to F2.                                                 |
| Reset                                | Provide an explicit way to return to documented defaults; ordinary omission is not a reset.                   |

Selection stays scoped to that child until changed or reset. It must not silently change other children of the same agent type or existing descendants. Return the resolved model and effort rather than merely echoing requested values.

Validate before creating a worktree/session or claiming a follow-up. Reject unavailable providers, unsupported variants, policy conflicts, and required capability mismatches with actionable feedback. Existing configured restrictions remain authoritative; no new user-lock policy schema was added. Reset/default presentation is specified by the implemented API above.

### F2: Active Changes

"Mid-chat" has two meanings. F1 supports a new idle follow-up in the same conversation. F2 supports changing an active child at the next logical model-request boundary.

| Boundary                              | Behavior                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Request already prepared or streaming | Keep its selection frozen, including retries.                                                                             |
| Tool already issued                   | Let it settle and persist its result; do not re-execute it to accomplish a switch.                                        |
| Next request not yet prepared         | Atomically apply the pending selection before building tools, system context, converted history, and accounting metadata. |
| Child finishes before another request | Preserve the selection for its next follow-up; do not manufacture a new turn.                                             |
| Explicit cancellation                 | Cancellation remains authoritative; a pending selection must not revive work.                                             |

Use a versioned selection and pending/applied acknowledgement. A parent needs to know whether a requested change has actually taken effect. One narrowly scoped configuration operation may be appropriate for active changes, but F1 should reuse existing tools instead of adding redundant creation/resume APIs.

No in-flight stream replacement, automatic cancellation-and-replay, or hidden restart belongs in the default design. A future interrupt-and-switch operation would require separate explicit semantics and side-effect reconciliation.

### Authority And Compatibility

- Enforce direct-parent ownership server-side initially. Reject self, ancestors, siblings, root, and unrelated targets. Broader subtree administration is not assumed.
- User locks, permitted providers/data destinations, and explicit spending restrictions outrank parent requests. Model changes do not grant new tool permissions.
- Task-level delegation opt-outs remain authoritative through model and effort changes; changing a selection must not re-enable prohibited spawning or forking.
- A user change invalidates conflicting queued parent changes. Resolve races at the application boundary, not only when the request is accepted.
- Keep effort, reasoning visibility, service tier, upstream routing, and delegation policy separate. A model switch must not silently buy priority/ultrafast or enable proactive delegation.
- Validate tools, media, output modes, authentication, context capacity, and model aliases before use. Historical private context may be sent to a different provider, so destination policy matters.
- Handle incompatible tier/upstream settings explicitly when changing providers; do not silently reuse or remap them.
- Recheck the target model's context fit. Old-model token usage is insufficient for a smaller target, and compaction can itself fail.
- Revalidate or conservatively invalidate provider continuation state on selection changes. Existing cross-model history conversion is useful but can be lossy.
- Record the effective selection for each request and expose current/pending settings in status/UI. Do not infer success from an accepted setter call alone.
- Account for reasoning, history resend, compaction, and descendant costs honestly. The existing root goal driver does not establish complete child-budget enforcement.

Sources for replay/context behavior: `packages/opencode/src/session/message-v2.ts:781-912`; `session/llm/native-runtime.ts:114-139`; `session/llm/request.ts:81-119`; `session/goal-driver.ts:80` relative to the same `src` directory.

### Feature Validation

Test two simultaneous children with different selections and ensure no cross-talk. Test creation, ordinary follow-up, explicit reset, invalid effort, unavailable model, user locks, unauthorized target, and different provider capabilities. Confirm failed validation has no partial creation or selection side effects.

For F2, test a queued change during streaming, during a tool call, during retry, immediately before preparation, after child completion, and racing cancellation or a user override. Assert old requests retain old attribution, new requests use the new selection, and tool side effects are not duplicated.

Evaluate the parent-controlled feature separately from an automatic routing policy. Automatic escalation after every tool error is not part of the MVP.

## Useful Parallelism

### Behavior We Want

The parent should reason about dependencies and useful independent deliverables rather than choose an arbitrary agent count.

```text
Parent establishes shared contract and acceptance criteria
    |
    +-- Backend worker implements server behavior
    +-- Frontend worker implements the client
    +-- Test worker develops acceptance cases
    +-- Research worker checks compatibility risks
    |
Parent integrates and verifies the combined result
```

- Launch independent work together rather than spawning one child and immediately waiting.
- Honor explicit task-level delegation opt-outs, including "no more forking." Permission to continue the task is not permission to launch more children or bypass a prohibited delegation operation.
- Keep useful critical-path work local while delegated work proceeds.
- Delegate concrete outcomes with relevant constraints, ownership, references, and return requirements.
- Group tightly coupled files under one worker; one agent per file is not a universal decomposition rule.
- Integrate usable results when they unblock work instead of imposing an unnecessary wait-for-all barrier.
- Reuse an informed child for related follow-ups when appropriate; use fresh context for genuinely separate work.
- Duplicate work deliberately for independent verification, not accidentally because ownership or results are unclear.
- Do not parallelize dependent commands, competing edits, or exclusive-resource benchmarks merely to increase concurrency.

These are operating principles to evaluate, not additional mandatory ceremony for trivial tasks.

### Controls And Affordances

Use spawn for registered recursive collaboration, Task background mode for specialists, and workflow for genuinely repetitive grids. Isolated worktrees help editing, but parent dirty changes are not automatically included. Pin the intended base and integration target without silently committing or stashing the user's work.

Task/workflow children and collaboration children have different capabilities. Reflect effective tools and permissions in guidance rather than claiming every child can recursively delegate. Built-in review and batch orchestrators already have explicit delegation permissions. Batch also assumes commit/push/PR actions in its prompt; it is not a generic parallel-editing shortcut without that authority.

Potential improvements to existing task/status interfaces include owned module/files, worktree/base, waiting-on reason, last meaningful progress, and result/verification status. Prototype only the information needed to resolve observed confusion. Do not turn this into a new ownership-transition state machine without current failure evidence.

Model-independent proactive policy remains E1 and is subordinate to explicit task-level delegation restrictions. The current special guidance is narrowly tied to Ultra support; tools can exist outside that gate. Experimental plan prompts also have fixed exploration/design counts. Changing either policy should be evaluated across small and large tasks rather than replacing every limit with unlimited spawning.

Parallel tool generation and agent concurrency are distinct. Production defaults inspected did not universally force parallel tool generation on or off; provider options differ. The explicit false setting found in the writing benchmark was an experimental control, not the application default. Native handler concurrency is a separate profiling candidate, not evidence of a current bottleneck.

Existing TUI controls include task/agent/workflow/team views, backgrounding an active Task, and agent-type model overrides. Improve truthful status and model-selection consistency before adding more overlapping control surfaces.

## Completion And Verification

### P4: Truthful Outcomes

Workflow can extract child text without checking an assistant error, while findings parsing can map malformed output to an empty list. Shared child execution already nudges empty replies but can still exhaust recovery without useful output.

Reuse existing outcome handling and distinguish valid clean results, partial coverage, malformed results, cancellation, infrastructure errors, and unusable empty responses. Preserve valid partial findings while making incomplete coverage visible. Do not require another reviewer merely to compensate for lost error information.

Test assistant errors, repeated empty finishes, malformed JSON, partially malformed findings, and valid `[]`. None of the failure fixtures should silently become a clean review.

Sources: `packages/opencode/src/tool/workflow.ts:174-205,392-393`; `workflow/finding.ts:63-84`; `agent/child-session.ts:75-122` relative to the same `src` directory.

### P6: Outcome Regressions

Build a small private, sanitized regression set around the actual requested behavior: autonomous continuation rather than a tracker; the model appearing in the active picker; exact requested model/tier; coherent functional output; correct worktree; correct publication destination; and a relevant benchmark rather than repeated nondiscriminating measurements.

Include successful and neutral controls. Not every question, stop, or continuation is a failure. Test checks must distinguish implemented, built, tested, functionally correct, submitted, accepted, and published without requiring every task to pass through every stage.

Reuse repository-owned commands and result parsers. Do not treat exit zero, a final assistant statement, or self-updated goal status as sufficient proof of the user's outcome.

### d-inference Adapters

d-inference already supplies many useful mechanisms: zero-test and skipped-test tripwires, component selection, matched Metal/build resources, pinned recursive dependencies, benchmark comparison rejection rules, hardware exclusivity checks, immutable artifact identity, and release-recovery receipts.

OpenCode should discover and retain results from these mechanisms rather than duplicate them. Revision/environment-bound validation reuse may avoid redundant work, but only where the repository's verification producer supports it. Do not silently bypass hooks or discard failed evidence.

Keep production actions, signing, publishing, and ordinary code edits distinct in existing permission handling. Preserve private operational evidence separately from public summaries, and surface contradictory deployment instructions before mutation. Historical examples justify regression cases and careful policy integration, not a proven current authorization-engine defect.

Relevant d-inference references are `scripts/run-nested-suite.sh`, `scripts/gemma_contbatch/baseline.py`, `docs/developer/serving-performance-qualification.md`, `docs/operations/provider-release.md`, and the August 31 coordinator deployment postmortem. They are project-owned adapters and evidence, not universal OpenCode policy.

## Reliability Candidates

P7-P9 and the following backlog are separate from the immediate P1/P2 reproductions. This table retains the audit's source indications and estimates; the subsequently requested narrow goal-interruption repair is recorded below, not a claim that the entire reliability backlog is complete.

| Work                               | Source Indication Or Need                                                                                           | Minimal Next Step                                                                                                             | Reward / Effort                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| P7 auxiliary-call failure handling | Reviewer/steering use `Effect.orDie`; callers attempt recovery with `Effect.catch`, which does not recover defects. | Reproduce failure propagation, preserve cancellation, bound duration/output, and expose skipped/unavailable review.           | Medium-high reliability; 1-2 days.                                      |
| P8 goal cancellation               | No post-steering generation/cancellation recheck at the observed continuation path.                                 | Reproduce cancellation while steering and at scheduling/start, without relocating the race.                                   | High safety if reachable; 1-3 days.                                     |
| Goal accounting                    | Latest-assistant accounting can omit earlier steps; duplicate idle events lack accounted-step identity.             | Reconcile durable step usage and define whether descendants/auxiliary calls belong in the budget before changing enforcement. | Potential high budget correctness; not sized beyond investigation.      |
| Explicit inbox acknowledgement     | Durable placeholder removal precedes replacement tool-result persistence.                                           | Reproduce interruption/after-hook failure in the exact gap; retain existing child/job result recovery.                        | Potential high delivery integrity; reproduction and repair not sized.   |
| Retry semantics                    | Runtime retry layers differ; late failures need side-effect-aware handling and preserved error classification.      | Fault-inject before output, after output, and after tool effects; record attempts and test safe retry boundaries.             | Potential high correctness/tail-latency value; measure and scope first. |
| Memory append                      | Shared memory append is an unlocked read-modify-write.                                                              | Concurrent-writer test; if reproduced, serialize append and protect replacement against stale versions.                       | Conditional correctness value; not sized.                               |
| Tool/result error taxonomy         | Wrapper completion, command exit, expected checks, cancellation, and infrastructure failures differ.                | Preserve existing result details and add only useful typed distinctions.                                                      | Medium diagnostic/control value; scope after P4/P5.                     |

The inbox gap is not proof that all child output disappears, and reversing two operations alone does not establish exactly-once delivery. Broad restart recovery stays deferred until a concrete scenario justifies it.

Auxiliary review should not silently count as passed when unavailable. Existing redirect limits bound corrections, not all successful review calls. Reviewer tool availability and prompt promises also need to agree. Their quality contribution belongs in E3, separate from repairing failure handling.

Relevant sources: `packages/opencode/src/session/goal-driver.ts:76-170`, `session/reasoning-reviewer.ts:148-162`, `session/steering.ts:149-161`, `agent/collaboration.ts:871-923`, `session/retry.ts`, `session/processor.ts:919-1017`, and `memory/memory.ts:54-62` relative to the same `src` directory.

### Goal Interruption: Verified

The separately requested explicit-stop repair pauses automatic goal continuation before cancellation can publish another idle event. Pending steering results, stale continuation callbacks, and duplicate idle notifications cannot inject a later continuation or budget ping after that stop. Synthetic prompts, collaboration mail, and loop-only calls do not clear the pause. Genuine new user work restores continuation eligibility without reviving an older steering generation; slow cleanup from an old cancellation must not cancel that newer work.

This is a runtime-only pause, not a persisted goal status or restart-recovery feature. It does not mark the goal completed or invent a blocked outcome. Normal internal runner interruption/preemption remains distinct from explicit user stop. No across-restart pause guarantee is claimed.

Coverage is in `packages/opencode/test/session/goal-interruption.test.ts` and neighboring prompt, goal-driver, HTTP, and Runner tests. The independent five-file sweep passed 126 tests with zero failures, and the independent correctness review reported no remaining blocker in this scope.

## Context And Tools

P9 first checks intended configuration behavior: pruning is documented as enabled by default, but the inspected guard returns when the setting is omitted. Verify the effective defaults and explicit true/false cases; do not infer that this caused historical context growth.

E2 then measures context volume by source: stable instructions, skills/tool descriptions, memory, conversation, and tool results. Keep useful stable prefixes deterministic while separating changing budget/status information where semantics permit. Existing tool sorting, instruction deduplication, and skill presentation have intentional behavior; do not remove them merely for looking repetitive.

| Idea                           | Smallest Useful Evaluation                                                                        | Important Constraint                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Focused child briefs           | Compare relevant task context with full forks on matched work.                                    | Fresh context is already the default; full forks still have valid uses.                        |
| Targeted retrieval             | Compare bounded reads and follow-up retrieval with current broad reads.                           | Truncation is not proof that the useful content was missing.                                   |
| Request admission              | Estimate the prepared next request, including new tool output, schemas, media, and model changes. | Avoid unnecessary compaction and detect an irreducibly oversized current request.              |
| Smaller memory/context surface | Measure source-attributed size and stale facts before trying summaries/on-demand retrieval.       | Do not drop critical instructions or turn historical preferences into permanent global policy. |
| Capability-specific tools      | Show tools the current child can actually use.                                                    | Preserve real compatibility and inherited permissions; avoid a wholesale tool-system rewrite.  |
| Stable request prefix          | Record continuation miss reasons and cache counters without logging payloads.                     | Prompt caching and server-side continuation are different mechanisms.                          |

Current read-only shell fallbacks are not universally prohibited. Grep guidance explicitly permits `rg` for counting, and shell guidance has necessary-use exceptions. Do not add another search tool or more prohibitions without observed capability friction.

Context reduction is only valuable if task success and constraint retention hold. Never silently lower effort, discard attachments, or drop necessary history to improve a latency chart.

## Runtime And UI

### Measure First

P5 preserves tool start time; a broader measurement extension can then connect existing session/message/tool IDs with step/attempt identity, fork/replay provenance, and a few milestones: accepted input, admitted work, dispatch, first useful output, tool completion, durable result, frontend receipt, and visible completion.

Separate queueing, approval wait, inference, tools, review, retry, compaction, and delivery. Use local monotonic durations and explicit cross-process correlation rather than subtracting unrelated clocks. Avoid raw prompt logging and per-token tracing by default.

### Profile-Gated Backlog

| Candidate                    | Potential Benefit                                                                    | Validation Required Before Priority                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Compaction suffix estimation | Avoid repeated conversion of overlapping history suffixes.                           | Same retained boundary/content with lower processing/allocation on long single-turn histories.                              |
| Summary lookup               | Avoid loading a whole session to retrieve one known summary.                         | Equivalent result and measurable reduced work on realistic sessions.                                                        |
| Snapshot finish capture      | Stage/scan once where track and patch currently repeat work.                         | Preserve pre-inference capture, fresh ignores, concurrent-edit behavior, cancellation, and undo fidelity.                   |
| Consumer-specific events     | Avoid sending unused sync envelopes through UI transport.                            | Synchronization consumers retain all required events; measure cloned/serialized bytes and paint delay.                      |
| Transcript working set       | Bound offscreen legacy transcript bodies rather than only message count per session. | Reopening, late events, deletion, active children, and hydration remain correct; measure retained bytes and responsiveness. |
| SSE reconnect convergence    | Refresh active transcripts and pending interactions after disconnection.             | Reproduce missed final state first; converge without inventing replay for unpersisted deltas.                               |
| Native tool concurrency      | Configure the per-request handler limit if it constrains useful work.                | Demonstrate a bottleneck and preserve cancellation/resource safety; not a global agent-cap change.                          |
| Provider error buffering     | Bound retained error bodies safely.                                                  | Partial-secret redaction tests before truncation order changes.                                                             |

These candidates are not yet sized. Expected reward depends on measured workload incidence and critical-path contribution. They should not displace the narrow permission and wakeup reproductions merely because a source path looks inefficient.

### Existing Gains

[Harness measurements](harness.md) and [memory-retention measurements](memory-retention.md) already document sparse history hydration, warm database initialization, snapshot-summary projection, immediate first-fragment publication, completion-order tool visibility, bounded slow-subscriber queues, and several retention fixes.

They are workload-specific observations, not additive whole-application memory savings or proven agent-task speedups. Avoid re-proposing already-applied work. The running process was not restarted or verified for patch adoption during the research.

## Providers And Cost

The saved October 6 Bedrock writing matrix reported approximately 23.92-24.51 seconds per Runtime-standard report request and 6.39-6.96 seconds for Ultrafast. It used three trials per path, a fixed evidence brief, low effort, and narrow output/completion checks. Catalog pricing was six times standard per token; that is not a measured sixfold total task-cost result.

This supports testing explicit provider/tier choices for similar output-heavy work, not a stable region ranking, a coding-quality advantage, or a native-runtime default switch. Endpoint region does not establish the physical inference backend. Burst delivery after first delta is not decoding speed.

E5 should compare representative tasks with the same source, model where applicable, effort, tools, and acceptance criteria, retaining failed attempts. Include startup, tools, final acknowledgement, and integration, not just one successful generation request.

Additional ideas to evaluate are coherent model phases rather than frequent switching, continuation miss instrumentation, realistic pauses/reconnects, and consistent pricing for selected tiers. Existing model metadata alone may not price a premium tier correctly. Root-goal totals and retained transcript usage are not complete billing records; include auxiliary calls, failed attempts where reported, descendants, and external-tool spend with explicit unknowns.

A matched AI SDK HTTP/native HTTP/WebSocket/continuation comparison is a later experiment. Existing local payload reductions do not establish a live end-to-end speed advantage. Keep experimental transports opt-in until representative quality and reliability checks support promotion.

### Bedrock No-Output Retries: Verified

The user explicitly approved default-on no-output retries for positively identified AWS Runtime/Mantle AI SDK routes after disclosure of the cost and cancellation limits. Custom non-AWS endpoint overrides are excluded, even when using a Bedrock SDK. The implementation is now verified in the working tree, not deployed: 60 raw-helper cases in `test/session/bedrock-retry.test.ts`, nine full LLM-service cases in `test/session/bedrock-retry-llm.test.ts`, and 25 processor cases in `test/session/bedrock-retry-processor.test.ts`, relative to `packages/opencode`. The six-file Bedrock verification sweep, including existing processor/retry/provider tests, passed 182 tests. This is an implementation policy, not a measured latency optimization.

- Before raw semantic progress, attempt windows are 10, 20, and 40 seconds, with at most three wire attempts for one guarded logical request. These are per-attempt pre-progress deadlines, not completion deadlines or a visible-text-only timer.
- A 75-second total pre-progress budget includes dispatch/setup, teardown, and retry backoff. Teardown has at most one second, bounded by the remaining budget. Backoff is separate from the attempt windows, includes 100-300 ms jitter, and honors an applicable `Retry-After` only when the remaining budget permits it; eligible provider errors otherwise use two/four-second fallback backoff plus jitter.
- The abandoned local attempt must be invalidated, aborted, and its setup/reader teardown confirmed before a replacement starts. Unconfirmed teardown fails closed; there is no local hedging. Caller cancellation is terminal, and late invalidated output is discarded.
- Semantic text/reasoning starts, tool-input activity, tool calls/results/approvals, and other semantic or unknown parts prevent replay before AI SDK hooks or tool dispatch can run. Requests containing hosted/provider-defined tools bypass this retry policy entirely. Metadata-only prefixes remain bounded.
- After semantic commitment, EOF without a real provider finish, including a synthetic unknown finish, is terminal rather than hollow success or permission to replay. Attempts abandoned without a valid finish are diagnosed as having unknown usage, including committed cancellations; a known finish is not relabeled unknown. These diagnostics do not establish AWS billing outcomes.
- The three-attempt budget is not multiplied by SDK, outer transient, or hollow-response retries. There is no automatic provider, model, effort, tier, or upstream failover. The deadlines remain workload hypotheses, not demonstrated time-to-first-token improvements.

The provider-level opt-out uses existing provider options. This example is documentation only; no configuration file was changed:

```json
{
  "provider": {
    "amazon-bedrock": {
      "options": {
        "noOutputRetries": false
      }
    }
  }
}
```

Disabling the policy retains the existing route's behavior; it is not a promise that every underlying retry layer is disabled. Local cancellation does not establish that AWS stopped inference, and an abandoned attempt may still incur charges. No general AWS server-abort or cancelled-request-free guarantee was established. No live billable benchmark calls, production restart, or AWS logging/configuration changes were performed to validate this policy.

Official AWS documentation distinguishes observability from billing:

- [Model invocation logging](https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html) covers the `bedrock-runtime` endpoint, including its OpenAI-compatible APIs, but does not capture `bedrock-mantle` calls. Invocation logging is disabled by default.
- [Per-request metadata tagging](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-request-metadata.html) records metadata and token counts in invocation logs, not the bill. Multiplying logged tokens by a rate card is an estimate, not invoice reconciliation; this metadata is not supported on Mantle.
- [Projects](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-projects.html) supports Mantle cost allocation through Cost Explorer and CUR, but its finest billed-cost grain is per usage type per day, not per request. These sources do not establish zero billing for an interrupted attempt.

## Deferred Designs

| Idea                                      | Why It Is Deferred                                                                                 | Reward And Effort Position                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Broad restart-recovery redesign           | Need concrete failing scenarios beyond the current wakeup investigation.                           | Potential reliability value; unsized.                                                               |
| Ownership-transition machinery            | Historical wrong-tree work does not establish a current transition defect.                         | Potential conflict prevention; unsized pending reproduction.                                        |
| Cross-session GPU/build/port reservations | Existing project scripts handle part of the problem; identify remaining recurring conflicts first. | Potential high value for constrained workloads; rough earlier range 5-10+ days, requires rescoping. |
| General task-contract/evidence platform   | Risks duplicating session, permissions, task results, and artifact state.                          | Potential depth behind a small interface, but large and premature.                                  |
| Universal automatic model router          | Explicit parent control is the requested MVP; routing quality and costs remain unknown.            | Unsized experiment after F1/F2.                                                                     |
| Wholesale native-runtime migration        | No representative end-to-end evidence justifying a default change.                                 | Large scope; premature.                                                                             |
| Blanket prompt/tool rewrite               | Existing instructions and compatibility often have a purpose.                                      | Measure concrete friction and source-attributed context first.                                      |

An advisory resource reservation, if eventually needed, cannot prove that non-cooperating processes are absent. Never kill unrelated workloads to make a benchmark appear exclusive. Likewise, approval does not prove correctness and should not become a prompt before every ordinary action.

## Validation Strategy

Every implementation needs focused regression tests and outcome-level evaluation. Neither substitutes for the other.

| Metric                      | Purpose                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Integrated task success     | Did the requested behavior work on the intended revision/target?                                            |
| End-to-end latency          | How long until a usable accepted result, including failures, retries, and integration?                      |
| User interventions          | How often did the user need to correct scope, restart work, retrieve results, or challenge completion?      |
| Actual cost                 | Model, reasoning, cache/history, auxiliary calls, descendants, and external tools, with unknowns visible.   |
| Safety/control              | Unauthorized actions, duplicate side effects, ignored cancellation, and wrong-target execution.             |
| Local regression guarantees | Permission consistency, eligible-mail wakeup, no nested-cap deadlock, truthful outcomes, and stable timing. |

Use small fixes, multi-module changes, read-only investigations, long tool-heavy tasks, and resource-constrained work. Include successful and neutral controls, not only previous complaints. Pin executable/source revision, model, effort, tier, tools, instructions, and relevant environment. Keep failed and interrupted runs; classify explicit user cancellation separately.

For policy experiments, use matched tasks and acceptance checks. Include explicit no-delegation and "no more forking" cases, including restrictions introduced mid-task and followed by a model/effort change. Require that prohibited operations remain disabled while permitted direct work can continue. Promote only when success and control remain acceptable and latency, intervention burden, or cost improves usefully. Do not rank policies by number of children, number of tool calls, or tokens per second alone. No percentage speedup target is justified before reliable baselines exist.

### Recorded Working-Tree Checks

The independent verification record reports these actual command bodies, run from `packages/opencode` with isolated configuration/permission environment variables, temporary test directories, in-memory test storage, model fetching disabled, offline npm settings, and `SHELL=/bin/sh`. Tests use deterministic provider/stream fixtures or local HTTP fixtures, not live inference. This is a correctness checkpoint, not a performance benchmark or deployment verification.

```sh
bun test --timeout 30000 test/background/job.test.ts test/agent/agent.test.ts test/agent/child-model.test.ts test/agent/collaboration.test.ts test/agent/subagent-run.test.ts test/agent/subagent-limit.test.ts test/agent/subagent-followup-permission.test.ts test/agent/subagent-parent-wakeup.test.ts test/tool/task.test.ts test/tool/task-model-selection.test.ts test/tool/collaboration.test.ts test/tool/task_status.test.ts test/workflow/engine.test.ts test/workflow/finding.test.ts test/permission/next.test.ts test/permission-task.test.ts test/session/collaboration.test.ts test/session/llm-request.test.ts test/session/ultrafast.test.ts test/provider/transform.test.ts test/provider/model-status.test.ts test/cli/tui/model-variant.test.ts test/cli/cmd/tui/provider-options.test.ts
bun test --timeout 30000 test/session/prompt.test.ts test/session/goal-driver.test.ts test/session/goal-interruption.test.ts test/server/httpapi-session.test.ts test/effect/runner.test.ts
bun test --timeout 30000 test/provider/provider.test.ts --test-name-pattern 'disabled_providers|enabled_providers|whitelist|blacklist|getModel|parseModel|variant'
bun test --timeout 30000 test/session/bedrock-retry.test.ts test/session/bedrock-retry-llm.test.ts test/session/bedrock-retry-processor.test.ts test/session/processor-effect.test.ts test/session/retry.test.ts test/provider/amazon-bedrock.test.ts
bun test --timeout 30000 --rerun-each 3 test/background/job.test.ts test/agent/subagent-run.test.ts test/agent/subagent-parent-wakeup.test.ts test/tool/task-model-selection.test.ts test/session/goal-interruption.test.ts
bun typecheck
```

The first four commands passed respectively **671**, **126**, **23**, and **182** tests with zero failures: **1,002 unique targeted cases across 35 files**, one snapshot, and 3,963 assertions. The 70 nonmatching provider tests were intentionally filtered. The fifth command passed **303 repeat executions** of 101 already-counted cases, with zero failures; it is a stability check, not 303 new cases. Final `bun typecheck` exited zero. This was a focused cross-module sweep, not the entire repository test suite.

Intended source/new-test formatting checks passed. The existing `test/session/goal-driver.test.ts` fixture alone retained a formatting warning independently reproduced against both HEAD and the working tree; its diff adds two dependency/import lines, with no reformatting. The roadmap's own formatting check also passes. No unrelated source/style cleanup was included.

## Execution Sequence

The original sequence is retained below; the working-tree checkpoint records verified P1/P2/F1, goal-interruption, and explicitly approved Bedrock retry work.

1. Run P1 and P2 reproductions. Add P3 as an independent regression investigation only when finite-cap compatibility is in scope.
2. Repair only confirmed failures, keeping fixes narrow and adding exact regression cases.
3. Define F1 defaults, ownership, and user-lock precedence; implement it alongside the relevant permission work once those semantics are reliable. It can be developed on an independent track, but must not bypass unresolved authorization behavior.
4. Take P4 and P5 as small follow-on candidates. Establish P6's representative outcome checks without requiring a large evaluation platform first.
5. Deliver F2 only after F1 selection semantics and request-boundary tests are sound. Reproduce P7/P8 and validate P9 independently rather than bundling unrelated control-flow changes.
6. Evaluate E1/E2/E3/E5. Keep broad recovery, ownership, resource scheduling, and transport redesigns evidence-gated.

For the initial parallel work, assign one agent to permission reproduction and one to wakeup reproduction. Add an optional-cap test agent only if P3 is brought into scope. The parent checks assumptions and integrates results. Permission and wakeup fixes touch the same implementation module; parallelize investigations but give shared-file edits one owner. Model-selection work spans common child execution and request preparation, so settle its semantics before dividing adapters among workers.

The work should reduce coordination burden for both user and agents, not introduce more compulsory coordination rituals.

## Source Map

Paths and line numbers are investigation entry points and may drift as the checkout changes.

| Area                               | Primary Sources                                                                                                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrency and child capabilities | `packages/opencode/src/agent/subagent-limit.ts`; `agent/subagent-permissions.ts`; `agent/child-session.ts`; `session/tools.ts:84` relative to the same `src` directory.                                     |
| Spawn, follow-up, wakeups          | `packages/opencode/src/agent/subagent-run.ts`; `agent/collaboration.ts`; `tool/spawn_agent.ts`; `tool/collaboration.ts` relative to the same `src` directory.                                               |
| Task/workflow execution            | `packages/opencode/src/tool/task.ts`; `tool/workflow.ts`; `workflow/finding.ts` relative to the same `src` directory.                                                                                       |
| Model defaults and live selection  | `packages/opencode/src/agent/agent.ts`; `session/prompt.ts`; `session/llm/request.ts`; `cli/cmd/tui/component/dialog-subagent-model.tsx` relative to the same `src` directory.                              |
| Cross-model replay                 | `packages/opencode/src/session/message-v2.ts`; `session/llm/native-runtime.ts`; `session/llm/continuation.ts` relative to the same `src` directory.                                                         |
| Goal/reviewer behavior             | `packages/opencode/src/session/goal-driver.ts`; `session/goal.ts`; `session/reasoning-reviewer.ts`; `session/steering.ts` relative to the same `src` directory.                                             |
| Context and retrieval              | `packages/opencode/src/session/compaction.ts`; `session/instruction.ts`; `session/system.ts`; `memory/memory.ts`; `tool/registry.ts`; `tool/read.ts`; `tool/grep.txt` relative to the same `src` directory. |
| Timing and persistence             | `packages/opencode/src/session/tools.ts`; `session/processor.ts`; `session/projectors.ts`; `session/session.ts` relative to the same `src` directory.                                                       |
| UI and event delivery              | `packages/opencode/src/server/event.ts`; `cli/cmd/tui/context/sdk.tsx`; `cli/cmd/tui/context/sync.tsx`; `sync/index.ts` relative to the same `src` directory; `packages/app/src/context/global-sdk.tsx`.    |
| Existing performance work          | `perf/harness.md`; `perf/memory-retention.md`; October 6 Bedrock reports; `packages/opencode/script/bench-openai-latency.md`.                                                                               |

## Bottom Line

The permission and wakeup gaps now have reproduced regressions and narrow working-tree repairs; F1 per-child model/effort selection, explicit-stop goal pause, and the user-approved Bedrock retry policy are verified locally. This does not imply deployment, AWS server-side cancellation, zero billing, or measured speedup. Preserve optional finite-cap behavior without making caps a requirement, and keep F2 active switching deferred. Improve truthful outcomes and measurements, then evaluate broader parallelism and cost policies against accepted results.

The target is more capable, dependable agents with less supervision, not simply more agents, more tools, or faster-looking output.
