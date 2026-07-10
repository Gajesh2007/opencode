import { Effect, Exit, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./inbox.txt"
import { Team } from "../agent/team"
import { Collaboration, formatMailbox } from "../agent/collaboration"

export const Parameters = Schema.Struct({
  peek: Schema.optional(Schema.Boolean).annotate({
    description:
      "If true, leave legacy Team messages in your inbox. Collaboration mail returned to the model is acknowledged.",
  }),
})

type InboxMetadata = { team?: string; task_path?: string; count?: number }

export const InboxTool = Tool.define<typeof Parameters, InboxMetadata, Team.Service | Collaboration.Service>(
  "inbox",
  Effect.gen(function* () {
    const team = yield* Team.Service
    const collaboration = yield* Collaboration.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const member = yield* collaboration.member(ctx.sessionID)
          const me = yield* team.whoami(ctx.sessionID)
          if (!member && !me) return { title: "inbox", metadata: {}, output: "You are not part of a team." }
          // Peek before claiming collaboration mail so a failed acknowledgement
          // cannot discard legacy Team mail.
          const teamMessages = me ? yield* team.inbox({ team: me.team, recipient: me.name, drain: false }) : []
          const collaborationMessages = member
            ? yield* Effect.acquireUseRelease(
                collaboration.claimInbox({ sessionID: ctx.sessionID }),
                (claimed) =>
                  claimed.length
                    ? collaboration.acknowledge({ sessionID: ctx.sessionID, messages: claimed })
                    : Effect.succeed([]),
                (claimed, exit) =>
                  Exit.isFailure(exit)
                    ? collaboration.releaseClaimedInbox({ sessionID: ctx.sessionID, messages: claimed })
                    : Effect.void,
              )
            : []
          const deliveredTeamMessages =
            me && params.peek !== true
              ? yield* team.inbox({ team: me.team, recipient: me.name, drain: true })
              : teamMessages
          const count = collaborationMessages.length + deliveredTeamMessages.length
          if (count === 0) {
            return {
              title: "inbox",
              metadata: {
                ...(member ? { task_path: member.path } : {}),
                ...(me ? { team: me.team } : {}),
                count,
              },
              output: "No new messages.",
            }
          }
          const body = deliveredTeamMessages.map((m) => `- from ${m.from}: ${m.message}`).join("\n")
          const output = [
            ...(collaborationMessages.length ? [formatMailbox(collaborationMessages)] : []),
            ...(deliveredTeamMessages.length ? [`Messages for ${me?.name}:\n${body}`] : []),
          ].join("\n\n")
          return {
            title: `${count} message${count === 1 ? "" : "s"}`,
            metadata: {
              ...(member ? { task_path: member.path } : {}),
              ...(me ? { team: me.team } : {}),
              count,
            },
            output,
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, InboxMetadata>
  }),
)
