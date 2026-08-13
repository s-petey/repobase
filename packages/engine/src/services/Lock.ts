import { FileSystem } from "@effect/platform"
import { Effect } from "effect"
import { dirname } from "node:path"
import * as properLockfile from "proper-lockfile"
import { LockError } from "../errors.js"

export interface LockRetryOptions {
  readonly retries?: number
  readonly factor?: number
  readonly minTimeout?: number
  readonly maxTimeout?: number
}

export interface LockOptions {
  readonly staleMs?: number
  readonly updateMs?: number
  readonly retries?: LockRetryOptions
}

const DEFAULT_STALE_MS = 10_000

const DEFAULT_RETRIES: LockRetryOptions = {
  retries: 20,
  factor: 1.5,
  minTimeout: 50,
  maxTimeout: 500,
}

const toLockError =
  (targetPath: string) =>
  (error: unknown): LockError =>
    new LockError({
      targetPath,
      message: error instanceof Error ? error.message : String(error),
    })

/**
 * Run an effect while holding an exclusive lock on `targetPath`.
 *
 * Uses the atomic-mkdir lockfile strategy via `proper-lockfile`, which is
 * safe across worker threads and processes. The lock is refreshed
 * periodically and always released when the effect completes, fails, or is
 * interrupted.
 */
export const withLock = (
  fs: FileSystem.FileSystem,
  targetPath: string,
  options: LockOptions = {}
) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, LockError | E, R> =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        yield* fs
          .makeDirectory(dirname(targetPath), { recursive: true })
          .pipe(Effect.ignore)

        const staleMs = options.staleMs ?? DEFAULT_STALE_MS

        return yield* Effect.tryPromise({
          try: () =>
            properLockfile.lock(targetPath, {
              realpath: false,
              stale: staleMs,
              update: options.updateMs ?? Math.floor(staleMs / 2),
              retries: options.retries ?? DEFAULT_RETRIES,
            }),
          catch: toLockError(targetPath),
        })
      }),
      () => effect,
      (release) =>
        Effect.tryPromise({
          try: () => release(),
          catch: toLockError(targetPath),
        }).pipe(Effect.ignore)
    )
