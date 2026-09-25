import { describe, it, expect } from "@effect/vitest"
import {
  MAX_WORKERS_ENV,
  onnxThreadsPerWorker,
  resolveWorkerCount,
  splitPools
} from "../src/worker/limits.js"

const GiB = 1024 * 1024 * 1024

describe("worker limits", () => {
  describe("resolveWorkerCount defaults", () => {
    it.each([
      { cores: 1, mem: 16 * GiB, expected: 1 },
      { cores: 2, mem: 16 * GiB, expected: 1 },
      { cores: 4, mem: 16 * GiB, expected: 3 },
      { cores: 8, mem: 16 * GiB, expected: 4 },
      { cores: 32, mem: 64 * GiB, expected: 4 }
    ])("uses cores - 1 capped at 4 ($cores cores)", ({ cores, mem, expected }) => {
      expect(resolveWorkerCount({ cores, totalMemBytes: mem })).toEqual({
        count: expected,
        source: "default"
      })
    })

    it.each([
      { mem: 1 * GiB, expected: 1 },
      { mem: 4 * GiB, expected: 2 },
      { mem: 6 * GiB, expected: 3 },
      { mem: 8 * GiB, expected: 4 }
    ])("limits by memory ($mem bytes on 32 cores)", ({ mem, expected }) => {
      expect(resolveWorkerCount({ cores: 32, totalMemBytes: mem }).count).toBe(expected)
    })

    it("treats nonsensical core counts as one core", () => {
      expect(resolveWorkerCount({ cores: 0, totalMemBytes: 16 * GiB }).count).toBe(1)
    })

    it("ignores an empty override", () => {
      expect(resolveWorkerCount({ cores: 8, totalMemBytes: 16 * GiB, override: " " })).toEqual({
        count: 4,
        source: "default"
      })
    })
  })

  describe("resolveWorkerCount override", () => {
    it("uses a valid override, even above the default cap", () => {
      expect(resolveWorkerCount({ cores: 16, totalMemBytes: 2 * GiB, override: "6" })).toEqual({
        count: 6,
        source: "override"
      })
    })

    it("clamps an override to the core count", () => {
      const result = resolveWorkerCount({ cores: 4, totalMemBytes: 16 * GiB, override: "64" })
      expect(result.count).toBe(4)
      expect(result.source).toBe("override")
      expect(result.warning).toContain("exceeds 4 available cores")
    })

    it.each(["0", "-2", "abc", "2.5", "3workers"])("ignores invalid override %s", (override) => {
      const result = resolveWorkerCount({ cores: 8, totalMemBytes: 16 * GiB, override })
      expect(result.count).toBe(4)
      expect(result.source).toBe("default")
      expect(result.warning).toContain(MAX_WORKERS_ENV)
    })
  })

  describe("splitPools", () => {
    it("shares a single worker between jobs and queries", () => {
      expect(splitPools(1)).toEqual({ jobs: 1, query: 0 })
    })

    it("reserves one worker for queries", () => {
      expect(splitPools(2)).toEqual({ jobs: 1, query: 1 })
      expect(splitPools(4)).toEqual({ jobs: 3, query: 1 })
    })
  })

  describe("onnxThreadsPerWorker", () => {
    it("divides cores between workers", () => {
      expect(onnxThreadsPerWorker(8, 4)).toBe(2)
      expect(onnxThreadsPerWorker(10, 4)).toBe(2)
    })

    it("never goes below one thread", () => {
      expect(onnxThreadsPerWorker(2, 4)).toBe(1)
      expect(onnxThreadsPerWorker(4, 0)).toBe(4)
    })
  })
})
