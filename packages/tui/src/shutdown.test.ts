import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { deadlineNotice, shutdown, stoppingNotice } from "./shutdown.js"

const recorder = () => {
  const events: Array<string> = []
  return {
    events,
    notice: (message: string) => {
      events.push(`notice: ${message}`)
    },
    exit: (code: number) => {
      events.push(`exit ${code}`)
    }
  }
}

describe("shutdown", () => {
  it.effect("interrupts the running jobs, then exits with the code", () => {
    const r = recorder()
    const interruptJobs = Effect.sync(() => {
      r.events.push("interrupt jobs")
    })
    return Effect.gen(function* () {
      yield* shutdown({ running: 2, interruptJobs, notice: r.notice, exit: r.exit, code: 0 })

      expect(r.events).toEqual([`notice: ${stoppingNotice(2)}`, "interrupt jobs", "exit 0"])
      expect(stoppingNotice(2)).toContain("2 running tasks")
    })
  })

  it.effect("exits without a notice when nothing is running", () => {
    const r = recorder()
    return Effect.gen(function* () {
      yield* shutdown({ running: 0, interruptJobs: Effect.void, notice: r.notice, exit: r.exit, code: 130 })

      expect(r.events).toEqual(["exit 130"])
    })
  })

  it.effect("exits after the deadline when the jobs don't stop, even as a finalizer", () => {
    const r = recorder()
    return Effect.gen(function* () {
      // Finalizers run uninterruptibly; the deadline must still apply there
      const fiber = yield* shutdown({ running: 1, interruptJobs: Effect.never, notice: r.notice, exit: r.exit, code: 0 }).pipe(
        Effect.uninterruptible,
        Effect.forkChild
      )
      yield* TestClock.adjust("2999 millis")
      expect(r.events).toEqual([`notice: ${stoppingNotice(1)}`])

      yield* TestClock.adjust("1 millis")
      yield* Fiber.join(fiber)
      expect(r.events).toEqual([`notice: ${stoppingNotice(1)}`, `notice: ${deadlineNotice}`, "exit 0"])
    })
  })
})
