/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { unwrap } from "solid-js/store"
import type {
  GlobalEvent,
  Session,
  SessionMessage,
  SessionMessageAssistant,
  TextPart,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"

function session(id: string): Session {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    directory,
    title: id,
    version: "test",
    time: { created: 0, updated: 0 },
  }
}

function message(sessionID: string): UserMessage {
  return {
    id: `${sessionID}_message`,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "build",
    model: { providerID: "test", modelID: "test" },
  }
}

function text(sessionID: string): TextPart {
  return {
    id: `${sessionID}_part`,
    sessionID,
    messageID: message(sessionID).id,
    type: "text",
    text: "persisted transcript",
  }
}

function synthetic(sessionID: string, value = "persisted"): SessionMessage {
  return { id: `${sessionID}_synthetic`, sessionID, type: "synthetic", text: value, time: { created: 0 } }
}

function assistant(value: string): SessionMessageAssistant {
  return {
    id: "step",
    type: "assistant",
    agent: "build",
    model: { id: "test", providerID: "test", variant: "" },
    time: { created: 0 },
    content: [{ type: "text", text: value }],
  }
}

async function fixture(
  run: (ctx: Awaited<ReturnType<typeof mount>>) => Promise<void>,
  fetch?: Parameters<typeof mount>[0],
) {
  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const ctx = await mount(fetch)
  try {
    await run(ctx)
  } finally {
    ctx.app.renderer.destroy()
    Global.Path.state = previous
  }
}

function publish(ctx: Awaited<ReturnType<typeof mount>>, payload: GlobalEvent["payload"]) {
  ctx.emit({ directory: "/tmp/opencode", project: "proj_test", payload })
}

async function fence(ctx: Awaited<ReturnType<typeof mount>>, branch: string) {
  publish(ctx, { id: branch, type: "vcs.branch.updated", properties: { branch } })
  await wait(() => ctx.sync.data.vcs?.branch === branch)
}

test("v2 stays lazy, reloads evicted views, and keeps the selected background transcript live", async () => {
  const calls: string[] = []
  await fixture(
    async (ctx) => {
      publish(ctx, {
        id: "unopened",
        type: "session.next.synthetic",
        properties: { sessionID: "a", timestamp: 0, text: "persisted" },
      })
      await fence(ctx, "unopened")
      expect(ctx.syncV2.data.messages).toEqual({})
      await ctx.syncV2.session.message.sync("a")
      expect(ctx.syncV2.session.message.fromSession("a")).toEqual([synthetic("a")])
      publish(ctx, {
        id: "live",
        type: "session.next.synthetic",
        properties: { sessionID: "a", timestamp: 1, text: "live update" },
      })
      publish(ctx, {
        id: "other",
        type: "session.next.synthetic",
        properties: { sessionID: "b", timestamp: 1, text: "other background" },
      })
      await fence(ctx, "background")
      expect(ctx.syncV2.data.messages.a).toHaveLength(2)
      expect(ctx.syncV2.data.messages.b).toBeUndefined()
      await ctx.syncV2.session.message.sync("b")
      expect(Object.keys(ctx.syncV2.data.messages)).toEqual(["b"])
      await ctx.syncV2.session.message.sync("a")
      expect(ctx.syncV2.data.messages.a).toEqual([synthetic("a")])
      expect(Object.keys(ctx.syncV2.data.messages)).toEqual(["a"])
      expect(calls).toEqual(["a", "b", "a"])
    },
    (url) => {
      const match = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname)
      if (!match) return
      calls.push(match[1])
      return json({ items: [synthetic(match[1])], cursor: {} })
    },
  )
})

