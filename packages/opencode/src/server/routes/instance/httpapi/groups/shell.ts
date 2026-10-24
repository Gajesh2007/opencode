import { ShellProcess } from "@/shell/process"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { ShellNotFoundError } from "../errors"
import { described } from "./metadata"

const root = "/shell"

export const ShellPaths = {
  list: root,
  get: `${root}/:shellID`,
  output: `${root}/:shellID/output`,
  kill: `${root}/:shellID/kill`,
} as const

export const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionID: Schema.optional(SessionID),
})

export const OutputQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  cursor: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
})

const ItemQuery = Schema.Struct(WorkspaceRoutingQueryFields)

export const ShellApi = HttpApi.make("shell")
  .add(
    HttpApiGroup.make("shell")
      .add(
        HttpApiEndpoint.get("list", ShellPaths.list, {
          query: ListQuery,
          success: described(Schema.Array(ShellProcess.Info), "Running and recently exited shell commands"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "shell.list",
            summary: "List shell commands",
            description:
              "List running and recently exited shell commands started by agents or users, optionally for one session.",
          }),
        ),
        HttpApiEndpoint.get("get", ShellPaths.get, {
          params: { shellID: ShellProcess.ID },
          query: ItemQuery,
          success: described(ShellProcess.Info, "Shell command"),
          error: ShellNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "shell.get",
            summary: "Get shell command",
            description: "Get the status of a running or recently exited shell command.",
          }),
        ),
        HttpApiEndpoint.get("output", ShellPaths.output, {
          params: { shellID: ShellProcess.ID },
          query: OutputQuery,
          success: described(ShellProcess.Output, "Captured output page"),
          error: ShellNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "shell.output",
            summary: "Read shell output",
            description:
              "Read captured combined stdout/stderr from a byte cursor. Pages end on character boundaries; keep reading while cursor is less than size.",
          }),
        ),
        HttpApiEndpoint.post("kill", ShellPaths.kill, {
          params: { shellID: ShellProcess.ID },
          query: ItemQuery,
          success: described(ShellProcess.Info, "Shell command after it was killed"),
          error: ShellNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "shell.kill",
            summary: "Kill shell command",
            description:
              "Kill a running shell command and its process group. Its output stays readable. Killing an exited command is a no-op.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "shell", description: "Shell command routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
