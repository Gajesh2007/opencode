import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Team } from "@/agent/team"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(Team.defaultLayer)

describe("agent.team", () => {
  it.effect("registers members and resolves identity by session", () =>
    Effect.gen(function* () {
      const team = yield* Team.Service
      const lead = SessionID.make("ses_lead1")
      const worker = SessionID.make("ses_work1")
      yield* team.register({ team: "rosters", name: "lead", sessionID: lead })
      yield* team.register({ team: "rosters", name: "scanner", sessionID: worker })

      expect((yield* team.whoami(worker))?.name).toBe("scanner")
      expect((yield* team.whoami(lead))?.name).toBe("lead")
      const roster = yield* team.roster("rosters")
      expect(roster.map((m) => m.name).sort()).toEqual(["lead", "scanner"])
    }),
  )

  it.effect("delivers mailbox messages to the recipient and drains them", () =>
    Effect.gen(function* () {
      const team = yield* Team.Service
      yield* team.send({ team: "mail", from: "scanner", to: "lead", message: "found a bug" })
      yield* team.send({ team: "mail", from: "fixer", to: "lead", message: "patched it" })
      yield* team.send({ team: "mail", from: "lead", to: "scanner", message: "thanks" })

      // peek leaves messages in place
      expect((yield* team.inbox({ team: "mail", recipient: "lead", drain: false })).length).toBe(2)
      // a read drains only this recipient's messages
      const read = yield* team.inbox({ team: "mail", recipient: "lead", drain: true })
      expect(read.map((m) => m.from).sort()).toEqual(["fixer", "scanner"])
      expect((yield* team.inbox({ team: "mail", recipient: "lead", drain: true })).length).toBe(0)
      // other recipients are unaffected
      expect((yield* team.inbox({ team: "mail", recipient: "scanner", drain: true })).length).toBe(1)
    }),
  )

  it.effect("shares one task list across the team", () =>
    Effect.gen(function* () {
      const team = yield* Team.Service
      const task = yield* team.taskCreate({ team: "tasks", title: "review auth", assignee: "scanner" })
      expect(task.status).toBe("pending")
      const updated = yield* team.taskUpdate({ team: "tasks", id: task.id, status: "done" })
      expect(updated?.status).toBe("done")
      const list = yield* team.taskList("tasks")
      expect(list.length).toBe(1)
      expect(list[0]!.status).toBe("done")
      expect(list[0]!.assignee).toBe("scanner")
      expect(yield* team.taskUpdate({ team: "tasks", id: "nope", status: "done" })).toBeUndefined()
    }),
  )
})
