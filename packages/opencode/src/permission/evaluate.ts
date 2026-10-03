import { Flag } from "@opencode-ai/core/flag/flag"
import { PermissionV2 } from "@opencode-ai/core/permission"

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV2.Ruleset[]): PermissionV2.Rule {
  if (Flag.OPENCODE_YOLO_FOREVER) return { permission, pattern, action: "allow" }
  return PermissionV2.evaluate(permission, pattern, ...rulesets)
}
