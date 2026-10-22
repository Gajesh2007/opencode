import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import type { SessionSearchResult } from "@opencode-ai/sdk/v2"
import { errorMessage } from "@/util/error"

export function createSessionSearch(
  input: Accessor<{ query: string; mode: "all" | "title" }>,
  fetch: (input: {
    query: string
    mode: "all" | "title"
    cursor?: string
    signal: AbortSignal
  }) => Promise<SessionSearchResult>,
) {
  const [result, setResult] = createSignal<SessionSearchResult>()
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [revision, setRevision] = createSignal(0)
  let loadMore = () => {}

  createEffect(() => {
    const current = input()
    revision()
    const controller = new AbortController()
    setResult(undefined)
    setError(undefined)
    setLoading(!!current.query.trim())

    async function load(cursor?: string) {
      setLoading(true)
      setError(undefined)
      try {
        const page = await fetch({ ...current, cursor, signal: controller.signal })
        if (controller.signal.aborted) return
        setResult((previous) => ({
          ...page,
          items: Array.from(
            new Map(
              [...(cursor ? (previous?.items ?? []) : []), ...page.items].map((item) => [item.session.id, item]),
            ).values(),
          ),
        }))
      } catch (err) {
        if (!controller.signal.aborted) setError(errorMessage(err))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }

    const timer = current.query.trim() ? setTimeout(() => void load(), 150) : undefined
    loadMore = () => {
      const next = result()?.next
      if (loading() || next === undefined) return
      void load(next)
    }
    onCleanup(() => {
      clearTimeout(timer)
      controller.abort()
    })
  })

  return { result, loading, error, more: () => loadMore(), refresh: () => setRevision((x) => x + 1) }
}
