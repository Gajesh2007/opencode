export * as Goal from "./goal.js"

import { Schema } from "effect"
import { SessionID } from "./session-id.js"
import { optional } from "./schema.js"

export const Status = Schema.Literals(["active", "completed", "blocked", "budget_limited", "abandoned"])
export type Status = typeof Status.Type

export const Info = Schema.Struct({
  sessionID: SessionID,
  objective: Schema.String,
  status: Status,
  tokenBudget: Schema.Finite.pipe(optional),
  costBudget: Schema.Finite.pipe(optional),
  tokensUsed: Schema.Finite,
  costUsed: Schema.Finite,
  unknownAttempts: Schema.Finite,
  createdAt: Schema.Finite,
}).annotate({ identifier: "Goal.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
