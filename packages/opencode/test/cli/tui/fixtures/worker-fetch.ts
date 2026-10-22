import { createWorkerFetchHandlers } from "@/cli/cmd/tui/worker-fetch"
import { Rpc } from "@/util/rpc"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"

const app = HttpRouter.toWebHandler(
  Layer.mergeAll(
    HttpRouter.add("GET", "/ok", Effect.succeed(HttpServerResponse.text("ok"))),
    HttpRouter.add(
      "POST",
      "/session/:sessionID/warm",
      Effect.sync(() => Rpc.emit("warm.started", undefined)).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => Rpc.emit("warm.stopped", undefined))),
      ),
    ),
  ),
  { disableLogger: true },
)
const requests = createWorkerFetchHandlers((request) => {
  Rpc.emit("fetch.started", new URL(request.url).pathname)
  return app.handler(request)
})
Rpc.listen({
  ...requests,
  async shutdown() {
    requests.shutdown()
    await app.dispose()
  },
})
