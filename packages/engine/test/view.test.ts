import { describe, expect, it } from "@effect/vitest"
import { DateTime } from "effect"
import { CloneFailedError, RemoteBranchMissingError } from "../src/jobs/errors.js"
import type { Job, Step, StepStatus } from "../src/jobs/Job.js"
import { jobFailed, jobFailureMessage, resumableJob, resumePoint, syncUpdated, unfinishedIndexing } from "../src/jobs/view.js"

const at = (ms: number) => DateTime.makeUnsafe(ms)

const step = (key: string, status: StepStatus, extra: Partial<Step> = {}): Step => ({
  key,
  name: key.split(":")[0] ?? key,
  runsOn: "worker",
  status,
  attempts: 1,
  ...extra
})

const fields = (status: Job["status"], steps: ReadonlyArray<Step>, createdAtMs: number, repoId: string) => ({
  id: `${repoId}-${createdAtMs}`,
  repoId,
  status,
  createdAt: at(createdAtMs),
  updatedAt: at(createdAtMs),
  steps
})

const sync = (status: Job["status"], steps: ReadonlyArray<Step>, createdAtMs = 0, repoId = "a"): Job => ({
  ...fields(status, steps, createdAtMs, repoId),
  kind: "syncRepo",
  payload: {}
})

const add = (status: Job["status"], steps: ReadonlyArray<Step>, createdAtMs = 0, repoId = "a"): Job => ({
  ...fields(status, steps, createdAtMs, repoId),
  kind: "addRepo",
  payload: { url: `https://github.com/acme/${repoId}` }
})

const reindex = (status: Job["status"], steps: ReadonlyArray<Step>, createdAtMs = 0, repoId = "a"): Job => ({
  ...fields(status, steps, createdAtMs, repoId),
  kind: "reindexRepo",
  payload: {}
})

describe("resumableJob", () => {
  it("resumes an interrupted sync, wherever it stopped", () => {
    const job = sync("interrupted", [step("fetch", "done"), step("resolveRemoteHead", "interrupted")])
    expect(resumableJob([job], "a")).toBe(job)
  })

  it.each(["deleteRemoved", "indexBatch:4", "finalizeIndex", "updateStore"])("resumes a sync that failed at %s", (key) => {
    const job = sync("failed", [step("planChanges", "done"), step(key, "failed")])
    expect(resumableJob([job], "a")).toBe(job)
  })

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

  it("finds an unfinished add or re-index for a sync to finish first", () => {
    const unfinishedAdd = add("interrupted", [step("indexBatch:69", "interrupted")])
    const unfinishedReindex = reindex("failed", [step("indexBatch:2", "failed")], 1)
    const syncing = sync("interrupted", [step("indexBatch:1", "interrupted")], 2)

    expect(unfinishedIndexing([unfinishedAdd, syncing], "a")).toBe(unfinishedAdd)
    expect(unfinishedIndexing([unfinishedReindex, syncing], "a")).toBe(unfinishedReindex)
    // Only adds and re-indexes: an unfinished sync is resumed by the sync itself
    expect(unfinishedIndexing([syncing], "a")).toBeUndefined()
    expect(unfinishedIndexing([unfinishedAdd], "b")).toBeUndefined()
  })

  it("doesn't count an add that was retried and finished", () => {
    const interrupted = add("interrupted", [step("indexBatch:1", "interrupted")], 0)
    const completed = add("completed", [step("recordSynced", "done")], 1)

    expect(unfinishedIndexing([interrupted, completed], "a")).toBeUndefined()
  })

  it("finds a re-index to resume only when asked for that kind", () => {
    const job = reindex("failed", [step("stampIndexFormat", "failed")])

    expect(resumableJob([job], "a", "reindexRepo")).toBe(job)
    expect(resumableJob([job], "a")).toBeUndefined()
  })
})

describe("resumePoint", () => {
  it("names the next batch once indexing has started", () => {
    const steps = [
      step("indexBatch", "done"),
      ...Array.from({ length: 87 }, (_, i) => step(`indexBatch:${i}`, i < 52 ? "done" : "pending"))
    ]
    expect(resumePoint(sync("interrupted", steps))).toBe("batch 53/87")
  })

  it("names the first unfinished step before indexing", () => {
    expect(resumePoint(sync("interrupted", [step("fetch", "done"), step("resetHard", "interrupted")]))).toBe("resetHard")
  })
})

describe("jobFailureMessage", () => {
  it("is the failed step's error title", () => {
    const error = new CloneFailedError({ repoId: "a", url: "u", reason: "auth", message: "denied" })
    expect(jobFailureMessage(add("failed", [step("clone", "failed", { error })]))).toBe(
      "Clone failed: authentication required"
    )
  })

  it("explains an interrupted job", () => {
    expect(jobFailureMessage(add("interrupted", [step("clone", "interrupted")]))).toBe("Stopped before it finished")
  })
})

describe("sync outcome", () => {
  const syncJob = (status: Job["status"], updateStore: StepStatus) =>
    sync(status, [step("loadRepo", "done"), step("updateStore", updateStore)])

  it("counts a sync as updated only when it recorded a new commit", () => {
    expect(syncUpdated(syncJob("completed", "done"))).toBe(true)
    // Up to date: the job ended early and skipped the rest
    expect(syncUpdated(syncJob("completed", "skipped"))).toBe(false)
    // Pinned
    expect(syncUpdated(syncJob("skipped", "skipped"))).toBe(false)
  })

  it("treats failed and interrupted jobs as failures", () => {
    expect(jobFailed(syncJob("failed", "pending"))).toBe(true)
    expect(jobFailed(syncJob("interrupted", "pending"))).toBe(true)
    expect(jobFailed(syncJob("skipped", "skipped"))).toBe(false)
    expect(jobFailed(syncJob("completed", "done"))).toBe(false)
  })
})
