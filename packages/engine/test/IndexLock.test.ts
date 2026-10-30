import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Ref } from "effect"
import { makeIndexLock } from "../src/jobs/IndexLock.js"

// Let forked fibers run up to their next suspension point
const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow
})

describe("IndexLock", () => {
  it.effect("runs writes side by side", () =>
    Effect.gen(function* () {
      const lock = yield* makeIndexLock
      const events = yield* Ref.make<ReadonlyArray<string>>([])
      const log = (event: string) => Ref.update(events, (e) => [...e, event])
      const release = yield* Deferred.make<void>()

      const write = (name: string) =>
        lock.write(log(`${name} start`).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(log(`${name} end`))))
      const a = yield* Effect.forkChild(write("a"))
      const b = yield* Effect.forkChild(write("b"))
      yield* settle

      expect(yield* Ref.get(events)).toEqual(["a start", "b start"])
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(a)
      yield* Fiber.join(b)
    }))

  it.effect("runs a finalize alone: after in-flight writes, before writes that arrive while it waits", () =>
    Effect.gen(function* () {
      const lock = yield* makeIndexLock
      const events = yield* Ref.make<ReadonlyArray<string>>([])
      const log = (event: string) => Ref.update(events, (e) => [...e, event])
      const releaseFirst = yield* Deferred.make<void>()

      const first = yield* Effect.forkChild(
        lock.write(log("first write").pipe(Effect.andThen(Deferred.await(releaseFirst))))
      )
      yield* settle
      const finalize = yield* Effect.forkChild(lock.exclusive(log("finalize")))
      yield* settle
      const later = yield* Effect.forkChild(lock.write(log("later write")))
      yield* settle

      // The finalize waits for the first write; the later write waits for the finalize
      expect(yield* Ref.get(events)).toEqual(["first write"])

      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(finalize)
      yield* Fiber.join(later)
      expect(yield* Ref.get(events)).toEqual(["first write", "finalize", "later write"])
    }))

  it.effect("can interrupt a write that is waiting for a finalize", () =>
    Effect.gen(function* () {
      const lock = yield* makeIndexLock
      const releaseFinalize = yield* Deferred.make<void>()
      const finalize = yield* Effect.forkChild(lock.exclusive(Deferred.await(releaseFinalize)))
      yield* settle

      const waiting = yield* Effect.forkChild(lock.write(Effect.void))
      yield* settle
      yield* Fiber.interrupt(waiting)

      yield* Deferred.succeed(releaseFinalize, undefined)
      yield* Fiber.join(finalize)
      // The lock still works after the interrupted write
      yield* lock.write(Effect.void)
    }))
})
