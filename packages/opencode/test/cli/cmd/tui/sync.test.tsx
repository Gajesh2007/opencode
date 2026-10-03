/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "../../../fixture/fixture"
import { mount, wait } from "./sync-fixture"
import type { GlobalEvent, ToolPart } from "@opencode-ai/sdk/v2"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

describe("tui sync", () => {
  test("streams nested tool arguments until final input replaces them", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount()
    const part: ToolPart = {
      id: "prt_stream",
      messageID: "msg_stream",
      sessionID: "ses_stream",
      type: "tool",
      tool: "apply_patch",
      callID: "call_stream",
      state: { status: "pending", input: {}, raw: "" },
    }
    const publish = (payload: GlobalEvent["payload"]) =>
      emit({ directory: "/tmp/opencode", project: "proj_test", payload })
    const delta = (text: string) =>
      publish({
        id: "evt_delta",
        type: "message.part.delta",
        properties: {
          sessionID: part.sessionID,
          messageID: part.messageID,
          partID: part.id,
          field: "state.raw",
          delta: text,
        },
      })
    try {
      publish({
        id: "evt_pending",
        type: "message.part.updated",
        properties: { part, sessionID: part.sessionID, time: Date.now() },
      })
      delta('{"patchText":"*** Begin Patch')
      delta("\\n*** Add File: main.ts\\n+const value = 1;")
      await wait(() => {
        const streamed = sync.data.part[part.messageID]?.[0]
        return streamed?.type === "tool" && streamed.state.status === "pending" && streamed.state.raw.includes("value")
      })
      const streamed = sync.data.part[part.messageID][0]
      expect(Object.hasOwn(streamed, "state.raw")).toBe(false)
      expect(streamed).not.toHaveProperty("text")
      expect(streamed.type === "tool" && streamed.state.status === "pending" && streamed.state.raw).toBe(
        '{"patchText":"*** Begin Patch\\n*** Add File: main.ts\\n+const value = 1;',
      )

      const state: ToolPart["state"] = {
        status: "running",
        input: { patchText: "final parsed patch" },
        time: { start: 1 },
      }
      publish({
        id: "evt_running",
        type: "message.part.updated",
        properties: { part: { ...part, state }, sessionID: part.sessionID, time: Date.now() },
      })
      delta("late delta")
      await wait(() => {
        const current = sync.data.part[part.messageID]?.[0]
        return current?.type === "tool" && current.state.status === "running"
      })
      expect(sync.data.part[part.messageID][0]).toEqual({ ...part, state })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount()

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/opencode")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount()

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })
})
