export * as Workflow from "./workflow.js"

import { Schema } from "effect"

export const Pass = Schema.Struct({
  name: Schema.String,
  agent: Schema.String,
  prompt: Schema.String,
})
export const Synthesis = Schema.Struct({ agent: Schema.String, prompt: Schema.String })
export const Definition = Schema.Struct({
  passes: Schema.Array(Schema.Struct({ ...Pass.fields, prompt: Schema.optionalKey(Schema.String) })),
  synthesis: Schema.optionalKey(Schema.Struct({ ...Synthesis.fields, prompt: Schema.optionalKey(Schema.String) })),
  format: Schema.optionalKey(Schema.Literals(["text", "findings"])),
  instructions: Schema.optionalKey(Schema.String),
})
export type Definition = typeof Definition.Type

export const Input = Schema.Struct({
  description: Schema.String,
  units: Schema.Array(Schema.Struct({ id: Schema.String, context: Schema.optionalKey(Schema.String) })),
  passes: Schema.Array(Pass),
  synthesis: Schema.optionalKey(Synthesis),
  format: Schema.optionalKey(Schema.Literals(["text", "findings"])),
  concurrency: Schema.optionalKey(Schema.Finite),
})
export type Input = typeof Input.Type