test("v2 preserves active tool input deltas, tool completion, and step completion", async () => {
  await fixture(
    async (ctx) => {
      await ctx.syncV2.session.message.sync("a")
      publish(ctx, {
        id: "step",
        type: "session.next.step.started",
        properties: {
          sessionID: "a",
          timestamp: 1,
          agent: "build",
          model: { id: "test", providerID: "test", variant: "" },
        },
      })
      publish(ctx, {
        id: "input",
        type: "session.next.tool.input.started",
        properties: { sessionID: "a", timestamp: 2, callID: "call", name: "bash" },
      })
      publish(ctx, {
        id: "delta",
        type: "session.next.tool.input.delta",
        properties: { sessionID: "a", timestamp: 3, callID: "call", delta: '{"command":"pwd"}' },
      })
      await fence(ctx, "pending")
      const assistant = ctx.syncV2.data.messages.a[0]
      expect(assistant.type).toBe("assistant")
      if (assistant.type !== "assistant") throw new Error("missing assistant")
      expect(assistant.content[0]).toMatchObject({ state: { status: "pending", input: '{"command":"pwd"}' } })
      publish(ctx, {
        id: "called",
        type: "session.next.tool.called",
        properties: {
          sessionID: "a",
          timestamp: 4,
          callID: "call",
          tool: "bash",
          input: { command: "pwd" },
          provider: { executed: false },
        },
      })
      publish(ctx, {
        id: "success",
        type: "session.next.tool.success",
        properties: {
          sessionID: "a",
          timestamp: 5,
          callID: "call",
          structured: {},
          content: [{ type: "text", text: directory }],
          provider: { executed: false },
        },
      })
      publish(ctx, {
        id: "ended",
        type: "session.next.step.ended",
        properties: {
          sessionID: "a",
          timestamp: 6,
          finish: "stop",
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      })
      await fence(ctx, "completed")
      expect(assistant.time.completed).toBe(6)
      expect(unwrap(assistant.content[0])).toMatchObject({
        state: { status: "completed", input: { command: "pwd" }, content: [{ type: "text", text: directory }] },
        time: { completed: 5 },
      })
    },
    (url) => (url.pathname.startsWith("/api/session/") ? json({ items: [], cursor: {} }) : undefined),
  )
})

test("v2 stale hydration cannot revive a switched or deleted session", async () => {
  const pending = Promise.withResolvers<Response>()
  const deleted = Promise.withResolvers<Response>()
  let requested = false
  let reloading = false
  let loads = 0
  await fixture(
    async (ctx) => {
      const loading = ctx.syncV2.session.message.sync("a")
      await wait(() => requested)
      await ctx.syncV2.session.message.sync("b")
      pending.resolve(json({ items: [synthetic("a")], cursor: {} }))
      await loading
      expect(Object.keys(ctx.syncV2.data.messages)).toEqual(["b"])
      const reload = ctx.syncV2.session.message.sync("b")
      await wait(() => reloading)
      publish(ctx, { id: "deleted", type: "session.deleted", properties: { sessionID: "b", info: session("b") } })
      await fence(ctx, "deleted")
      deleted.resolve(json({ items: [synthetic("b")], cursor: {} }))
      await reload
      expect(ctx.syncV2.data.messages).toEqual({})
    },
    (url) => {
      if (url.pathname === "/api/session/a/message") {
        requested = true
        return pending.promise
      }
      if (url.pathname === "/api/session/b/message") {
        if (++loads === 1) return json({ items: [synthetic("b")], cursor: {} })
        reloading = true
        return deleted.promise
      }
    },
  )
})

test("v2 preserves one-fetch snapshot-wins hydration without retrying live events", async () => {
  const pending = Promise.withResolvers<Response>()
  let requests = 0
  await fixture(
    async (ctx) => {
      const loading = ctx.syncV2.session.message.sync("a")
      await wait(() => requests === 1)
      publish(ctx, {
        id: "new",
        type: "session.next.synthetic",
        properties: { sessionID: "a", timestamp: 1, text: "new" },
      })
      await fence(ctx, "raced")
      pending.resolve(json({ items: [synthetic("a", "old")], cursor: {} }))
      await loading
      expect(requests).toBe(1)
      expect(ctx.syncV2.data.messages.a).toEqual([synthetic("a", "old")])
      publish(ctx, {
        id: "after",
        type: "session.next.synthetic",
        properties: { sessionID: "a", timestamp: 2, text: "after snapshot" },
      })
      await fence(ctx, "after")
      expect(ctx.syncV2.data.messages.a).toHaveLength(2)
    },
    (url) => {
      if (url.pathname !== "/api/session/a/message") return
      requests++
      if (requests === 1) return pending.promise
      return json({ items: [synthetic("a", "new")], cursor: {} })
    },
  )
})

test("v2 hydration resolves during continuous deltas and final text remains authoritative", async () => {
  const pending = Promise.withResolvers<Response>()
  let requests = 0
  await fixture(
    async (ctx) => {
      const loading = ctx.syncV2.session.message.sync("a")
      await wait(() => requests === 1)
      let streaming = true
      let deltas = 0
      const stream = (async () => {
        while (streaming) {
          publish(ctx, {
            id: `delta_${++deltas}`,
            type: "session.next.text.delta",
            properties: { sessionID: "a", timestamp: deltas, delta: "x" },
          })
          await fence(ctx, `stream_${deltas}`)
        }
      })()
      try {
        await wait(() => deltas >= 5)
        // This API does not persist text.delta. An in-progress snapshot can
        // contain an empty text part even after earlier deltas were published.
        pending.resolve(json({ items: [assistant("")], cursor: {} }))
        await loading
        expect(requests).toBe(1)
        const hydrated = ctx.syncV2.data.messages.a[0]
        expect(hydrated.type).toBe("assistant")
      } finally {
        streaming = false
        await stream
      }
      const hydrated = ctx.syncV2.data.messages.a[0]
      publish(ctx, {
        id: "text_ended",
        type: "session.next.text.ended",
        properties: { sessionID: "a", timestamp: deltas + 1, text: "full authoritative transcript" },
      })
      await fence(ctx, "text_ended")
      expect(hydrated.type === "assistant" && hydrated.content[0]).toEqual({
        type: "text",
        text: "full authoritative transcript",
      })
    },
    (url) => {
      if (url.pathname !== "/api/session/a/message") return
      requests++
      return pending.promise
    },
  )
})

test("v2 release stops closed-view retention and reopening reloads persisted history", async () => {
  let requests = 0
  await fixture(
    async (ctx) => {
      await ctx.syncV2.session.message.sync("a")
      ctx.syncV2.session.message.release("other")
      expect(ctx.syncV2.data.messages.a).toHaveLength(1)
      ctx.syncV2.session.message.release("a")
      publish(ctx, {
        id: "closed",
        type: "session.next.synthetic",
        properties: { sessionID: "a", timestamp: 2, text: "persisted while closed" },
      })
      await fence(ctx, "closed")
      expect(ctx.syncV2.data.messages).toEqual({})
      await ctx.syncV2.session.message.sync("a")
      expect(requests).toBe(2)
      expect(ctx.syncV2.data.messages.a).toEqual([synthetic("a", "reloaded")])
    },
    (url) => {
      if (url.pathname !== "/api/session/a/message") return
      return json({
        items: [synthetic("a", ++requests === 1 ? "initial" : "reloaded")],
        cursor: {},
      })
    },
  )
})

test("v2 release prevents late hydration from reopening the view", async () => {
  const pending = Promise.withResolvers<Response>()
  let requested = false
  await fixture(
    async (ctx) => {
      const loading = ctx.syncV2.session.message.sync("a")
      await wait(() => requested)
      publish(ctx, {
        id: "live_during_load",
        type: "session.next.synthetic",
        properties: { sessionID: "a", timestamp: 2, text: "live while loading" },
      })
      await fence(ctx, "live_during_load")
      ctx.syncV2.session.message.release("a")
      pending.resolve(json({ items: [synthetic("a")], cursor: {} }))
      await loading
      expect(ctx.syncV2.data.messages).toEqual({})
    },
    (url) => {
      if (url.pathname !== "/api/session/a/message") return
      requested = true
      return pending.promise
    },
  )
})

test("legacy removal frees message parts and session deletion frees all session data and reload eligibility", async () => {
  let loads = 0
  await fixture(
    async (ctx) => {
      await ctx.sync.session.sync("a")
      expect(ctx.sync.data.part[message("a").id]).toEqual([text("a")])
      publish(ctx, {
        id: "removed",
        type: "message.removed",
        properties: { sessionID: "a", messageID: message("a").id },
      })
      publish(ctx, {
        id: "orphan",
        type: "message.part.updated",
        properties: { sessionID: "a", time: 1, part: { ...text("a"), messageID: "orphan" } },
      })
      await fence(ctx, "removed")
      expect(ctx.sync.data.part[message("a").id]).toBeUndefined()
      publish(ctx, { id: "deleted", type: "session.deleted", properties: { sessionID: "a", info: session("a") } })
      await fence(ctx, "deleted")
      expect(ctx.sync.data.message.a).toBeUndefined()
      expect(ctx.sync.data.part.orphan).toBeUndefined()
      expect(ctx.sync.data.todo.a).toBeUndefined()
      expect(ctx.sync.data.session_diff.a).toBeUndefined()
      await ctx.sync.session.sync("a")
      expect(loads).toBe(2)
      expect(ctx.sync.data.message.a).toEqual([message("a")])
    },
    (url) => {
      if (url.pathname === "/session/a") return json(session("a"))
      if (url.pathname === "/session/a/message") {
        loads++
        return json([{ info: message("a"), parts: [text("a")] }])
      }
      if (url.pathname === "/session/a/todo") return json([])
      if (url.pathname === "/session/a/diff") return json([])
    },
  )
})

test("legacy stale hydration cannot resurrect a deleted session", async () => {
  const pending = Promise.withResolvers<Response>()
  let requested = false
  await fixture(
    async (ctx) => {
      const loading = ctx.sync.session.sync("a")
      await wait(() => requested)
      publish(ctx, { id: "deleted", type: "session.deleted", properties: { sessionID: "a", info: session("a") } })
      await fence(ctx, "stale")
      pending.resolve(json([{ info: message("a"), parts: [text("a")] }]))
      await loading
      expect(ctx.sync.session.get("a")).toBeUndefined()
      expect(ctx.sync.data.message.a).toBeUndefined()
      expect(ctx.sync.data.part[message("a").id]).toBeUndefined()
    },
    (url) => {
      if (url.pathname === "/session/a") return json(session("a"))
      if (url.pathname === "/session/a/message") {
        requested = true
        return pending.promise
      }
      if (url.pathname === "/session/a/todo") return json([])
      if (url.pathname === "/session/a/diff") return json([])
    },
  )
})
