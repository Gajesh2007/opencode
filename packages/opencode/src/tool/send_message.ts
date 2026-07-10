import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./send_message.txt"
import { Collaboration, MAX_MAILBOX_PAYLOAD_CHARS } from "../agent/collaboration"
import { Team } from "../agent/team"

export const Parameters = Schema.Struct({
  target: Schema.optional(Schema.String).annotate({ description: "A canonical or relative local collaboration path." }),
  to: Schema.optional(Schema.String).annotate({ description: "A local collaboration path or legacy teammate name." }),
  recipients: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "One or more canonical local collaboration paths.",
  }),
  message: Schema.String.check(Schema.isMaxLength(MAX_MAILBOX_PAYLOAD_CHARS)).annotate({
    description: `The message to send (maximum ${MAX_MAILBOX_PAYLOAD_CHARS.toLocaleString()} characters)`,
  }),
})

type SendMessageMetadata = { team?: string; from?: string; to?: string; id?: string; task_paths?: string[] }

export const SendMessageTool = Tool.define<
  typeof Parameters,
  SendMessageMetadata,
  Team.Service | Collaboration.Service
>(
  "send_message",
  Effect.gen(function* () {
    const team = yield* Team.Service
    const collaboration = yield* Collaboration.Service
    return {
      description:
        DESCRIPTION +
        "\n\nFor local collaboration agents, use target (or to) with a canonical path from list_agents. Messages are queued only; sending never starts a target turn.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const targets = Array.from(
            new Set(params.recipients ?? (params.target ? [params.target] : params.to ? [params.to] : [])),
          )
          if (targets.length === 0)
            return yield* Effect.fail(new Error("send_message requires target, to, or recipients"))
          const resolved = yield* Effect.forEach(targets, (target) =>
            collaboration.resolve({ sessionID: ctx.sessionID, target }),
          )
          if (!params.recipients && !params.target && params.to && !resolved[0]) {
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
          }
          const recipients = new Map<string, { target: string; recipient: NonNullable<(typeof resolved)[number]> }>()
          const unknown: Array<{ target: string; error: string }> = []
          for (const [index, target] of targets.entries()) {
            const recipient = resolved[index]
            if (!recipient) {
              unknown.push({ target, error: `Unknown collaboration target: ${target}` })
              continue
            }
            if (!recipients.has(recipient.sessionID)) recipients.set(recipient.sessionID, { target, recipient })
          }
          const outcomes: Array<{ target: string; path: string } | { target: string; error: string }> = [
            ...unknown,
            ...(yield* Effect.forEach(Array.from(recipients.values()), ({ target, recipient }) => {
              return collaboration
                .send({
                  sessionID: ctx.sessionID,
                  target: recipient.path,
                  kind: "MESSAGE",
                  content: params.message,
                  triggerTurn: false,
                })
                .pipe(
                  Effect.map((message) =>
                    message
                      ? { target, path: recipient.path }
                      : { target, error: `Unknown collaboration target: ${target}` },
                  ),
                  Effect.catch((error) =>
                    Effect.succeed({
                      target,
                      error: error._tag === "CollaborationMailboxPersistenceError" ? error.message : error._tag,
                    }),
                  ),
                )
            })),
          ]
          const delivered = outcomes.filter((outcome): outcome is { target: string; path: string } => "path" in outcome)
          const failed = outcomes.filter((outcome): outcome is { target: string; error: string } => "error" in outcome)
          if (delivered.length === 0) {
            return yield* Effect.fail(
              new Error(
                `Unable to queue message. ${failed.map((outcome) => `${outcome.target}: ${outcome.error}`).join("; ")}`,
              ),
            )
          }
          return {
            title: `to ${delivered.length} agent${delivered.length === 1 ? "" : "s"}`,
            metadata: { task_paths: delivered.map((outcome) => outcome.path) },
            output: [
              ...delivered.map((outcome) => `${outcome.path}: queued`),
              ...failed.map((outcome) => `${outcome.target}: failed (${outcome.error})`),
              ...(failed.length ? ["Retry only the failed targets."] : []),
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, SendMessageMetadata>
  }),
)
