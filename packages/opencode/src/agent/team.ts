import { Context, Effect, Layer } from "effect"
import { SessionID } from "@/session/schema"

/**
 * Coordination state for "agent teams": a group of named subagents (a lead plus
 * teammates) that share a task list and can message each other.
 *
 * This is the in-process backbone. The lead spawns teammates via the `task` tool
 * with `team`/`name`, which registers them in the roster. Teammates coordinate
 * with three tools — `send_message`, `inbox`, `team_tasks` — all of which resolve
 * "who am I" from their session id and operate on their team's shared state.
 *
 * State lives in this layer's closure so every session in the instance shares one
 * copy (teammates run as sibling sessions in the same instance). Delivery is
 * pull-based: messages queue in the recipient's mailbox and are read via `inbox`.
 */
export type TaskStatus = "pending" | "in_progress" | "done" | "blocked"

export interface Task {
  readonly id: string
  title: string
  status: TaskStatus
  assignee?: string
  notes?: string
  readonly created_at: number
}

export interface Message {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly message: string
  readonly time: number
}

export interface Member {
  readonly team: string
  readonly name: string
  readonly sessionID: SessionID
}

export interface Interface {
  readonly register: (input: { team: string; name: string; sessionID: SessionID }) => Effect.Effect<Member>
  readonly whoami: (sessionID: SessionID) => Effect.Effect<Member | undefined>
  readonly roster: (team: string) => Effect.Effect<Member[]>
  readonly send: (input: { team: string; from: string; to: string; message: string }) => Effect.Effect<Message>
  readonly inbox: (input: { team: string; recipient: string; drain?: boolean }) => Effect.Effect<Message[]>
  readonly taskCreate: (input: {
    team: string
    title: string
    assignee?: string
    notes?: string
  }) => Effect.Effect<Task>
  readonly taskList: (team: string) => Effect.Effect<Task[]>
  readonly taskUpdate: (input: {
    team: string
    id: string
    status?: TaskStatus
    assignee?: string
    notes?: string
  }) => Effect.Effect<Task | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Team") {}

type State = {
  roster: Member[]
  tasks: Task[]
  mailbox: Message[]
}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const teams = new Map<string, State>()
    const bySession = new Map<string, Member>()
    let counter = 0
    const nextID = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}`
    const state = (team: string) => {
      const existing = teams.get(team)
      if (existing) return existing
      const created: State = { roster: [], tasks: [], mailbox: [] }
      teams.set(team, created)
      return created
    }

    return Service.of({
      register: (input) =>
        Effect.sync(() => {
          const member: Member = { team: input.team, name: input.name, sessionID: input.sessionID }
          const team = state(input.team)
          // A name is unique within a team; re-registering updates the binding.
          team.roster = team.roster.filter((m) => m.name !== input.name && m.sessionID !== input.sessionID)
          team.roster.push(member)
          bySession.set(input.sessionID, member)
          return member
        }),
      whoami: (sessionID) => Effect.sync(() => bySession.get(sessionID)),
      roster: (team) => Effect.sync(() => [...state(team).roster]),
      send: (input) =>
        Effect.sync(() => {
          const message: Message = {
            id: nextID("msg"),
            from: input.from,
            to: input.to,
            message: input.message,
            time: Date.now(),
          }
          state(input.team).mailbox.push(message)
          return message
        }),
      inbox: (input) =>
        Effect.sync(() => {
          const team = state(input.team)
          const mine = team.mailbox.filter((m) => m.to === input.recipient)
          if (input.drain) team.mailbox = team.mailbox.filter((m) => m.to !== input.recipient)
          return mine
        }),
      taskCreate: (input) =>
        Effect.sync(() => {
          const task: Task = {
            id: nextID("tsk"),
            title: input.title,
            status: "pending",
            ...(input.assignee ? { assignee: input.assignee } : {}),
            ...(input.notes ? { notes: input.notes } : {}),
            created_at: Date.now(),
          }
          state(input.team).tasks.push(task)
          return task
        }),
      taskList: (team) => Effect.sync(() => [...state(team).tasks]),
      taskUpdate: (input) =>
        Effect.sync(() => {
          const task = state(input.team).tasks.find((t) => t.id === input.id)
          if (!task) return undefined
          if (input.status) task.status = input.status
          if (input.assignee !== undefined) task.assignee = input.assignee
          if (input.notes !== undefined) task.notes = input.notes
          return task
        }),
    })
  }),
)

export const defaultLayer = layer

export * as Team from "./team"
