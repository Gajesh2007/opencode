import type { Permission } from "../permission"
import type { Agent } from "./agent"
import { Wildcard } from "@opencode-ai/core/util/wildcard"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent **agent's** edit-class deny rules — Plan Mode's file-edit
 *    restriction lives on the agent ruleset, not on the session, so a
 *    subagent that only inherited the parent SESSION's permission would
 *    silently bypass it. (#26514)
 * 2. The parent **session's** deny rules, external_directory rules, and
 *    `spawn_agent` rules. A parent may require approval for nested agents;
 *    the child agent's wildcard allow must not bypass that decision.
 * 3. Default `todowrite`, `task`, and `workflow` denies if the subagent's own
 *    ruleset doesn't already permit them. `task` and `workflow` remain
 *    independently permission-gated; recursive `spawn_agent` calls use their
 *    own inherited `spawn_agent` permission.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: Permission.Ruleset
  parentAgent: Agent.Info | undefined
  subagent: Agent.Info
}): Permission.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canWorkflow = input.subagent.permission.some((rule) => rule.permission === "workflow")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  const parentAgentDenies =
    input.parentAgent?.permission.filter((rule) => rule.action === "deny" && rule.permission === "edit") ?? []
  return [
    ...parentAgentDenies,
    ...input.parentSessionPermission.filter(
      (rule) =>
        rule.permission === "external_directory" ||
        Wildcard.match("spawn_agent", rule.permission) ||
        rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canWorkflow ? [] : [{ permission: "workflow" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
