import { BunWorker } from "@effect/platform-bun"
import { makePool, type WorkerPool } from "@effect/platform/Worker"
import { isWorkerError, WorkerError } from "@effect/platform/WorkerError"
import { Deferred, Effect, FiberId, Stream } from "effect"
import type { WorkerInput, WorkerEvent } from "./EngineWorkerTypes.js"

// ── Module-level worker pool (size 1: one link at a time) ──

const spawnWorker = () =>
  new Worker(
    new URL("./EngineWorkerEntry.ts", import.meta.url),
    { type: "module" },
  )

const StreamWorkerLayer = BunWorker.layer(spawnWorker)

const poolInit = Deferred.unsafeMake<
  WorkerPool<WorkerInput, WorkerEvent, never>,
  WorkerError
>(FiberId.none)

Effect.runFork(
  Effect.scoped(
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
  ),
)

/**
 * Execute a worker operation and return a stream of events.
 * Operations are serialized (pool size 1) so only one runs at a time.
 */
export const execute = (
  input: WorkerInput,
): Stream.Stream<WorkerEvent, Error> =>
  Stream.unwrap(
    Deferred.await(poolInit).pipe(
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
