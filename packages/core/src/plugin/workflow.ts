export * as WorkflowPlugin from "./workflow.js"

import { ToolFailure } from "@opencode/ai"
import { define } from "@opencode/plugin/effect/plugin"
import { Workflow } from "@opencode/schema/workflow"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Cause, Clock, Effect, Schema } from "effect"
import path from "node:path"
import { Agent } from "../agent.js"
import { Permission } from "../permission.js"
import { SubagentTool } from "../tool/plugin/subagent.js"
import { WorkflowFinding } from "../workflow/finding.js"
import { WorkflowReport } from "../workflow/report.js"

export const Plugin = define({
  id: "opencode.workflow",
  effect: Effect.fn("WorkflowPlugin")(function* (ctx) {
    const agents = yield* Agent.Service
    const permissions = yield* Permission.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name: "workflow",
          options: { codemode: false },
          input: Workflow.Input,
          output: Schema.Struct({
            report: Schema.String,
            artifacts: Schema.String,
            cells: Schema.Number,
            incomplete: Schema.Number,
          }),
          description:
            "Run every work unit through every review pass using child agents, with optional synthesis. Templates accept {unit_id} and {unit_context}. Findings mode parses, deduplicates and ranks JSON findings. Use only when parallel agent work is authorized.",
          execute: (input, context) =>
            Effect.gen(function* () {
              const count = input.units.length * input.passes.length
              if (!count || count > 20_000)
                return yield* new ToolFailure({
                  message: "A workflow needs 1–20000 unit/pass pairs. Split larger batches.",
                })
              if (input.concurrency !== undefined && (!Number.isInteger(input.concurrency) || input.concurrency < 1))
                return yield* new ToolFailure({ message: "Workflow concurrency must be a positive integer." })
              const names = [
                ...new Set([
                  ...input.passes.map((pass) => pass.agent),
                  ...(input.synthesis ? [input.synthesis.agent] : []),
                ]),
              ]
              for (const name of names) {
                const agent = yield* agents.resolve(name)
                if (!agent || agent.mode === "primary")
                  return yield* new ToolFailure({ message: `Unknown subagent: ${name}` })
              }
              yield* permissions.assert({
                action: "workflow",
                resources: names,
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              const subagent = (yield* ctx.tool.list()).find((tool) => tool.id === SubagentTool.name)
              if (!subagent) return yield* new ToolFailure({ message: "The subagent tool is unavailable." })
              let ordinal = 0
              const run = (agent: string, description: string, prompt: string) =>
                subagent
                  .execute(
                    {
                      agent,
                      description,
                      prompt,
                      name: "workflow_" + context.id.replace(/[^a-zA-Z0-9_-]/g, "_") + "_" + ordinal++,
                    },
                    { ...context, progress: () => Effect.void },
                  )
                  .pipe(
                    Effect.flatMap((result) => Schema.decodeUnknownEffect(SubagentTool.Output)(result.output)),
                    Effect.mapError((error) => new ToolFailure({ message: "Invalid subagent workflow result", error })),
                  )
              const cells = input.units.flatMap((unit) => input.passes.map((pass) => ({ unit, pass })))
              const live = cells.map((cell) => ({ unit: cell.unit.id, pass: cell.pass.name, status: "pending" }))
              let completed = 0
              const progress = () =>
                context.progress({ title: input.description, cells: count, completed, cellStatus: live.slice(0, 60) })
              const results = yield* Effect.forEach(
                cells,
                (cell, index) =>
                  Effect.gen(function* () {
                    live[index].status = "running"
                    yield* progress()
                    const result = yield* run(
                      cell.pass.agent,
                      `${cell.pass.name}: ${cell.unit.id}`,
                      cell.pass.prompt
                        .replaceAll("{unit_id}", cell.unit.id)
                        .replaceAll("{unit_context}", cell.unit.context ?? ""),
                    ).pipe(
                      Effect.map(
                        (result): WorkflowReport.Cell => ({
                          unit: cell.unit.id,
                          pass: cell.pass.name,
                          agent: cell.pass.agent,
                          sessionID: result.sessionID,
                          text: result.output,
                          status: result.status === "completed" ? "completed" : "partial",
                        }),
                      ),
                      Effect.catchCause((cause) =>
                        Cause.hasInterrupts(cause)
                          ? Effect.failCause(cause)
                          : Effect.succeed<WorkflowReport.Cell>({
                              unit: cell.unit.id,
                              pass: cell.pass.name,
                              agent: cell.pass.agent,
                              text: "",
                              status: "error",
                              error: Cause.pretty(cause),
                            }),
                      ),
                    )
                    if (input.format === "findings" && result.status === "completed") {
                      const parsed = WorkflowFinding.parseFindings(result.text, {
                        file: cell.unit.id,
                        lens: cell.pass.name,
                      })
                      result.findings = parsed.findings
                      if (parsed.status !== "valid") {
                        result.status = parsed.status
                        result.error = `${parsed.rejected} invalid findings; result is ${parsed.status}`
                      }
                    }
                    completed++
                    live[index].status = result.status === "completed" ? "done" : "error"
                    yield* progress()
                    return result
                  }),
                { concurrency: input.concurrency ?? "unbounded" },
              )
              const coverage = WorkflowReport.coverage(results)
              const aggregate = WorkflowReport.aggregate(results, input.format ?? "text")
              const synthesis = input.synthesis
                ? yield* run(
                    input.synthesis.agent,
                    `synthesis: ${input.description}`,
                    `${input.synthesis.prompt}\n\n${coverage}\n\n${aggregate.prompt}`,
                  ).pipe(
                    Effect.map((result) => result.output),
                    Effect.catch((error) =>
                      Effect.succeed(`Synthesis failed: ${error.message}\n\n${aggregate.fallback}`),
                    ),
                  )
                : aggregate.fallback
              const report = `${coverage}\n\n${synthesis}`
              const slug = input.description
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .slice(0, 40)
              const artifacts = path.join(global.data, "workflow", `${yield* Clock.currentTimeMillis}-${slug}`)
              yield* Effect.all([
                fs.writeWithDirs(path.join(artifacts, "outcomes.json"), JSON.stringify(results, null, 2)),
                fs.writeWithDirs(path.join(artifacts, "report.md"), report),
                aggregate.findings
                  ? fs.writeWithDirs(path.join(artifacts, "findings.json"), JSON.stringify(aggregate.findings, null, 2))
                  : Effect.void,
              ]).pipe(Effect.catch((error) => Effect.logWarning("Unable to save workflow artifacts", { error })))
              return {
                output: {
                  report,
                  artifacts,
                  cells: count,
                  incomplete: results.filter((item) => item.status !== "completed").length,
                },
                content: report,
                metadata: { cells: count, completed, phase: "done", cellStatus: live.slice(0, 60), artifacts },
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Workflow failed", error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
})
