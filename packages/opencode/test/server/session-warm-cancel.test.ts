import { NodeHttpServer } from "@effect/platform-node"
import { AppLayer } from "@/effect/app-runtime"
import { ProjectID } from "@/project/schema"
import { LLM } from "@/session/llm"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { SessionApi } from "../../src/server/routes/instance/httpapi/groups/session"
import { sessionHandlers } from "../../src/server/routes/instance/httpapi/handlers/session"
import { Authorization } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { testEffect } from "../lib/effect"

const api = HttpApi.make("opencode-instance").addHttpApi(SessionApi)
const middleware = Layer.mergeAll(
  Layer.succeed(
    Authorization,
    Authorization.of((effect) => effect),
  ),
  Layer.succeed(
    InstanceContextMiddleware,
    InstanceContextMiddleware.of((effect) => effect),
  ),
  Layer.succeed(
    WorkspaceRoutingMiddleware,
    WorkspaceRoutingMiddleware.of((effect) =>
      effect.pipe(Effect.provideService(WorkspaceRouteContext, { directory: process.cwd() })),
    ),
  ),
)

for (const supported of [true, false]) {
  const calls: string[] = []
  const sessionID = SessionID.make("ses_warm_cancel")
  const record = (event: string) => Effect.sync(() => void calls.push(event))
  const it = testEffect(
    HttpRouter.serve(
      HttpApiBuilder.layer(api).pipe(
        Layer.provide(sessionHandlers),
        Layer.provide([
          middleware,
          schemaErrorLayer,
          Layer.succeed(
            LLM.Service,
            LLM.Service.of({
              stream: () => Stream.empty,
              ...(supported ? { cancelWarm: (id: string) => record(`warm:${id}`) } : {}),
            }),
          ),
          Layer.mock(SessionPrompt.Service, { cancel: (id) => record(`abort:${id}`) }),
          Layer.mock(Session.Service, {
            get: (id) =>
              record(`get:${id}`).pipe(
                Effect.andThen(
                  id !== sessionID
                    ? Effect.fail(new Storage.NotFoundError({ message: "missing session" }))
                    : Effect.succeed({
                        id,
                        slug: "warm",
                        title: "Warm cancellation",
                        projectID: ProjectID.global,
                        directory: process.cwd(),
                        version: "1",
                        time: { created: 0, updated: 0 },
                      }),
                ),
              ),
            remove: (id) => record(`remove:${id}`),
          }),
        ]),
        Layer.provide(AppLayer),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
  )

  it.live(`session abort/delete ${supported ? "cancel warm first" : "support legacy LLM without cancelWarm"}`, () =>
    Effect.gen(function* () {
      for (const action of ["abort", "remove"]) {
        calls.length = 0
        const request =
          action === "abort"
            ? HttpClientRequest.post(`/session/${sessionID}/abort`)
            : HttpClientRequest.delete(`/session/${sessionID}`)
        const response = yield* HttpClient.execute(request)
        expect(response.status).toBe(200)
        expect(yield* response.json).toBe(true)
        expect(calls).toEqual([
          `get:${sessionID}`,
          ...(supported ? [`warm:${sessionID}`] : []),
          `${action}:${sessionID}`,
        ])

        calls.length = 0
        const missing =
          action === "abort"
            ? HttpClientRequest.post("/session/ses_missing/abort")
            : HttpClientRequest.delete("/session/ses_missing")
        expect((yield* HttpClient.execute(missing)).status).toBe(404)
        expect(calls).toEqual(["get:ses_missing"])
      }
    }),
  )
}
