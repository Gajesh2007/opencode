import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, Session, TextPart, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"
import { taskEntries } from "../../../../src/cli/cmd/tui/component/task-entries"

type Data = Parameters<typeof taskEntries>[0]

function session(id = "child", updated = 1): Session {
  return {
    id,
    slug: id,
    projectID: "project",
    parentID: "parent",
    directory: "/project",
    title: id,
    version: "1",
    time: { created: 1, updated },
  }
}

function user(created = 2): UserMessage {
  return {
    id: `user-${created}`,
    sessionID: "child",
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "provider", modelID: "model" },
  }
}

function assistant(input: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "assistant",
    sessionID: "child",
    role: "assistant",
    time: { created: 3, completed: 4 },
    parentID: "user-2",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/project", root: "/project" },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
    ...input,
  }
}

function tool(name: string, metadata: Record<string, unknown>, start = 2): ToolPart {
  return {
    id: `part-${name}-${start}`,
    sessionID: "parent",
    messageID: "parent-assistant",
    type: "tool",
    callID: `call-${name}-${start}`,
    tool: name,
    state: {
      status: "completed",
      input: {},
      title: name,
      output: "",
      metadata,
      time: { start, end: start + 1 },
    },
  }
}

function data(input: Partial<Data> = {}): Data {
  return {
    session: [session()],
    session_status: { child: { type: "idle" } },
    message: { child: [] },
    part: {},
    ...input,
  }
}

