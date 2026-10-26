export * as ConfigAgent from "./agent.js"

import { Effect, Schema } from "effect"
import { Permission } from "../permission.js"
import { optional, PositiveInt } from "../schema.js"
import { ConfigModel } from "./model.js"
import { ConfigProvider } from "./provider.js"
import { Agent } from "../agent.js"
import { Workflow } from "../workflow.js"

export const Color = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/u))

export class Info extends Schema.Class<Info>("Config.Agent")({
  model: ConfigModel.Selection.pipe(optional),
  request: ConfigProvider.Request.pipe(optional),
  system: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  mode: Schema.Literals(["subagent", "primary", "all"]).pipe(optional),
  hidden: Schema.Boolean.pipe(optional),
  // An unsupported color, such as a V1 theme name, should not drop the whole agent.
  color: Color.pipe(
    Schema.catchDecoding(() => Effect.succeedNone),
    optional,
  ),
  steps: PositiveInt.pipe(optional),
  disabled: Schema.Boolean.pipe(optional),
  permissions: Permission.Ruleset.pipe(optional),
  memory: Agent.Memory.pipe(optional),
  mcpServers: Schema.Array(Schema.String).pipe(optional),
  skills: Schema.Array(Schema.String).pipe(optional),
  initialPrompt: Schema.String.pipe(optional),
  workflow: Workflow.Definition.pipe(optional),
}) {}
