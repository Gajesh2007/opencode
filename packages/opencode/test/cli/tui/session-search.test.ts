import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { SessionSearchResult } from "@opencode-ai/sdk/v2"
import { createSessionSearch } from "@/cli/cmd/tui/util/session-search"

const hit = (id: string): SessionSearchResult["items"][number] => ({
  session: {
    id,
    slug: id,
    projectID: "project",
    directory: "/folder",
    title: id,
    version: "1",
    time: { created: 1, updated: 1 },
  },
  match: { type: "message", text: id },
})

async function wait(predicate: () => boolean) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for search")
    await Bun.sleep(5)
  }
}

function mount(fetch: Parameters<typeof createSessionSearch>[1]) {
  return createRoot((dispose) => {
    const [input, setInput] = createSignal<{ query: string; mode: "all" | "title" }>({ query: "", mode: "all" })
    const search = createSessionSearch(input, fetch)
    return { dispose, setInput, search }
  })
}

test("folder search debounces rapid typing and supports title mode", async () => {
  const calls: { query: string; mode: string }[] = []
  const state = mount(async (input) => {
    calls.push(input)
    return { items: [hit(input.query)] }
  })
  try {
    state.setInput({ query: "f", mode: "all" })
    state.setInput({ query: "final", mode: "all" })
    await wait(() => !state.search.loading())
    expect(calls.map((x) => x.query)).toEqual(["final"])
    state.setInput({ query: "final", mode: "title" })
    await wait(() => calls.length === 2)
    expect(calls[1].mode).toBe("title")
  } finally {
    state.dispose()
  }
})

test("changing or clearing a query aborts requests and ignores late responses", async () => {
  const old = Promise.withResolvers<SessionSearchResult>()
  const calls: Parameters<Parameters<typeof createSessionSearch>[1]>[0][] = []
  const state = mount(async (input) => {
    calls.push(input)
    return input.query === "old" ? old.promise : { items: [hit("new")] }
  })
  try {
    state.setInput({ query: "old", mode: "all" })
    await wait(() => calls.length === 1)
    state.setInput({ query: "new", mode: "all" })
    expect(calls[0].signal.aborted).toBe(true)
    expect(state.search.result()).toBeUndefined()
    await wait(() => state.search.result()?.items[0]?.session.id === "new")
    old.resolve({ items: [hit("stale")] })
    await Bun.sleep(0)
    expect(state.search.result()?.items[0].session.id).toBe("new")
    state.setInput({ query: "", mode: "all" })
    expect(state.search.result()).toBeUndefined()
    expect(state.search.loading()).toBe(false)
    expect(calls[1].signal.aborted).toBe(true)
  } finally {
    state.dispose()
  }
})

test("pagination appends all pages, suppresses duplicate loads, and exposes errors for retry", async () => {
  const next = Promise.withResolvers<SessionSearchResult>()
  const cursors: (string | undefined)[] = []
  const state = mount(async (input) => {
    cursors.push(input.cursor)
    if (input.cursor) return next.promise
    return { items: [hit("first")], next: "ses_first" }
  })
  try {
    state.setInput({ query: "chat", mode: "all" })
    await wait(() => state.search.result()?.next === "ses_first")
    state.search.more()
    state.search.more()
    expect(cursors).toEqual([undefined, "ses_first"])
    next.resolve({ items: [hit("first"), hit("last"), hit("last")] })
    await wait(() => !state.search.loading())
    expect(state.search.result()?.items.map((x) => x.session.id)).toEqual(["first", "last"])
    expect(state.search.result()?.next).toBeUndefined()
    state.search.more()
    expect(cursors).toEqual([undefined, "ses_first"])
  } finally {
    state.dispose()
  }
})

test("search errors are visible, refresh retries, and disposal aborts in-flight work", async () => {
  let count = 0
  let signal: AbortSignal | undefined
  const response = Promise.withResolvers<SessionSearchResult>()
  const state = mount(async (input) => {
    signal = input.signal
    if (!count++) throw new Error("offline")
    return response.promise
  })
  state.setInput({ query: "chat", mode: "all" })
  await wait(() => state.search.error() !== undefined)
  expect(state.search.error()).toContain("offline")
  state.search.refresh()
  await wait(() => count === 2)
  expect(state.search.error()).toBeUndefined()
  state.dispose()
  expect(signal?.aborted).toBe(true)
  response.resolve({ items: [hit("disposed")] })
  await Bun.sleep(0)
  expect(state.search.result()).toBeUndefined()
})
