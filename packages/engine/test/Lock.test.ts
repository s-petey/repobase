import { FileSystem } from "@effect/platform"
import { BunFileSystem } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import * as properLockfile from "proper-lockfile"
import { withLock } from "../src/services/Lock.js"

const check = (target: string): Effect.Effect<boolean, unknown, never> =>
  Effect.tryPromise(() => properLockfile.check(target, { realpath: false }))

describe("withLock", () => {
  it.effect("acquires the lock and releases it when done", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const temp = yield* fs.makeTempDirectoryScoped()
      const target = `${temp}/config.json`

      expect(yield* check(target)).toBe(false)

      const result = yield* withLock(fs, target)(
        Effect.gen(function* () {
          expect(yield* check(target)).toBe(true)
          return "done"
        })
      )

      expect(result).toBe("done")
      expect(yield* check(target)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer))
  )

  it.effect("releases the lock when the effect fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const temp = yield* fs.makeTempDirectoryScoped()
      const target = `${temp}/config.json`

      const outcome = yield* withLock(fs, target)(
        Effect.fail("boom")
      ).pipe(Effect.exit)

      expect(outcome._tag).toBe("Failure")
      expect(yield* check(target)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer))
  )

  it.effect("serializes concurrent critical sections", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const temp = yield* fs.makeTempDirectoryScoped()
      const target = `${temp}/config.json`

      const active = yield* Ref.make(0)
      const maxActive = yield* Ref.make(0)

      const critical = withLock(fs, target)(
        Effect.gen(function* () {
          const now = yield* Ref.updateAndGet(active, (n) => n + 1)
          yield* Ref.update(maxActive, (m) => Math.max(m, now))
          yield* Effect.tryPromise(
            () => new Promise((resolve) => setTimeout(resolve, 50))
          )
          yield* Ref.update(active, (n) => n - 1)
        })
      )

      yield* Effect.all(
        Array.from({ length: 6 }, () => critical),
        { concurrency: "unbounded" }
      )

      const max = yield* Ref.get(maxActive)
      expect(max).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer))
  )

  it.effect("takes over a stale lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const temp = yield* fs.makeTempDirectoryScoped()
      const target = `${temp}/config.json`
      const lockPath = `${target}.lock`

      // Simulate a crashed process leaving a stale lock behind
      yield* fs.makeDirectory(lockPath, { recursive: true })
      const old = new Date(Date.now() - 60_000)
      yield* fs.utimes(lockPath, old, old)

      const result = yield* withLock(fs, target, { staleMs: 1000 })(
        Effect.succeed("acquired")
      )

      expect(result).toBe("acquired")
      expect(yield* check(target)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer))
  )
})
