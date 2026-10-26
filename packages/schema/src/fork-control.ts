export * as ForkControl from "./fork-control.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { Goal } from "./goal.js"
import { MetaAgent } from "./meta-agent.js"
import { Model } from "./model.js"
import { SessionID } from "./session-id.js"

const SessionInput = Schema.Struct({ sessionID: SessionID })
export const State = Schema.Struct({
  goal: Schema.optionalKey(Goal.Info),
  reviewer: Schema.optionalKey(MetaAgent.Info),
  agents: Schema.Array(Schema.Struct({ sessionID: SessionID, path: Schema.String, status: Schema.String })),
  teams: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        members: Schema.Array(Schema.Struct({ name: Schema.String, sessionID: SessionID })),
        tasks: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            title: Schema.String,
            status: Schema.String,
            assignee: Schema.optionalKey(Schema.String),
            notes: Schema.optionalKey(Schema.String),
          }),
        ),
      }),
    ),
  ),
  workflows: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        status: Schema.String,
        cells: Schema.Number,
        completed: Schema.Number,
      }),
    ),
  ),
})
export const Definition = Rpc.define({
  id: "opencode.fork",
  methods: {
    state: { input: SessionInput, output: State },
    subagentModels: { input: Schema.Struct({}), output: Schema.Record(Schema.String, Model.Ref) },
    setSubagentModel: {
      input: Schema.Struct({ agent: Schema.String, model: Schema.optionalKey(Model.Ref) }),
      output: Schema.Void,
    },
    createGoal: {
      input: Schema.Struct({
        ...SessionInput.fields,
        objective: Schema.String,
        tokenBudget: Schema.optionalKey(Schema.Number),
        costBudget: Schema.optionalKey(Schema.Number),
      }),
      output: Goal.Info,
    },
    updateGoal: {
      input: Schema.Struct({ ...SessionInput.fields, status: Schema.Literals(["completed", "blocked", "abandoned"]) }),
      output: Schema.Struct({ goal: Schema.optionalKey(Goal.Info) }),
    },
    setReviewer: {
      input: Schema.Struct({
        ...SessionInput.fields,
        enabled: Schema.optionalKey(Schema.Boolean),
        basePrompt: Schema.optionalKey(Schema.String),
        model: Schema.optionalKey(Model.Ref),
      }),
      output: MetaAgent.Info,
    },
    clearReviewer: { input: SessionInput, output: Schema.Void },
    stopAgents: { input: SessionInput, output: Schema.Number },
  },
  events: {},
})
