import { InstanceState } from "@/effect/instance-state"
import { Bus } from "@/bus"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Context, Deferred, Effect, Layer, Option, Semaphore } from "effect"
import * as Stream from "effect/Stream"

export const DEFAULT_MAX_CONCURRENT_THREADS = 4

export type Status = "pending" | "running" | "completed" | "errored" | "interrupted"
export type MessageKind = "NEW_TASK" | "MESSAGE" | "FINAL_ANSWER"
export type WaitResult = "activity" | "timeout"

export type Member = {
  readonly sessionID: SessionID
  readonly rootSessionID: SessionID
  readonly parentSessionID?: SessionID
  readonly path: string
  readonly taskName: string
  readonly status: Status
  readonly lastTask?: string
  readonly result?: string
  readonly error?: string
}

export type Message = {
  readonly id: string
  readonly senderSessionID: SessionID
  readonly recipientSessionID: SessionID
  readonly senderPath: string
  readonly recipientPath: string
  readonly kind: MessageKind
  readonly content: string
  readonly triggerTurn: boolean
  readonly time: number
  /** IDs of the ignored synthetic part that keeps this mail durable. */
  readonly messageID?: MessageID
  readonly partID?: PartID
}

export const MAX_MAILBOX_MESSAGES = 16
/** Largest ordinary cross-agent instruction accepted by the mailbox. */
export const MAX_MAILBOX_PAYLOAD_CHARS = 20_000
export const MAX_MAILBOX_PROMPT_CHARS = 24_000

function truncateMailboxField(value: string, maximum: number) {
  if (value.length <= maximum) return value
  return value.slice(0, maximum - 3) + "..."
}

function formatMailboxMessage(message: Message) {
  const recipient = truncateMailboxField(message.recipientPath, 180)
  const taskName = truncateMailboxField(message.recipientPath.split("/").filter(Boolean).at(-1) ?? "root", 96)
  const content = truncateMailboxField(message.content, MAX_MAILBOX_PAYLOAD_CHARS)
  return [
    "<collaboration_mail>",
    `Message Type: ${message.kind}`,
    `Task name/recipient: ${taskName} (${recipient})`,
    `Recipient session: ${truncateMailboxField(message.recipientSessionID, 256)}`,
    `Sender: ${truncateMailboxField(message.senderPath, 256)} (session: ${truncateMailboxField(message.senderSessionID, 256)})`,
    "Payload:",
    content,
    ...(content !== message.content && message.kind === "FINAL_ANSWER"
      ? [
          `Payload truncated. Read the full sender context in session ${truncateMailboxField(message.senderSessionID, 256)}.`,
        ]
      : []),
    "</collaboration_mail>",
  ].join("\n")
}

function mailboxBatch(messages: ReadonlyArray<Message>) {
  const selected: Message[] = []
  const wrapperLength =
    "<collaboration_mailbox>\nThe following messages were delivered by collaboration agents:\n\n</collaboration_mailbox>"
      .length
  // Reserve space for the explicit remainder notice before choosing records to drain.
  let length = wrapperLength + "999999999999999999 additional message(s) remain queued for delivery.".length
  for (const message of messages) {
    if (selected.length === MAX_MAILBOX_MESSAGES) break
    const next = formatMailboxMessage(message).length + 1
    if (selected.length > 0 && length + next > MAX_MAILBOX_PROMPT_CHARS) break
    selected.push(message)
    length += next
  }
  return selected
}

/** Formats a bounded, model-visible batch after the mailbox has been drained. */
export function formatMailbox(messages: ReadonlyArray<Message>) {
  const included = mailboxBatch(messages)
  return [
    "<collaboration_mailbox>",
    "The following messages were delivered by collaboration agents:",
    "",
    ...included.flatMap((message) => [formatMailboxMessage(message), ""]),
    ...(messages.length > included.length
      ? [`${messages.length - included.length} additional message(s) remain queued for delivery.`]
      : []),
    "</collaboration_mailbox>",
  ].join("\n")
}

export type RegistrationError =
  | { readonly _tag: "CollaborationInvalidTaskName"; readonly taskName: string }
  | {
      readonly _tag: "CollaborationDuplicateSiblingTaskName"
      readonly parentSessionID: SessionID
      readonly taskName: string
    }
  | { readonly _tag: "CollaborationParentNotRegistered"; readonly parentSessionID: SessionID }
  | { readonly _tag: "CollaborationSessionAlreadyRegistered"; readonly sessionID: SessionID }

