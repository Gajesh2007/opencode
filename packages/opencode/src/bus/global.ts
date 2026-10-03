import { EventEmitter } from "events"
import { Identifier } from "@/id/id"
import { Effect, Queue, Stream } from "effect"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  override emit(eventName: "event", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    return super.emit(eventName, event)
  }
}

export const GlobalBus = new GlobalBusEmitter()

export function subscribeBounded<A>(
  register: (offer: (event: A) => void) => () => void,
  options: { capacity: number; onOverflow?: () => void },
) {
  return Effect.gen(function* () {
    const queue = yield* Queue.bounded<A>(options.capacity)
    const unsubscribe = register((event) => {
      if (Queue.offerUnsafe(queue, event)) return
      // Deltas cannot be dropped: detach and discard the backlog before disconnecting.
      unsubscribe()
      Effect.runSync(Queue.shutdown(queue))
      options.onOverflow?.()
    })
    const cleanup = Effect.sync(unsubscribe).pipe(Effect.andThen(Queue.shutdown(queue)))
    yield* Effect.addFinalizer(() => cleanup)
    return Stream.fromQueue(queue).pipe(Stream.ensuring(cleanup))
  })
}
