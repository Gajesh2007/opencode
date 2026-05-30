import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./send_message.txt"
import { Team } from "../agent/team"

export const Parameters = Schema.Struct({
  to: Schema.String.annotate({ description: "Name of the teammate to message (see your team roster)" }),
  message: Schema.String.annotate({ description: "The message to send" }),
})

type SendMessageMetadata = { team?: string; from?: string; to?: string; id?: string }

export const SendMessageTool = Tool.define<typeof Parameters, SendMessageMetadata, Team.Service>(
  "send_message",
  Effect.gen(function* () {
    const team = yield* Team.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const me = yield* team.whoami(ctx.sessionID)
          if (!me) return { title: "send_message", metadata: {}, output: "You are not part of a team." }
          const roster = yield* team.roster(me.team)
          if (!roster.some((m) => m.name === params.to)) {
            const names = roster.map((m) => m.name).join(", ") || "(empty)"
            return {
              title: params.to,
              metadata: { team: me.team },
              output: `No teammate named "${params.to}" in team "${me.team}". Roster: ${names}.`,
            }
          }
          const msg = yield* team.send({ team: me.team, from: me.name, to: params.to, message: params.message })
          return {
            title: `to ${params.to}`,
            metadata: { team: me.team, from: me.name, to: params.to, id: msg.id },
            output: `Message delivered to ${params.to} (queued in their inbox).`,
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, SendMessageMetadata>
  }),
)
