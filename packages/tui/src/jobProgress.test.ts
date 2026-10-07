import { describe, expect, it } from "vitest"
import { DateTime } from "effect"
import { CloneFailedError, trackingMode, type Job, type Step } from "@repobase/engine"
import { addRepoProgress, jobFailed, jobFailureMessage, syncUpdated } from "./jobProgress.js"

const now = DateTime.makeUnsafe("2026-09-25T10:00:00Z")

const names = [
  "checkAbsent",
  "clone",
  "resolveHead",
  "saveConfig",
  "planFullIndex",
  "deleteRemoved",
  "indexBatch",
  "finalizeIndex"
]

// An addRepo job whose steps before `running` are done
const jobAt = (running: string | undefined, status: Job["status"] = "running", extra: Partial<Step> = {}): Job => {
  const at = running ? names.indexOf(running) : names.length
  return {
    id: "addRepo-acme-widgets-1",
    kind: "addRepo",
    repoId: "acme-widgets",
    payload: { url: "https://github.com/acme/widgets", mode: trackingMode("main") },
    status,
    createdAt: now,
    updatedAt: now,
    steps: names.map((name, i): Step => ({
      key: name,
      name,
      runsOn: "worker",
      status: i < at ? "done" : i === at ? "running" : "pending",
      attempts: i <= at ? 1 : 0,
      ...(i === at ? extra : {})
    }))
  }
}

describe("addRepoProgress", () => {
  it("shows cloning with the URL", () => {
    expect(addRepoProgress(jobAt("clone"))).toEqual({
      stage: "cloning",
      progress: 10,
      message: "Cloning https://github.com/acme/widgets..."
    })
  })

  it("moves through preparing and scanning", () => {
    expect(addRepoProgress(jobAt("saveConfig"))).toMatchObject({ stage: "cloning", progress: 40 })
    expect(addRepoProgress(jobAt("planFullIndex"))).toMatchObject({ stage: "indexing", progress: 50 })
  })

  it("fills 50-95% from per-file progress while indexing", () => {
    const batches = new Map<number, string>()
    const start = addRepoProgress(jobAt("indexBatch"), { filesStarted: 0, totalFiles: 200, batches })
    const half = addRepoProgress(jobAt("indexBatch"), {
      filesStarted: 100,
      totalFiles: 200,
      currentFile: "src/a.ts",
      batches
    })
    const end = addRepoProgress(jobAt("indexBatch"), { filesStarted: 200, totalFiles: 200, batches })

    expect(start.progress).toBe(50)
    expect(half).toEqual({
      stage: "indexing",
      progress: 73,
      message: "Indexing: src/a.ts",
      currentFile: "src/a.ts",
      filesIndexed: 100,
      totalFiles: 200
    })
    expect(end.progress).toBe(95)
  })

  it("finalizes at 95% and completes at 100%", () => {
    expect(addRepoProgress(jobAt("finalizeIndex"))).toMatchObject({ progress: 95, message: "Finalizing index..." })
    expect(addRepoProgress(jobAt(undefined, "completed"))).toEqual({
      stage: "complete",
      progress: 100,
      message: "Added acme-widgets"
    })
  })

  it("shows the failed step's bespoke message", () => {
    const failed = jobAt("clone", "failed", {
      status: "failed",
      error: new CloneFailedError({ repoId: "acme-widgets", url: "u", reason: "auth", message: "denied" })
    })

    expect(addRepoProgress(failed)).toEqual({
      stage: "error",
      progress: 0,
      message: "Clone failed: authentication required"
    })
    expect(jobFailureMessage(failed)).toBe("Clone failed: authentication required")
  })

  it("explains an interrupted job", () => {
    expect(jobFailureMessage(jobAt("clone", "interrupted"))).toBe("Stopped before it finished")
  })
})

describe("sync outcome", () => {
  const syncJob = (status: Job["status"], updateStore: Step["status"]): Job => ({
    id: "syncRepo-acme-widgets-1",
    kind: "syncRepo",
    repoId: "acme-widgets",
    payload: {},
    status,
    createdAt: now,
    updatedAt: now,
    steps: [
      { key: "loadRepo", name: "loadRepo", runsOn: "main", status: "done", attempts: 1 },
      { key: "updateStore", name: "updateStore", runsOn: "main", status: updateStore, attempts: 1 }
    ]
  })

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