export type MemberNotRegistered = {
  readonly _tag: "CollaborationMemberNotRegistered"
  readonly sessionID: SessionID
}

export type MailboxPersistenceError = {
  readonly _tag: "CollaborationMailboxPersistenceError"
  readonly recipientSessionID: SessionID
  readonly message: string
}

export type MailboxPayloadTooLarge = {
  readonly _tag: "CollaborationMailboxPayloadTooLarge"
  readonly maximum: number
  readonly received: number
}

export type FollowupClaim = {
  readonly member: Member
  readonly previousStatus: Status
  readonly previousLastTask?: string
}

export interface Interface {
  /** Restores a persisted collaboration tree when this process has no live registration for it. */
  readonly ensure: (sessionID: SessionID) => Effect.Effect<Member | undefined>
  readonly registerRoot: (sessionID: SessionID) => Effect.Effect<Member, RegistrationError>
  readonly registerChild: (input: {
    parentSessionID: SessionID
    sessionID: SessionID
    taskName: string
    lastTask?: string
  }) => Effect.Effect<Member, RegistrationError>
  readonly member: (sessionID: SessionID) => Effect.Effect<Member | undefined>
  /** Resolves a `/root/...` path or a path relative to `sessionID`. */
  readonly resolve: (input: { sessionID: SessionID; target: string }) => Effect.Effect<Member | undefined>
  readonly list: (sessionID: SessionID, pathPrefix?: string) => Effect.Effect<ReadonlyArray<Member>>
  readonly setStatus: (input: {
    sessionID: SessionID
    status: Status
    lastTask?: string
    result?: string
    error?: string
  }) => Effect.Effect<Member, MemberNotRegistered>
  /** Atomically marks a non-running child as running before a follow-up starts. */
  readonly claimFollowup: (input: {
    sessionID: SessionID
    lastTask: string
  }) => Effect.Effect<FollowupClaim | undefined, MemberNotRegistered>
  readonly complete: (input: {
    sessionID: SessionID
    result?: string
    error?: string
  }) => Effect.Effect<Member, MemberNotRegistered | MailboxPersistenceError>
  readonly send: (input: {
    sessionID: SessionID
    target: string
    kind: MessageKind
    content: string
    triggerTurn: boolean
  }) => Effect.Effect<Message | undefined, MemberNotRegistered | MailboxPersistenceError | MailboxPayloadTooLarge>
  readonly inbox: (input: {
    sessionID: SessionID
    drain?: boolean
  }) => Effect.Effect<ReadonlyArray<Message>, MemberNotRegistered>
  /** Atomically claims one bounded mailbox batch for tool delivery. */
  readonly claimInbox: (input: { sessionID: SessionID }) => Effect.Effect<ReadonlyArray<Message>, MemberNotRegistered>
  /** Returns claimed but unacknowledged mail to the front of the mailbox. */
  readonly releaseClaimedInbox: (input: {
    sessionID: SessionID
    messages: ReadonlyArray<Message>
  }) => Effect.Effect<void, MemberNotRegistered>
  /** Makes one bounded durable mailbox batch visible to the next model request. */
  readonly deliver: (input: {
    sessionID: SessionID
  }) => Effect.Effect<ReadonlyArray<Message>, MemberNotRegistered | MailboxPersistenceError>
  /** Removes durable placeholders after mail has been returned by a tool result. */
  readonly acknowledge: (input: {
    sessionID: SessionID
    messages: ReadonlyArray<Message>
  }) => Effect.Effect<ReadonlyArray<Message>, MemberNotRegistered | MailboxPersistenceError>
  /** Returns false for sessions outside a collaboration tree. */
  readonly hasMail: (sessionID: SessionID) => Effect.Effect<boolean>
  readonly wait: (input: { sessionID: SessionID; timeout: number }) => Effect.Effect<WaitResult, MemberNotRegistered>
  readonly withChildPermit: <A, E, R>(
    sessionID: SessionID,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | MemberNotRegistered, R>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Collaboration") {}

type Entry = Omit<Member, "status" | "lastTask" | "result" | "error"> & {
  status: Status
  lastTask?: string
  result?: string
  error?: string
  mailbox: Message[]
  delivering: Set<string>
  signal: Deferred.Deferred<void>
}

type Root = {
  members: Map<SessionID, Entry>
  permits: Semaphore.Semaphore
}

type State = {
  roots: Map<SessionID, Root>
  rootBySession: Map<SessionID, SessionID>
}

function createEntry(input: Member): Entry {
  return {
    ...input,
    mailbox: [],
    delivering: new Set(),
    signal: Deferred.makeUnsafe<void>(),
  }
}

function snapshot(entry: Entry): Member {
  return {
    sessionID: entry.sessionID,
    rootSessionID: entry.rootSessionID,
    ...(entry.parentSessionID ? { parentSessionID: entry.parentSessionID } : {}),
    path: entry.path,
    taskName: entry.taskName,
    status: entry.status,
    ...(entry.lastTask !== undefined ? { lastTask: entry.lastTask } : {}),
    ...(entry.result !== undefined ? { result: entry.result } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
  }
}

function locate(state: State, sessionID: SessionID) {
  const rootSessionID = state.rootBySession.get(sessionID)
  if (!rootSessionID) return
  const root = state.roots.get(rootSessionID)
  const member = root?.members.get(sessionID)
  if (!root || !member) return
  return { root, member }
}

function removeFromState(state: State, sessionID: SessionID) {
  const found = locate(state, sessionID)
  if (!found) return
  if (found.member.parentSessionID === undefined) {
    state.roots.delete(found.member.rootSessionID)
    for (const member of found.root.members.values()) state.rootBySession.delete(member.sessionID)
    return
  }
  const removed = Array.from(found.root.members.values()).filter((member) => isWithin(member.path, found.member.path))
  for (const member of removed) {
    found.root.members.delete(member.sessionID)
    state.rootBySession.delete(member.sessionID)
  }
}

function rotate(member: Entry) {
  const signal = member.signal
  member.signal = Deferred.makeUnsafe<void>()
  return signal
}

function isWithin(path: string, prefix: string) {
  return path === prefix || path.startsWith(`${prefix}/`)
}

/** Resolves a target without consulting membership state. `undefined` cannot escape `/root`. */
export function resolvePath(from: string, target: string) {
  const parts = (target.startsWith("/") ? target : `${from}/${target}`).split("/")
  const resolved: string[] = []
  for (const part of parts) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (resolved.length <= 1) return
      resolved.pop()
      continue
    }
    resolved.push(part)
  }
  if (resolved[0] !== "root") return
  return `/${resolved.join("/")}`
}

function invalidTaskName(taskName: string): RegistrationError {
  return { _tag: "CollaborationInvalidTaskName", taskName }
}

function sessionAlreadyRegistered(sessionID: SessionID): RegistrationError {
  return { _tag: "CollaborationSessionAlreadyRegistered", sessionID }
}

function memberNotRegistered(sessionID: SessionID): MemberNotRegistered {
  return { _tag: "CollaborationMemberNotRegistered", sessionID }
}

function mailboxPersistenceError(recipientSessionID: SessionID, message: string): MailboxPersistenceError {
  return { _tag: "CollaborationMailboxPersistenceError", recipientSessionID, message }
}

function mailboxPayloadTooLarge(content: string): MailboxPayloadTooLarge {
  return {
    _tag: "CollaborationMailboxPayloadTooLarge",
    maximum: MAX_MAILBOX_PAYLOAD_CHARS,
    received: content.length,
  }
}

function pendingMessage(message: MessageV2.WithParts, part: MessageV2.Part): Message | undefined {
  if (part.type !== "text" || part.ignored !== true) return
  const metadata = part.metadata?.collaboration
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return
  const mail = metadata as Record<string, unknown>
  if (
    mail.pending !== true ||
    typeof mail.mailID !== "string" ||
    typeof mail.senderSessionID !== "string" ||
    typeof mail.recipientSessionID !== "string" ||
    typeof mail.senderPath !== "string" ||
    typeof mail.recipientPath !== "string" ||
    typeof mail.content !== "string" ||
    typeof mail.triggerTurn !== "boolean" ||
    typeof mail.time !== "number" ||
    !Number.isFinite(mail.time) ||
    !["NEW_TASK", "MESSAGE", "FINAL_ANSWER"].includes(String(mail.kind))
  ) {
    return
  }
  return {
    id: mail.mailID,
    senderSessionID: SessionID.make(mail.senderSessionID),
    recipientSessionID: SessionID.make(mail.recipientSessionID),
    senderPath: mail.senderPath,
    recipientPath: mail.recipientPath,
    kind: mail.kind as MessageKind,
    content: mail.content,
    triggerTurn: mail.triggerTurn,
    time: mail.time,
    messageID: message.info.id,
    partID: part.id,
  }
}

function taskNameFromTitle(title: string) {
  return title.match(/^\[agent\] ([a-z0-9_]+)$/)?.[1]
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const sessions = yield* Session.Service
    const states = yield* InstanceState.make<State>(
      Effect.fn("Collaboration.state")(function* () {
        const state = { roots: new Map<SessionID, Root>(), rootBySession: new Map<SessionID, SessionID>() }
        yield* (yield* bus.subscribe(Session.Event.Deleted)).pipe(
          Stream.runForEach((event) => Effect.sync(() => removeFromState(state, event.properties.sessionID))),
          Effect.forkScoped,
        )
        return state
      }),
    )

    const statusOf = Effect.fn("Collaboration.statusOf")(function* (sessionID: SessionID) {
      const latest = (yield* sessions
        .messages({ sessionID })
        .pipe(Effect.catchCause(() => Effect.succeed([])))).findLast((message) => message.info.role === "assistant")
      if (!latest || latest.info.role !== "assistant") return "pending" as const
      if (latest.info.error?.name === "MessageAbortedError") return "interrupted" as const
      if (latest.info.error) return "errored" as const
      if (latest.info.time.completed !== undefined) return "completed" as const
      return "interrupted" as const
    })

    const hydrateChildren = (state: State, root: Root, parent: Entry, visited: Set<SessionID>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const children = (yield* sessions.children(parent.sessionID))
          .flatMap((session) => {
            const taskName = taskNameFromTitle(session.title)
            return taskName ? [{ session, taskName }] : []
          })
          .toSorted(
            (a, b) => a.session.time.created - b.session.time.created || a.session.id.localeCompare(b.session.id),
          )
          .map((child, _, all) => {
            const duplicate = all.slice(0, _).filter((item) => item.taskName === child.taskName).length
            return { ...child, pathName: duplicate === 0 ? child.taskName : `${child.taskName}~${duplicate + 1}` }
          })

        for (const child of children) {
          if (visited.has(child.session.id)) continue
          visited.add(child.session.id)
          const existingRoot = state.rootBySession.get(child.session.id)
          if (existingRoot && existingRoot !== parent.rootSessionID) continue

          const existing = root.members.get(child.session.id)
          const member =
            existing ??
            createEntry({
              sessionID: child.session.id,
              rootSessionID: parent.rootSessionID,
              parentSessionID: parent.sessionID,
              path: `${parent.path}/${child.pathName}`,
              taskName: child.taskName,
              status: yield* statusOf(child.session.id),
            })
          if (!existing) {
            root.members.set(member.sessionID, member)
            state.rootBySession.set(member.sessionID, member.rootSessionID)
          }
          yield* hydrateChildren(state, root, member, visited)
        }
      })

