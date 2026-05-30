import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./inbox.txt"
import { Team } from "../agent/team"

export const Parameters = Schema.Struct({
  peek: Schema.optional(Schema.Boolean).annotate({
    description: "If true, leave the messages in your inbox instead of clearing them after reading.",
  }),
})

type InboxMetadata = { team?: string; count?: number }

export const InboxTool = Tool.define<typeof Parameters, InboxMetadata, Team.Service>(
  "inbox",
  Effect.gen(function* () {
    const team = yield* Team.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const me = yield* team.whoami(ctx.sessionID)
          if (!me) return { title: "inbox", metadata: {}, output: "You are not part of a team." }
          const messages = yield* team.inbox({ team: me.team, recipient: me.name, drain: params.peek !== true })
          if (messages.length === 0) return { title: "inbox", metadata: { team: me.team, count: 0 }, output: "No new messages." }
          const body = messages.map((m) => `- from ${m.from}: ${m.message}`).join("\n")
          return {
            title: `${messages.length} message${messages.length === 1 ? "" : "s"}`,
            metadata: { team: me.team, count: messages.length },
            output: `Messages for ${me.name}:\n${body}`,
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, InboxMetadata>
  }),
)
