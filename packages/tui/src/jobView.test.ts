import type { Job } from "@repobase/engine"
import { DateTime } from "effect"
import { describe, expect, it } from "vitest"
import { RemoteBranchMissingError, type Step } from "@repobase/engine"
import { formatAge, jobCounts, resumableJob, resumePoint, syncActivityText } from "./jobView.js"

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

describe("resumableJob", () => {
  const step = (key: string, status: Step["status"], extra: Partial<Step> = {}): Step =>
    ({ key, name: key.split(":")[0]!, runsOn: "worker", status, attempts: 1, ...extra }) as Step
  const sync = (status: Job["status"], steps: ReadonlyArray<Step>, createdAtMs = 0, repoId = "a") =>
    ({ id: `sync-${repoId}-${createdAtMs}`, kind: "syncRepo", repoId, status, createdAt: at(createdAtMs), steps }) as Job

  it("resumes an interrupted sync, wherever it stopped", () => {
    const job = sync("interrupted", [step("fetch", "done"), step("resolveRemoteHead", "interrupted")])
    expect(resumableJob([job], "a")).toBe(job)
  })

  it.each(["deleteRemoved", "indexBatch:4", "finalizeIndex", "updateStore"])(
    "resumes a sync that failed at %s",
    (key) => {
      const job = sync("failed", [step("planChanges", "done"), step(key, "failed")])
      expect(resumableJob([job], "a")).toBe(job)
    }
  )

  it.each(["loadRepo", "fetch", "resolveRemoteHead", "resetHard", "planChanges"])(
    "starts over after a failure at %s, before indexing",
    (key) => {
      expect(resumableJob([sync("failed", [step(key, "failed")])], "a")).toBeUndefined()
    }
  )

  it("starts over when the failure can't be fixed by retrying", () => {
    const error = new RemoteBranchMissingError({ repoId: "a", branch: "gone", message: "unknown revision" })
    expect(resumableJob([sync("failed", [step("updateStore", "failed", { error })])], "a")).toBeUndefined()
  })

  it("only looks at the repo's latest sync", () => {
    const interrupted = sync("interrupted", [step("indexBatch:1", "interrupted")], 0)
    const completed = sync("completed", [step("updateStore", "done")], 1)
    expect(resumableJob([interrupted, completed], "a")).toBeUndefined()
    expect(resumableJob([interrupted], "b")).toBeUndefined()
  })

  it("finds a re-index to resume only when asked for that kind", () => {
    const reindex = { ...sync("failed", [step("stampIndexFormat", "failed")]), kind: "reindexRepo" } as Job

    expect(resumableJob([reindex], "a", "reindexRepo")).toBe(reindex)
    expect(resumableJob([reindex], "a")).toBeUndefined()
  })
})

describe("resumePoint", () => {
  const step = (key: string, status: Step["status"]): Step =>
    ({ key, name: key.split(":")[0]!, runsOn: "worker", status, attempts: 1 }) as Step

  it("names the next batch once indexing has started", () => {
    const steps = [
      step("indexBatch", "done"),
      ...Array.from({ length: 87 }, (_, i) => step(`indexBatch:${i}`, i < 52 ? "done" : "pending"))
    ]
    expect(resumePoint({ steps } as unknown as Job)).toBe("batch 53/87")
  })

  it("names the first unfinished step before indexing", () => {
    expect(resumePoint({ steps: [step("fetch", "done"), step("resetHard", "interrupted")] } as unknown as Job)).toBe(
      "resetHard"
    )
  })
})

describe("syncActivityText", () => {
  const job = (status: Job["status"], createdAtMs: number, kind: Job["kind"] = "syncRepo") =>
    ({ status, kind, repoId: "a", createdAt: at(createdAtMs) }) as Job

  it("names the repo for a single sync", () => {
    expect(syncActivityText({ kind: "one", repoId: "acme-widgets" }, [], 3)).toBe(
      "Syncing acme-widgets · up to 3 workers"
    )
  })

  it("counts Sync All's finished syncs, ignoring jobs from before it started and adds", () => {
    const jobs = [
      job("completed", 500), // before this Sync All
      job("completed", 1_000),
      job("failed", 1_200),
      job("running", 1_300),
      job("completed", 1_400, "addRepo")
    ]
    expect(syncActivityText({ kind: "all", since: at(1_000), total: 7 }, jobs, 1)).toBe(
      "Syncing 2/7 repos · up to 1 worker"
    )
  })

  it("leaves out the worker limit when it isn't known", () => {
    expect(syncActivityText({ kind: "all", since: at(0), total: 2 }, [])).toBe("Syncing 0/2 repos")
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
