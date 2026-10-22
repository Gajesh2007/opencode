import { createMemo, For, Show } from "solid-js"
import { useInfiniteQuery } from "@tanstack/solid-query"
import { useNavigate } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { sessionTitle } from "@/utils/session-title"
import { loadRecentSessions, mergeRecentSessions, recentSessionTarget } from "./recent-sessions"

export function RecentChats() {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const layout = useLayout()
  const server = useServer()
  const navigate = useNavigate()
  const query = useInfiniteQuery(() => ({
    queryKey: ["home", "global-sessions", sdk.url],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) => loadRecentSessions(sdk.client, pageParam, signal),
    getNextPageParam: (page) => page.cursor,
  }))
  const sessions = createMemo(() => mergeRecentSessions(query.data?.pages ?? []))

  return (
    <section class="flex w-full min-w-0 flex-col gap-3" aria-label={language.t("sidebar.project.recentSessions")}>
      <div class="flex min-w-0 items-center justify-between gap-2 px-3">
        <h2 class="text-14-medium text-text-strong">{language.t("sidebar.project.recentSessions")}</h2>
        <Button variant="ghost" size="normal" disabled={query.isFetching} onClick={() => void query.refetch()}>
          <Show when={query.isFetching}>
            <Spinner class="size-4" />
          </Show>
          Refresh
        </Button>
      </div>
      <Show when={query.isLoading}>
        <div class="px-3 text-14-regular text-text-weak" role="status">
          {language.t("common.loading")}
        </div>
      </Show>
      <Show when={query.isError}>
        <div class="px-3 text-14-regular text-text-weak" role="alert">
          {language.t("common.requestFailed")}
        </div>
      </Show>
      <Show when={query.isSuccess && sessions().length === 0}>
        <div class="px-3 text-14-regular text-text-weak">{language.t("home.sessions.empty")}</div>
      </Show>
      <ul class="flex min-w-0 flex-col gap-1">
        <For each={sessions()}>
          {(session) => (
            <li class="min-w-0">
              <button
                type="button"
                class="flex min-h-14 w-full min-w-0 flex-col justify-center gap-1 rounded-md px-3 py-2 text-left hover:bg-surface-base-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-active"
                onClick={() => {
                  const target = recentSessionTarget(session)
                  layout.projects.open(target.directory)
                  server.projects.touch(target.directory)
                  navigate(target.href)
                }}
              >
                <span class="w-full truncate text-14-medium text-text-strong">
                  {sessionTitle(session.title) || session.id}
                </span>
                <span class="w-full break-all text-12-mono text-text-weak sm:truncate" title={session.directory}>
                  {session.directory}
                </span>
              </button>
            </li>
          )}
        </For>
      </ul>
      <Show when={query.hasNextPage}>
        <Button
          variant="ghost"
          class="self-start"
          disabled={query.isFetching}
          onClick={() => void query.fetchNextPage()}
        >
          {language.t(query.isFetchingNextPage ? "common.loading" : "common.loadMore")}
        </Button>
      </Show>
    </section>
  )
}
