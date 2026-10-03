import { BusEvent } from "@/bus/bus-event"
import { Deferred, Effect, Fiber, Option, Schema, Stream } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { NodeHttpServerRequest } from "@effect/platform-node"
import { IncomingMessage } from "node:http"

export const Event = {
  Connected: BusEvent.define("server.connected", Schema.Struct({})),
  Disposed: BusEvent.define("global.disposed", Schema.Struct({})),
}

export const SSE_QUEUE_CAPACITY = 1024

export function disconnectOnOverflow<A, E, R>(stream: Stream.Stream<A, E, R>, overflow: Deferred.Deferred<void>) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
      const response =
        Option.isSome(request) && request.value.source instanceof IncomingMessage
          ? NodeHttpServerRequest.toServerResponse(request.value)
          : undefined
      return yield* Effect.withFiber((consumer) =>
        Deferred.await(overflow).pipe(
          // Node's interrupted response handler calls end(), which retains a
          // stalled socket's write buffer. Destroy before interrupting the pump.
          Effect.andThen(Effect.sync(() => response?.destroy())),
          Effect.andThen(Fiber.interrupt(consumer)),
          Effect.forkScoped,
          Effect.as(stream),
        ),
      )
    }),
  )
}
