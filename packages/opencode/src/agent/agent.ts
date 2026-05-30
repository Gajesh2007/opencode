import { Config } from "@/config/config"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SCOUT from "./prompt/scout.txt"
import PROMPT_STEER from "./prompt/steer.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import PROMPT_REVIEW_SECURITY from "./prompt/review-security.txt"
import PROMPT_REVIEW_LOGIC from "./prompt/review-logic.txt"
import PROMPT_REVIEW_STYLE from "./prompt/review-style.txt"
import PROMPT_REVIEW_SYNTHESIZER from "./prompt/review-synthesizer.txt"
import PROMPT_REVIEW_ORCHESTRATOR from "./prompt/review-orchestrator.txt"
import PROMPT_BATCH_ORCHESTRATOR from "./prompt/batch-orchestrator.txt"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { type DeepMutable } from "@opencode-ai/core/schema"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: Permission.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelID,
      providerID: ProviderID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  serviceTier: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  initialPrompt: Schema.optional(Schema.String),
  mcpServers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  memory: Schema.optional(Schema.Literals(["user", "project", "local"])),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

const GeneratedAgent = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
})

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly setSubagentModel: (
    agent: string,
    model: { providerID: ProviderID; modelID: ModelID; variant?: string; serviceTier?: string } | undefined,
  ) => Effect.Effect<void>
  readonly listSubagentModels: () => Effect.Effect<
    Record<string, { providerID: ProviderID; modelID: ModelID; variant?: string; serviceTier?: string }>
  >
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderID; modelID: ModelID }
  }) => Effect.Effect<
    {
      identifier: string
      whenToUse: string
      systemPrompt: string
    },
    Provider.DefaultModelError
  >
}

