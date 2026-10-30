import { describe, expect, it } from "vitest"
import { summarizeLag } from "./lagSampler.js"

describe("summarizeLag", () => {
  it("reports the max, 95th percentile and ticks over the 50ms budget", () => {
    const lags = [...Array.from({ length: 95 }, () => 2), 40, 60, 75, 120, 300]
    expect(summarizeLag(lags)).toEqual({ samples: 100, maxMs: 300, p95Ms: 40, overBudget: 4 })
  })

  it("handles an empty window", () => {
    expect(summarizeLag([])).toEqual({ samples: 0, maxMs: 0, p95Ms: 0, overBudget: 0 })
  })
})