describe("task entries", () => {
  test("lists all children beyond fifty, with running children first and newest next", () => {
    const children = Array.from({ length: 80 }, (_, index) => session(`child-${index}`, index))
    const entries = taskEntries(
      data({
        session: [{ ...session("root"), parentID: undefined }, ...children],
        session_status: {
          "child-0": { type: "busy" },
          "child-1": { type: "retry", attempt: 1, message: "retrying", next: 10 },
        },
      }),
    )

    expect(entries).toHaveLength(80)
    expect(new Set(entries.map((entry) => entry.session.id))).toEqual(new Set(children.map((child) => child.id)))
    expect(entries.slice(0, 3).map((entry) => entry.session.id)).toEqual(["child-1", "child-0", "child-79"])
    expect(entries.slice(0, 2).map((entry) => entry.category)).toEqual(["Running", "Running"])
    expect(children[0].id).toBe("child-0")
  })

  const cases: { name: string; messages?: Message[]; expected: string }[] = [
    { name: "unloaded messages", expected: "No output" },
    { name: "empty child", messages: [], expected: "Not started" },
    { name: "prompt without a response", messages: [user()], expected: "No output" },
    { name: "finished response", messages: [user(), assistant()], expected: "Completed" },
    { name: "unfinished response", messages: [assistant({ time: { created: 3 } })], expected: "No final output" },
    { name: "tool call", messages: [assistant({ finish: "tool-calls" })], expected: "No final output" },
    { name: "unknown finish", messages: [assistant({ finish: "unknown" })], expected: "No final output" },
    { name: "missing finish", messages: [assistant({ finish: undefined })], expected: "No final output" },
    {
      name: "failed response",
      messages: [assistant({ error: { name: "UnknownError", data: { message: "failed" } } })],
      expected: "Failed",
    },
    {
      name: "aborted response",
      messages: [assistant({ error: { name: "MessageAbortedError", data: { message: "aborted" } } })],
      expected: "Interrupted",
    },
    { name: "new unanswered prompt", messages: [user(), assistant(), user(5)], expected: "No output" },
  ]

  test.each(cases)("uses actual evidence for $name", ({ messages, expected }) => {
    expect(taskEntries(data({ message: { child: messages } }))[0].category).toBe(expected)
  })

  test("preserves completed status for passive mail until its ignored placeholder is delivered", () => {
    const mail: TextPart = {
      id: "part-mail",
      messageID: "user-5",
      sessionID: "child",
      type: "text",
      synthetic: true,
      ignored: true,
      text: "A queued message from the parent",
      metadata: {
        collaboration: {
          pending: true,
          mailID: "mail-5",
          senderSessionID: "parent",
          recipientSessionID: "child",
          senderPath: "/root",
          recipientPath: "/root/child",
          kind: "MESSAGE",
          content: "A queued message from the parent",
          triggerTurn: false,
          time: 5,
        },
      },
    }
    const input = data({ message: { child: [user(), assistant(), user(5)] }, part: { [mail.messageID]: [mail] } })

    expect(taskEntries(input)[0].category).toBe("Completed")
    input.part[mail.messageID] = [{ ...mail, ignored: false }]
    expect(taskEntries(input)[0].category).toBe("No output")
    input.message.child?.push(assistant({ time: { created: 6, completed: 7 }, parentID: "user-5" }))
    expect(taskEntries(input)[0].category).toBe("Completed")
  })

  test("treats unloaded user parts conservatively but ignores known empty content", () => {
    const input = data({ message: { child: [user(), assistant(), user(5)] } })
    expect(taskEntries(input)[0].category).toBe("No output")

    input.part["user-5"] = []
    expect(taskEntries(input)[0].category).toBe("Completed")

    const text: TextPart = { id: "text-5", messageID: "user-5", sessionID: "child", type: "text", text: "" }
    input.part["user-5"] = [text]
    expect(taskEntries(input)[0].category).toBe("Completed")

    input.part["user-5"] = [{ ...text, text: "A real followup prompt" }]
    expect(taskEntries(input)[0].category).toBe("No output")
  })

  test("does not ignore an entire user message when it contains both ignored text and an attachment", () => {
    expect(
      taskEntries(
        data({
          message: { child: [user(), assistant(), user(5)] },
          part: {
            "user-5": [
              { id: "text-5", messageID: "user-5", sessionID: "child", type: "text", text: "ignored", ignored: true },
              {
                id: "file-5",
                messageID: "user-5",
                sessionID: "child",
                type: "file",
                mime: "image/png",
                url: "file:///project/image.png",
              },
            ],
          },
        }),
      )[0].category,
    ).toBe("No output")
  })

  test.each(["task", "spawn_agent", "followup_task"])(
    "recognizes %s metadata without treating launch as completion",
    (name) => {
      for (const key of ["sessionId", "session_id"]) {
        const entry = taskEntries(data({ part: { parent: [tool(name, { [key]: "child", background: true })] } }))[0]
        expect(entry.background).toBe(true)
        expect(entry.category).toBe("Not started")
      }
    },
  )

  test("ignores unrelated tools and pending metadata", () => {
    const entry = taskEntries(
      data({
        part: {
          parent: [
            tool("bash", { sessionId: "child", background: true }),
            { ...tool("task", {}), state: { status: "pending", input: { sessionId: "child" }, raw: "" } },
            tool("spawn_agent", { sessionId: 123, background: true }),
          ],
        },
      }),
    )[0]
    expect(entry.background).toBe(false)
    expect(entry.category).toBe("Not started")
  })

  test.each([
    ["completed", "Completed"],
    ["error", "Failed"],
    ["cancelled", "Interrupted"],
    ["pending", "Not started"],
    ["running", "Not started"],
  ])("uses observed job state %s rather than the polling tool's completion", (state, expected) => {
    expect(
      taskEntries(data({ part: { parent: [tool("task_status", { task_id: "child", state })] } }))[0].category,
    ).toBe(expected)
  })

  test("uses the newest job result independent of part insertion order", () => {
    expect(
      taskEntries(
        data({
          part: {
            newer: [tool("task_status", { task_id: "child", state: "completed" }, 10)],
            older: [tool("task_status", { task_id: "child", state: "error" })],
          },
        }),
      )[0].category,
    ).toBe("Completed")
  })

  test("recognizes a successful interrupt even with no child messages", () => {
    expect(
      taskEntries(
        data({ part: { parent: [tool("interrupt_agent", { session_id: "child", status: "interrupted" })] } }),
      )[0].category,
    ).toBe("Interrupted")
  })

  test("recognizes a failed launch with a known child session", () => {
    expect(
      taskEntries(
        data({
          part: {
            parent: [
              {
                ...tool("spawn_agent", {}),
                state: {
                  status: "error",
                  input: {},
                  error: "failed to start",
                  metadata: { sessionId: "child" },
                  time: { start: 2, end: 3 },
                },
              },
            ],
          },
        }),
      )[0].category,
    ).toBe("Failed")
  })

  test("does not reuse completed output or job state for a new followup", () => {
    const input = data({
      message: { child: [user(), assistant()] },
      part: {
        parent: [
          tool("task_status", { task_id: "child", state: "completed" }, 5),
          tool("followup_task", { session_id: "child", background: true }, 10),
        ],
      },
    })
    expect(taskEntries(input)[0].category).toBe("Not started")
    input.message.child?.push(user(11), assistant({ time: { created: 12, completed: 13 }, parentID: "user-11" }))
    expect(taskEntries(input)[0].category).toBe("Completed")
  })

  test("does not count inherited fork history as child output", () => {
    expect(
      taskEntries(
        data({
          session: [{ ...session(), time: { created: 10, updated: 10 } }],
          message: { child: [user(), assistant()] },
        }),
      )[0].category,
    ).toBe("Not started")
  })

  test("new child messages and live running state supersede historical job failures", () => {
    const input = data({
      message: { child: [user(5), assistant({ time: { created: 6, completed: 7 }, parentID: "user-5" })] },
      part: { parent: [tool("task_status", { task_id: "child", state: "error" })] },
    })
    expect(taskEntries(input)[0].category).toBe("Completed")
    input.session_status.child = { type: "busy" }
    expect(taskEntries(input)[0].category).toBe("Running")
  })
})