type State = Omit<Interface, "generate" | "setSubagentModel" | "listSubagentModels">

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service
    const flags = yield* RuntimeFlags.Service

    const subagentModelOverrides = new Map<
      string,
      { providerID: ProviderID; modelID: ModelID; variant?: string; serviceTier?: string }
    >()

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const whitelistedDirs = [
          Truncate.GLOB,
          path.join(Global.Path.tmp, "*"),
          ...skillDirs.map((dir) => path.join(dir, "*")),
        ]
        const readonlyExternalDirectory = {
          "*": "ask",
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        } satisfies Record<string, "allow" | "ask" | "deny">

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          repo_clone: "deny",
          repo_overview: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        const user = Permission.fromConfig(cfg.permission ?? {})

        const agents: Record<string, Info> = {
          build: {
            name: "build",
            description: "The default agent. Executes tools based on configured permissions.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          plan: {
            name: "plan",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                external_directory: {
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",
                  [path.join(".opencode", "plans", "*.md")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          general: {
            name: "general",
            description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
          },
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
          },
          review: {
            name: "review",
            description:
              "Concurrent multi-lens code review orchestrator. Use to review changed files for security, logic, and style in parallel via the workflow engine, then synthesize one ranked report.",
            prompt: PROMPT_REVIEW_ORCHESTRATOR,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                workflow: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
          },
          batch: {
            name: "batch",
            description:
              "Splits a large change into independent work items and runs each as a worktree-isolated subagent that opens its own pull request. Use for codemods/migrations across many packages or files.",
            prompt: PROMPT_BATCH_ORCHESTRATOR,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                edit: "allow",
                write: "allow",
                webfetch: "allow",
                task: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
          },
          "review-security": {
            name: "review-security",
            description: "Security-lens code reviewer (read-only). Spawned by the review workflow.",
            prompt: PROMPT_REVIEW_SECURITY,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                grep: "allow",
                glob: "allow",
                list: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
            hidden: true,
          },
          "review-logic": {
            name: "review-logic",
            description: "Logic/correctness-lens code reviewer (read-only). Spawned by the review workflow.",
            prompt: PROMPT_REVIEW_LOGIC,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                grep: "allow",
                glob: "allow",
                list: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
            hidden: true,
          },
          "review-style": {
            name: "review-style",
            description: "Style/maintainability-lens code reviewer (read-only). Spawned by the review workflow.",
            prompt: PROMPT_REVIEW_STYLE,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                grep: "allow",
                glob: "allow",
                list: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
            hidden: true,
          },
          "review-synthesizer": {
            name: "review-synthesizer",
            description: "Merges code-review findings into one ranked report. Spawned by the review workflow.",
            prompt: PROMPT_REVIEW_SYNTHESIZER,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
            hidden: true,
          },
          ...(flags.experimentalScout
            ? {
                scout: {
                  name: "scout",
                  permission: Permission.merge(
                    defaults,
                    Permission.fromConfig({
                      "*": "deny",
                      grep: "allow",
                      glob: "allow",
                      webfetch: "allow",
                      websearch: "allow",
                      read: "allow",
                      repo_clone: "allow",
                      repo_overview: "allow",
                      external_directory: {
                        ...readonlyExternalDirectory,
                        [path.join(Global.Path.repos, "*")]: "allow",
                      },
                    }),
                    user,
                  ),
                  description: `Docs and dependency-source specialist. Use this when you need to inspect external documentation, clone dependency repositories into the managed cache, and research library implementation details without modifying the user's workspace.`,
                  prompt: PROMPT_SCOUT,
                  options: {},
                  mode: "subagent" as const,
                  native: true,
                },
              }
            : {}),
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
          steer: {
            name: "steer",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.3,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                read: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            prompt: PROMPT_STEER,
          },
        }

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) item.model = Provider.parseModel(value.model)
          // An explicit `variant` always wins; otherwise the `effort` ladder selects it.
          item.variant = value.variant ?? value.effort ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.initialPrompt = value.initialPrompt ?? item.initialPrompt
          item.mcpServers = value.mcpServers ?? item.mcpServers
          item.memory = value.memory ?? item.memory
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
          if (value.workflow) {
            // A declared workflow turns this agent into a fan-out orchestrator:
            // append the directive to its prompt and grant the `workflow` tool so
            // it works even when spawned as a subagent (which denies it by default).
            item.prompt = [item.prompt, renderWorkflowDirective(value.workflow)].filter(Boolean).join("\n\n")
            item.permission = Permission.merge(item.permission, Permission.fromConfig({ workflow: "allow" }))
          }
          if (value.skills?.length) {
            // Preload the named skills' full content into the agent's system prompt
            // at startup. Names that don't resolve are skipped silently.
            const blocks: string[] = []
            for (const name of value.skills) {
              const info = yield* skill.get(name)
              if (!info) continue
              blocks.push(`<skill_content name="${name}">\n${info.content.trim()}\n</skill_content>`)
            }
            item.prompt = [item.prompt, ...blocks].filter(Boolean).join("\n\n")
          }
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent
          }
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          return (yield* defaultInfo()).name
        })

        return {
          get,
          list,
          defaultInfo,
          defaultAgent,
        } satisfies State
      }),
    )

    function applyOverride(
      info: Info,
      override: { providerID: ProviderID; modelID: ModelID; variant?: string; serviceTier?: string },
    ): Info {
      return {
        ...info,
        model: { providerID: override.providerID, modelID: override.modelID },
        ...(override.variant !== undefined ? { variant: override.variant } : {}),
        ...(override.serviceTier !== undefined ? { serviceTier: override.serviceTier } : {}),
      }
    }

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        const info = yield* InstanceState.useEffect(state, (s) => s.get(agent))
        if (!info) return info
        const override = subagentModelOverrides.get(agent)
        if (override && info.mode !== "primary") return applyOverride(info, override)
        return info
      }),
      list: Effect.fn("Agent.list")(function* () {
        const items = yield* InstanceState.useEffect(state, (s) => s.list())
        return items.map((info) => {
          const override = subagentModelOverrides.get(info.name)
          if (override && info.mode !== "primary") return applyOverride(info, override)
          return info
        })
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultInfo())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      setSubagentModel: Effect.fn("Agent.setSubagentModel")(function* (
        agent: string,
        model: { providerID: ProviderID; modelID: ModelID; variant?: string; serviceTier?: string } | undefined,
      ) {
        if (model) subagentModelOverrides.set(agent, model)
        else subagentModelOverrides.delete(agent)
      }),
      listSubagentModels: Effect.fn("Agent.listSubagentModels")(function* () {
        return Object.fromEntries(subagentModelOverrides)
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderID; modelID: ModelID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: Object.assign(
            Schema.toStandardSchemaV1(GeneratedAgent),
            Schema.toStandardJSONSchemaV1(GeneratedAgent),
          ),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

function renderWorkflowDirective(workflow: {
  passes: { name: string; agent: string; prompt?: string }[]
  synthesis?: { agent: string; prompt?: string }
  format?: "text" | "findings"
  instructions?: string
}): string {
  const passes = workflow.passes
    .map((pass) => {
      const prompt = pass.prompt ?? `Process \`{unit_id}\` for the ${pass.name} pass. {unit_context}`
      return `  - { name: ${JSON.stringify(pass.name)}, agent: ${JSON.stringify(pass.agent)}, prompt: ${JSON.stringify(prompt)} }`
    })
    .join("\n")
  const lines = [
    "## Your workflow",
    "You run a fan-out workflow. When invoked, determine the list of work units to process (for example, the changed files), then call the `workflow` tool EXACTLY ONCE. Do not process the units yourself — the engine fans out every unit across each pass concurrently and synthesizes the results.",
    "",
    "Call `workflow` with these arguments:",
    "- units: one entry per work unit, as { id, context? }",
    "- passes:",
    passes,
  ]
  if (workflow.synthesis) {
    const prompt = workflow.synthesis.prompt ?? "Synthesize all results into one report."
    lines.push(`- synthesis: { agent: ${JSON.stringify(workflow.synthesis.agent)}, prompt: ${JSON.stringify(prompt)} }`)
  }
  lines.push(`- format: ${JSON.stringify(workflow.format ?? "text")}`)
  if (workflow.instructions) lines.push("", workflow.instructions)
  lines.push("", "Make a single `workflow` call for the whole batch; do not loop unit-by-unit.")
  return lines.join("\n")
}

export * as Agent from "./agent"
