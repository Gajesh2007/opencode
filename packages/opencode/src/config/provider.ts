import { Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"
import { ModelStatus } from "@/provider/model-status"

export const Model = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  family: Schema.optional(Schema.String),
  release_date: Schema.optional(Schema.String),
  attachment: Schema.optional(Schema.Boolean),
  reasoning: Schema.optional(Schema.Boolean),
  temperature: Schema.optional(Schema.Boolean),
  tool_call: Schema.optional(Schema.Boolean),
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Literal(true),
      Schema.Struct({
        field: Schema.Literals(["reasoning_content", "reasoning_details"]),
      }),
    ]),
  ),
  cost: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
      context_over_200k: Schema.optional(
        Schema.Struct({
          input: Schema.Finite,
          output: Schema.Finite,
          cache_read: Schema.optional(Schema.Finite),
          cache_write: Schema.optional(Schema.Finite),
        }),
      ),
    }),
  ),
  limit: Schema.optional(
    Schema.Struct({
      context: Schema.Finite,
      input: Schema.optional(Schema.Finite),
      output: Schema.Finite,
    }),
  ),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.mutable(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"]))),
      output: Schema.mutable(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"]))),
    }),
  ),
  experimental: Schema.optional(Schema.Boolean),
  status: Schema.optional(ModelStatus),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
  options: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  variants: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.StructWithRest(
        Schema.Struct({
          disabled: Schema.optional(Schema.Boolean).annotate({ description: "Disable this variant for the model" }),
        }),
        [Schema.Record(Schema.String, Schema.Any)],
      ),
    ).annotate({ description: "Variant-specific configuration" }),
  ),
  upstreams: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description:
        "Whitelist of upstream provider slugs this model can be pinned to (gateway/openrouter routes). When empty, falls back to defaults derived from the model id.",
    }),
  ),
  serviceTiers: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.StructWithRest(
        Schema.Struct({
          disabled: Schema.optional(Schema.Boolean).annotate({
            description: "Disable this service tier for the model",
          }),
          headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
            description: "Extra request headers required by this service tier (e.g. anthropic-beta)",
          }),
        }),
        [Schema.Record(Schema.String, Schema.Any)],
      ),
    ).annotate({
      description:
        "Service-tier-specific configuration. Keys are tier names ('priority', 'fast', 'flex', 'throughput', ...) and values are providerOptions to merge into the request.",
    }),
  ),
})

export const Info = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  env: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  id: Schema.optional(Schema.String),
  npm: Schema.optional(Schema.String),
  whitelist: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  blacklist: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  options: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        apiKey: Schema.optional(Schema.String),
        baseURL: Schema.optional(Schema.String),
        enterpriseUrl: Schema.optional(Schema.String).annotate({
          description: "GitHub Enterprise URL for copilot authentication",
        }),
        setCacheKey: Schema.optional(Schema.Boolean).annotate({
          description: "Enable promptCacheKey for this provider (default false)",
        }),
        responsesContinuation: Schema.optional(Schema.Boolean).annotate({
          description:
            "Enable OpenAI Responses previous_response_id continuation. Experimental; defaults to false until fallback handling is hardened.",
        }),
        timeout: Schema.optional(
          Schema.Union([PositiveInt, Schema.Literal(false)]).annotate({
            description:
              "Timeout in milliseconds for requests to this provider. Default is 300000 (5 minutes). Set to false to disable timeout.",
          }),
        ).annotate({
          description:
            "Timeout in milliseconds for requests to this provider. Default is 300000 (5 minutes). Set to false to disable timeout.",
        }),
        chunkTimeout: Schema.optional(PositiveInt).annotate({
          description:
            "Timeout in milliseconds between streamed SSE chunks for this provider. If no chunk arrives within this window, the request is aborted.",
        }),
      }),
      [Schema.Record(Schema.String, Schema.Any)],
    ),
  ),
  models: Schema.optional(Schema.Record(Schema.String, Model)),
}).annotate({ identifier: "ProviderConfig" })
export type Info = Schema.Schema.Type<typeof Info>

export * as ConfigProvider from "./provider"
