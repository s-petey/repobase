import type { Job } from "@repobase/engine"
import { DateTime } from "effect"
import { describe, expect, it } from "vitest"
import { formatAge, jobCounts } from "./jobView.js"

const at = (ms: number) => DateTime.makeUnsafe(ms)

describe("formatAge", () => {
  it.each([
    [0, "now"],
    [59_000, "now"],
    [5 * 60_000, "5m ago"],
    [3 * 3_600_000, "3h ago"],
    [2 * 86_400_000, "2d ago"]
  ])("%i ms later is %s", (elapsed, expected) => {
    expect(formatAge(at(0), at(elapsed))).toBe(expected)
  })
})

describe("jobCounts", () => {
  const job = (status: Job["status"], repoId: string, createdAtMs = 0, kind: Job["kind"] = "syncRepo") =>
    ({ status, repoId, kind, createdAt: at(createdAtMs) }) as Job

  it("counts running jobs, and failed plus interrupted ones as failed", () => {
    expect(
      jobCounts([
        job("running", "a"),
        job("running", "b"),
        job("failed", "c"),
        job("interrupted", "d"),
        job("completed", "e"),
        job("skipped", "f")
      ])
    ).toEqual({ running: 2, failed: 2 })
  })

  it("doesn't count a failure that a newer run of the same task completed", () => {
    expect(
      jobCounts([job("failed", "a", 0), job("interrupted", "a", 1), job("completed", "a", 2), job("failed", "b", 0)])
    ).toEqual({ running: 0, failed: 1 })
  })

  it("still counts a failure that is newer than the last success", () => {
    expect(jobCounts([job("completed", "a", 0), job("failed", "a", 1)])).toEqual({ running: 0, failed: 1 })
  })

  it("doesn't count a failed add once a newer sync of that repo completed", () => {
    expect(jobCounts([job("failed", "a", 0, "addRepo"), job("completed", "a", 1, "syncRepo")])).toEqual({
      running: 0,
      failed: 0
    })
  })
})
