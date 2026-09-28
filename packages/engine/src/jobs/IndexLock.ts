import { Effect, Semaphore } from "effect"

/**
 * Coordinates jobs writing to the one shared LanceDB table. Batch writes and
 * deletes run side by side. Finalizing (compacting the table and rebuilding
 * full-text search) runs alone: LanceDB rejects those commits when another
 * write lands first, and during a Sync All there's nearly always another write.
 */
export interface IndexLock {
  // Run a write alongside other writes, but never during a finalize
  readonly write: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  // Run with no writes in flight; writes that arrive meanwhile wait behind it
  readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

// More writes than could ever be in flight, so `exclusive` holding all of
// them means no write is running
const MAX_WRITES = 1_000_000

export const makeIndexLock: Effect.Effect<IndexLock> = Effect.gen(function* () {
  // A waiting finalize holds the gate, so writes that arrive after it queue
  // here instead of overtaking it on `writes` (Semaphore isn't first-come,
  // first-served: smaller requests can pass a larger one that's waiting)
  const gate = yield* Semaphore.make(1)
  const writes = yield* Semaphore.make(MAX_WRITES)

  return {
    write: (effect) => gate.withPermit(Effect.void).pipe(Effect.andThen(writes.withPermits(1)(effect))),
    exclusive: (effect) => gate.withPermit(writes.withPermits(MAX_WRITES)(effect))
  }
})
