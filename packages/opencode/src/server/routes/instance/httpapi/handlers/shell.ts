import { ShellProcess } from "@/shell/process"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import * as ApiError from "../errors"
import type { ListQuery, OutputQuery } from "../groups/shell"

export const shellHandlers = HttpApiBuilder.group(InstanceHttpApi, "shell", (handlers) =>
  Effect.gen(function* () {
    const shells = yield* ShellProcess.Service

    const list = Effect.fn("ShellHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      return yield* shells.list({ sessionID: ctx.query.sessionID })
    })

    const get = Effect.fn("ShellHttpApi.get")(function* (ctx: { params: { shellID: ShellProcess.ID } }) {
      return yield* shells.get(ctx.params.shellID).pipe(Effect.catchTag("ShellProcess.NotFoundError", notFound))
    })

    const output = Effect.fn("ShellHttpApi.output")(function* (ctx: {
      params: { shellID: ShellProcess.ID }
      query: typeof OutputQuery.Type
    }) {
      return yield* shells
        .output(ctx.params.shellID, { cursor: ctx.query.cursor, limit: ctx.query.limit })
        .pipe(Effect.catchTag("ShellProcess.NotFoundError", notFound))
    })

    const kill = Effect.fn("ShellHttpApi.kill")(function* (ctx: { params: { shellID: ShellProcess.ID } }) {
      return yield* shells.kill(ctx.params.shellID).pipe(Effect.catchTag("ShellProcess.NotFoundError", notFound))
    })

    return handlers.handle("list", list).handle("get", get).handle("output", output).handle("kill", kill)
  }),
)

function notFound(error: ShellProcess.NotFoundError) {
  return Effect.fail(
    new ApiError.ShellNotFoundError({ shellID: error.id, message: `Shell command not found: ${error.id}` }),
  )
}
