import { BunWorker } from "@effect/platform-bun"
import { makePool, type WorkerPool } from "@effect/platform/Worker"
import { isWorkerError, WorkerError } from "@effect/platform/WorkerError"
import { Deferred, Effect, FiberId, Stream } from "effect"
import type { WorkerInput, WorkerEvent } from "./EngineWorkerTypes.js"

// ── Lazily-initialized worker pool (size 1: one link at a time) ──

const spawnWorker = () =>
  new Worker(
    new URL("./EngineWorkerEntry.js", import.meta.url),
    { type: "module" },
  )

const StreamWorkerLayer = BunWorker.layer(spawnWorker)

const poolInit = Deferred.unsafeMake<
  WorkerPool<WorkerInput, WorkerEvent, never>,
  WorkerError
>(FiberId.none)

let poolStarted = false

const startPool: Effect.Effect<void, never, never> = Effect.suspend(() => {
  if (poolStarted) {
    return Effect.never
  }
  poolStarted = true
  return Effect.scoped(
    Effect.flatMap(
      makePool<WorkerInput, WorkerEvent, never>({ size: 1 }).pipe(
        Effect.provide(StreamWorkerLayer),
      ),
      (pool) =>
        Deferred.succeed(poolInit, pool).pipe(
          Effect.flatMap(() => Effect.never),
        ),
    ),
  ).pipe(
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        console.error("Worker pool creation failed:", cause)
      }),
    ),
  )
})

/**
 * Execute a worker operation and return a stream of events.
 * Operations are serialized (pool size 1) so only one runs at a time.
 * The pool is started lazily on first use (no worker spawned at import time).
 */
export const execute = (
  input: WorkerInput,
): Stream.Stream<WorkerEvent, Error> =>
  Stream.unwrap(
    Effect.fork(startPool).pipe(
      Effect.flatMap(() => Deferred.await(poolInit)),
      Effect.timeout("10 seconds"),
      Effect.catchTag("TimeoutException", () =>
        Effect.fail(new Error("Worker pool initialization timed out after 10s")),
      ),
      Effect.mapError((e) =>
        e instanceof WorkerError ? new Error(e.message) : e,
      ),
      Effect.map((pool) =>
        pool.execute(input).pipe(
          Stream.catchAll((error) => {
            if (isWorkerError(error) && error.reason === "unknown") {
              return Stream.empty
            }
            return Stream.fail(
              error instanceof WorkerError ? new Error(error.message) : error,
            )
          }),
          Stream.mapError((e) =>
            e instanceof WorkerError ? new Error(e.message) : e,
          ),
        ),
      ),
    ),
  )
