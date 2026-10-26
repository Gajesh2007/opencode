export * as MetaAgent from "./meta-agent.js"

import { Schema } from "effect"
import { Model } from "./model.js"
import { SessionID } from "./session-id.js"
import { optional } from "./schema.js"

export const Info = Schema.Struct({
  sessionID: SessionID,
  enabled: Schema.Boolean,
  basePrompt: Schema.String,
  model: Model.Ref.pipe(optional),
})
export type Info = typeof Info.Type