    const ensure = Effect.fn("Collaboration.ensure")(function* (sessionID: SessionID) {
      const state = yield* InstanceState.get(states)
      const current = locate(state, sessionID)?.member
      if (current) return snapshot(current)

      const session = yield* sessions.get(sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (!session) return

      const visited = new Set<SessionID>([session.id])
      let rootSession = session
      while (rootSession.parentID && !visited.has(rootSession.parentID)) {
        visited.add(rootSession.parentID)
        const parent = yield* sessions
          .get(rootSession.parentID)
          .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (!parent) break
        rootSession = parent
      }

      const rootChildren = yield* sessions.children(rootSession.id)
      if (!taskNameFromTitle(session.title) && !rootChildren.some((child) => taskNameFromTitle(child.title))) return

      const existing = state.roots.get(rootSession.id)
      const root =
        existing ??
        (() => {
          const member = createEntry({
            sessionID: rootSession.id,
            rootSessionID: rootSession.id,
            path: "/root",
            taskName: "root",
            status: "pending",
          })
          return {
            members: new Map<SessionID, Entry>([[member.sessionID, member]]),
            permits: Semaphore.makeUnsafe(DEFAULT_MAX_CONCURRENT_THREADS - 1),
          }
        })()
      if (!existing) {
        root.members.get(rootSession.id)!.status = yield* statusOf(rootSession.id)
        state.roots.set(rootSession.id, root)
        state.rootBySession.set(rootSession.id, rootSession.id)
      }
      const rootMember = root.members.get(rootSession.id)
      if (!rootMember) return
      yield* hydrateChildren(state, root, rootMember, new Set<SessionID>([rootSession.id]))
      yield* hydrateMailbox(root)
      const restored = locate(state, sessionID)?.member
      return restored ? snapshot(restored) : undefined
    })

    const persistMailboxMessage = Effect.fn("Collaboration.persistMailboxMessage")(function* (message: Message) {
      const latest = yield* sessions
        .findMessage(message.recipientSessionID, (item) => item.info.role === "user")
        .pipe(
          Effect.catchCause(() =>
            Effect.fail(
              mailboxPersistenceError(message.recipientSessionID, "Unable to load the collaboration mail recipient."),
            ),
          ),
        )
      const settings =
        Option.isSome(latest) && latest.value.info.role === "user"
          ? { agent: latest.value.info.agent, model: latest.value.info.model }
          : yield* sessions.get(message.recipientSessionID).pipe(
              Effect.catchCause(() =>
                Effect.fail(
                  mailboxPersistenceError(
                    message.recipientSessionID,
                    "Unable to load the collaboration mail recipient.",
                  ),
                ),
              ),
              Effect.flatMap((recipient) => {
                if (!recipient.agent || !recipient.model) {
                  return Effect.fail(
                    mailboxPersistenceError(message.recipientSessionID, "agent not ready for messages"),
                  )
                }
                return Effect.succeed({
                  agent: recipient.agent,
                  model: {
                    providerID: recipient.model.providerID,
                    modelID: recipient.model.id,
                    variant: recipient.model.variant,
                  },
                })
              }),
            )
      const user: MessageV2.User = {
        id: MessageID.ascending(),
        sessionID: message.recipientSessionID,
        role: "user",
        time: { created: message.time },
        agent: settings.agent,
        model: settings.model,
      }
      const part: MessageV2.TextPart = {
        id: PartID.ascending(),
        messageID: user.id,
        sessionID: message.recipientSessionID,
        type: "text",
        synthetic: true,
        ignored: true,
        text: formatMailboxMessage(message),
        metadata: {
          collaboration: {
            pending: true,
            mailID: message.id,
            senderSessionID: message.senderSessionID,
            recipientSessionID: message.recipientSessionID,
            senderPath: message.senderPath,
            recipientPath: message.recipientPath,
            kind: message.kind,
            content: message.content,
            triggerTurn: message.triggerTurn,
            time: message.time,
          },
        },
      }
      yield* sessions
        .appendMessageWithPart(user, part)
        .pipe(
          Effect.catchCause(() =>
            Effect.fail(
              mailboxPersistenceError(
                message.recipientSessionID,
                "Unable to persist the collaboration mail placeholder.",
              ),
            ),
          ),
        )
      return { ...message, messageID: user.id, partID: part.id }
    })

    const hydrateMailbox = Effect.fn("Collaboration.hydrateMailbox")(function* (root: Root) {
      yield* Effect.forEach(
        Array.from(root.members.values()),
        (member) =>
          sessions.messages({ sessionID: member.sessionID }).pipe(
            Effect.catchCause(() => Effect.succeed([])),
            Effect.tap((history) =>
              Effect.sync(() => {
                const restored = history
                  .flatMap((message) => message.parts.map((part) => pendingMessage(message, part)))
                  .filter((message): message is Message => message !== undefined)
                  .filter((message) => message.recipientSessionID === member.sessionID)
                for (const message of restored) {
                  if (!member.mailbox.some((existing) => existing.id === message.id)) member.mailbox.push(message)
                }
              }),
            ),
          ),
        { discard: true },
      )
    })

    const remove = Effect.fn("Collaboration.remove")(function* (sessionID: SessionID) {
      removeFromState(yield* InstanceState.get(states), sessionID)
    })

    const releaseClaimedInbox = Effect.fn("Collaboration.releaseClaimedInbox")(function* (input: {
      sessionID: SessionID
      messages: ReadonlyArray<Message>
    }) {
      yield* ensure(input.sessionID)
      const state = yield* InstanceState.get(states)
      const found = locate(state, input.sessionID)
      if (!found) return yield* Effect.fail(memberNotRegistered(input.sessionID))
      yield* Effect.sync(() => {
        for (const message of input.messages) found.member.delivering.delete(message.id)
      })
    })

    return Service.of({
      ensure,
      registerRoot: (sessionID) =>
        Effect.gen(function* () {
          const state = yield* InstanceState.get(states)
          const registeredRoot = state.rootBySession.get(sessionID)
          if (registeredRoot === sessionID) {
            const root = state.roots.get(sessionID)
            const member = root?.members.get(sessionID)
            if (member) return snapshot(member)
          }
          if (registeredRoot) return yield* Effect.fail(sessionAlreadyRegistered(sessionID))

          const root: Root = {
            members: new Map(),
            // The root owns one of the four total threads; child turns share the other three.
            permits: Semaphore.makeUnsafe(DEFAULT_MAX_CONCURRENT_THREADS - 1),
          }
          const member = createEntry({
            sessionID,
            rootSessionID: sessionID,
            path: "/root",
            taskName: "root",
            status: "running",
          })
          root.members.set(sessionID, member)
          state.roots.set(sessionID, root)
          state.rootBySession.set(sessionID, sessionID)
          return snapshot(member)
        }),
      registerChild: (input) =>
        Effect.gen(function* () {
          if (!/^[a-z0-9_]+$/.test(input.taskName)) return yield* Effect.fail(invalidTaskName(input.taskName))

          const state = yield* InstanceState.get(states)
          const parent = locate(state, input.parentSessionID)
          if (!parent) {
            return yield* Effect.fail({
              _tag: "CollaborationParentNotRegistered",
              parentSessionID: input.parentSessionID,
            } as const)
          }
          if (state.rootBySession.has(input.sessionID))
            return yield* Effect.fail(sessionAlreadyRegistered(input.sessionID))
          if (
            Array.from(parent.root.members.values()).some(
              (member) => member.parentSessionID === input.parentSessionID && member.taskName === input.taskName,
            )
          ) {
            return yield* Effect.fail({
              _tag: "CollaborationDuplicateSiblingTaskName",
              parentSessionID: input.parentSessionID,
              taskName: input.taskName,
            } as const)
          }

          const member = createEntry({
            sessionID: input.sessionID,
            rootSessionID: parent.member.rootSessionID,
            parentSessionID: input.parentSessionID,
            path: `${parent.member.path}/${input.taskName}`,
            taskName: input.taskName,
            status: "pending",
            ...(input.lastTask !== undefined ? { lastTask: input.lastTask } : {}),
          })
          parent.root.members.set(input.sessionID, member)
          state.rootBySession.set(input.sessionID, parent.member.rootSessionID)
          return snapshot(member)
        }),
      member: (sessionID) => ensure(sessionID),
      resolve: (input) =>
        Effect.gen(function* () {
          const restored = yield* ensure(input.sessionID)
          if (!restored) return
          const state = yield* InstanceState.get(states)
          const caller = locate(state, input.sessionID)
          const path = caller && resolvePath(caller.member.path, input.target)
          if (!caller || !path) return
          const target = Array.from(caller.root.members.values()).find((member) => member.path === path)
          return target ? snapshot(target) : undefined
        }),
      list: (sessionID, pathPrefix) =>
        Effect.gen(function* () {
          const restored = yield* ensure(sessionID)
          if (!restored) return []
          const state = yield* InstanceState.get(states)
          const caller = locate(state, sessionID)
          const prefix = pathPrefix === undefined ? "/root" : caller && resolvePath(caller.member.path, pathPrefix)
          if (!caller || !prefix) return []
          return Array.from(caller.root.members.values())
            .filter((member) => isWithin(member.path, prefix))
            .map(snapshot)
            .toSorted((a, b) => a.path.localeCompare(b.path))
        }),
      setStatus: (input) =>
        Effect.gen(function* () {
          yield* ensure(input.sessionID)
          const state = yield* InstanceState.get(states)
          const found = locate(state, input.sessionID)
          if (!found) return yield* Effect.fail(memberNotRegistered(input.sessionID))
          found.member.status = input.status
          if ("lastTask" in input) found.member.lastTask = input.lastTask
          if ("result" in input) found.member.result = input.result
          if ("error" in input) found.member.error = input.error
          return snapshot(found.member)
        }),
      claimFollowup: (input) =>
        Effect.gen(function* () {
          yield* ensure(input.sessionID)
          const state = yield* InstanceState.get(states)
          const found = locate(state, input.sessionID)
          if (!found) return yield* Effect.fail(memberNotRegistered(input.sessionID))
          if (found.member.status === "running") return
          const claim: FollowupClaim = {
            member: snapshot(found.member),
            previousStatus: found.member.status,
            ...(found.member.lastTask !== undefined ? { previousLastTask: found.member.lastTask } : {}),
          }
          found.member.status = "running"
          found.member.lastTask = input.lastTask
          return claim
        }),
      complete: (input) =>
        Effect.gen(function* () {
          yield* ensure(input.sessionID)
          const state = yield* InstanceState.get(states)
          const found = locate(state, input.sessionID)
          if (!found) return yield* Effect.fail(memberNotRegistered(input.sessionID))

          if (["completed", "errored", "interrupted"].includes(found.member.status)) return snapshot(found.member)
          const parent = found.member.parentSessionID ? found.root.members.get(found.member.parentSessionID) : undefined
          if (parent) {
            const message = yield* persistMailboxMessage({
              id: PartID.ascending(),
              senderSessionID: found.member.sessionID,
              recipientSessionID: parent.sessionID,
              senderPath: found.member.path,
              recipientPath: parent.path,
              kind: "FINAL_ANSWER",
              content: ["<FINAL_ANSWER>", input.error ?? input.result ?? "", "</FINAL_ANSWER>"].join("\n"),
              triggerTurn: false,
              time: Date.now(),
            })
            parent.mailbox.push(message)
            yield* Deferred.succeed(rotate(parent), undefined).pipe(Effect.ignore)
          }
          found.member.status = input.error === undefined ? "completed" : "errored"
          found.member.result = input.result
          found.member.error = input.error
          return snapshot(found.member)
        }),
      send: (input) =>
        Effect.gen(function* () {
          if (input.kind !== "FINAL_ANSWER" && input.content.length > MAX_MAILBOX_PAYLOAD_CHARS) {
            return yield* Effect.fail(mailboxPayloadTooLarge(input.content))
          }
          yield* ensure(input.sessionID)
          const state = yield* InstanceState.get(states)
          const sender = locate(state, input.sessionID)
          if (!sender) return yield* Effect.fail(memberNotRegistered(input.sessionID))
          const path = resolvePath(sender.member.path, input.target)
          const recipient = path && Array.from(sender.root.members.values()).find((member) => member.path === path)
          if (!recipient) return

          const message = yield* persistMailboxMessage({
            id: PartID.ascending(),
            senderSessionID: sender.member.sessionID,
            recipientSessionID: recipient.sessionID,
            senderPath: sender.member.path,
            recipientPath: recipient.path,
            kind: input.kind,
            content: input.content,
            triggerTurn: input.triggerTurn,
            time: Date.now(),
          })
          recipient.mailbox.push(message)
          yield* Deferred.succeed(rotate(recipient), undefined).pipe(Effect.ignore)
          return message
        }),
      inbox: (input) =>
        Effect.gen(function* () {
          yield* ensure(input.sessionID)
          const state = yield* InstanceState.get(states)
          const found = locate(state, input.sessionID)
          if (!found) return yield* Effect.fail(memberNotRegistered(input.sessionID))
          const messages = mailboxBatch(
            found.member.mailbox.filter((message) => !found.member.delivering.has(message.id)),
          )
          if (input.drain) {
            const ids = new Set(messages.map((message) => message.id))
            found.member.mailbox = found.member.mailbox.filter((message) => !ids.has(message.id))
          }
          return messages
        }),
      claimInbox: (input) =>
        Effect.gen(function* () {
          yield* ensure(input.sessionID)
          const state = yield* InstanceState.get(states)
          const found = locate(state, input.sessionID)
          if (!found) return yield* Effect.fail(memberNotRegistered(input.sessionID))
          return yield* Effect.sync(() => {
            const messages = mailboxBatch(
              found.member.mailbox.filter((message) => !found.member.delivering.has(message.id)),
            )
            for (const message of messages) found.member.delivering.add(message.id)
            return messages
          })
        }),
      releaseClaimedInbox,
      deliver: (input) =>
        Effect.gen(function* () {
          yield* ensure(input.sessionID)
          const state = yield* InstanceState.get(states)
          const found = locate(state, input.sessionID)
          if (!found) return yield* Effect.fail(memberNotRegistered(input.sessionID))
          const messages = yield* Effect.sync(() => {
            const selected = mailboxBatch(
              found.member.mailbox.filter((message) => !found.member.delivering.has(message.id)),
            )
            for (const message of selected) found.member.delivering.add(message.id)
            return selected
          })
          yield* Effect.forEach(messages, (message) => {
            if (!message.messageID || !message.partID) {
              return Effect.fail(
                mailboxPersistenceError(input.sessionID, "Collaboration mail is missing its durable placeholder."),
              )
            }
            return sessions
              .getPart({ sessionID: input.sessionID, messageID: message.messageID, partID: message.partID })
              .pipe(
                Effect.catchCause(() =>
                  Effect.fail(
                    mailboxPersistenceError(input.sessionID, "Unable to load the collaboration mail placeholder."),
                  ),
                ),
                Effect.flatMap((part) => {
                  if (!part || part.type !== "text") {
                    return Effect.fail(
                      mailboxPersistenceError(
                        input.sessionID,
                        "Collaboration mail is missing its durable placeholder.",
                      ),
                    )
                  }
                  return sessions
                    .updatePart({ ...part, ignored: false })
                    .pipe(
                      Effect.catchCause(() =>
                        Effect.fail(
                          mailboxPersistenceError(
                            input.sessionID,
                            "Unable to deliver the collaboration mail placeholder.",
                          ),
                        ),
                      ),
                    )
                }),
              )
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                const ids = new Set(messages.map((message) => message.id))
                found.member.mailbox = found.member.mailbox.filter((message) => !ids.has(message.id))
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                for (const message of messages) found.member.delivering.delete(message.id)
              }),
            ),
          )
          return messages
        }),
      acknowledge: (input) =>
        Effect.gen(function* () {
          yield* ensure(input.sessionID)
          const state = yield* InstanceState.get(states)
          const found = locate(state, input.sessionID)
          if (!found) return yield* Effect.fail(memberNotRegistered(input.sessionID))
          const acknowledged: Message[] = []
          for (const message of input.messages) {
            const removed = yield* Effect.gen(function* () {
              if (!message.messageID || !message.partID) {
                return yield* Effect.fail(
                  mailboxPersistenceError(input.sessionID, "Collaboration mail is missing its durable placeholder."),
                )
              }
              const part = yield* sessions
                .getPart({ sessionID: input.sessionID, messageID: message.messageID, partID: message.partID })
                .pipe(
                  Effect.catchCause(() =>
                    Effect.fail(
                      mailboxPersistenceError(input.sessionID, "Unable to load the collaboration mail placeholder."),
                    ),
                  ),
                )
              if (!part || part.type !== "text") {
                return yield* Effect.fail(
                  mailboxPersistenceError(input.sessionID, "Collaboration mail is missing its durable placeholder."),
                )
              }
              yield* sessions
                .removeMessage({ sessionID: input.sessionID, messageID: message.messageID })
                .pipe(
                  Effect.catchCause(() =>
                    Effect.fail(
                      mailboxPersistenceError(
                        input.sessionID,
                        "Unable to acknowledge the collaboration mail placeholder message.",
                      ),
                    ),
                  ),
                )
            }).pipe(Effect.exit)
            if (removed._tag === "Success") {
              acknowledged.push(message)
              found.member.mailbox = found.member.mailbox.filter((item) => item.id !== message.id)
              continue
            }
            if (acknowledged.length > 0) return acknowledged
            return yield* Effect.fail(
              mailboxPersistenceError(input.sessionID, "No collaboration messages could be acknowledged."),
            )
          }
          return acknowledged
        }).pipe(Effect.ensuring(releaseClaimedInbox(input).pipe(Effect.orDie))),
      hasMail: (sessionID) =>
        Effect.gen(function* () {
          yield* ensure(sessionID)
          const state = yield* InstanceState.get(states)
          const member = locate(state, sessionID)?.member
          return member?.mailbox.some((message) => !member.delivering.has(message.id)) ?? false
        }),
      wait: (input) =>
        Effect.gen(function* () {
          yield* ensure(input.sessionID)
          const state = yield* InstanceState.get(states)
          const found = locate(state, input.sessionID)
          if (!found) return yield* Effect.fail(memberNotRegistered(input.sessionID))
          if (found.member.mailbox.some((message) => !found.member.delivering.has(message.id)))
            return "activity" as const
          const activity = yield* Deferred.await(found.member.signal).pipe(Effect.timeoutOption(input.timeout))
          return activity._tag === "Some" ? ("activity" as const) : ("timeout" as const)
        }),
      withChildPermit: (sessionID, effect) =>
        Effect.gen(function* () {
          yield* ensure(sessionID)
          const state = yield* InstanceState.get(states)
          const found = locate(state, sessionID)
          if (!found) return yield* Effect.fail(memberNotRegistered(sessionID))
          return yield* found.root.permits.withPermits(1)(effect)
        }),
      remove,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Session.defaultLayer), Layer.provide(Bus.defaultLayer))

export * as Collaboration from "./collaboration"
