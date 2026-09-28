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
  const job = (status: Job["status"]) => ({ status }) as Job

  it("counts running jobs, and failed plus interrupted ones as failed", () => {
    expect(
      jobCounts([job("running"), job("running"), job("failed"), job("interrupted"), job("completed"), job("skipped")])
    ).toEqual({ running: 2, failed: 2 })
  })
})
