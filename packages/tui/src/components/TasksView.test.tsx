import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import {
  IndexBatchFailedError,
  RemoteBranchMissingError,
  ResetFailedError,
  type Job,
  type Step,
  type StepStatus
} from "@repobase/engine"
import { DateTime } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { interact, teardown } from "../test/helpers.js"
import { TasksView } from "./TasksView.js"

const createdAt = DateTime.makeUnsafe(0)
const now = DateTime.makeUnsafe(5 * 60 * 1000)

const step = (key: string, status: StepStatus, extra: Partial<Step> = {}): Step => ({
  key,
  name: key.split(":")[0]!,
  runsOn: "worker",
  status,
  attempts: status === "pending" ? 0 : 1,
  ...extra
})

const syncJob = (steps: ReadonlyArray<Step>, status: Job["status"] = "failed"): Job => ({
  id: "syncRepo-Effect-TS-effect-1",
  kind: "syncRepo",
  repoId: "Effect-TS-effect",
  payload: {},
  status,
  createdAt,
  updatedAt: createdAt,
  steps
})

const renderModal = (
  jobs: ReadonlyArray<Job>,
  handlers: { onRetry?: () => Promise<void>; onDiscard?: () => Promise<void> } = {},
  size: { width: number; height: number } = { width: 140, height: 50 }
) =>
  testRender(
    <TasksView
      jobs={jobs}
      now={now}
      onRetry={handlers.onRetry ?? (async () => {})}
      onDiscard={handlers.onDiscard ?? (async () => {})}
      onClose={() => {}}
    />,
    size
  )

let setup: TestRendererSetup | undefined

afterEach(async () => {
  await teardown(setup)
  setup = undefined
})

describe("TasksView", () => {
  it("lists tasks as repo, status and age columns, with the selected task's heading on the right", async () => {
    setup = await renderModal([syncJob([step("loadRepo", "done")])])
    await interact(setup, () => {})
    const frame = setup.captureCharFrame()

    expect(frame).toContain("1 task")
    expect(frame).toMatch(/> Effect-TS-effect\s+failed\s+5m ago/)
    expect(frame).toContain("sync Effect-TS-effect · failed")
  })

  it("keeps a long error inside the details pane and the key help intact", async () => {
    const detail = Array.from({ length: 40 }, (_, i) => `fatal: line ${i} of a very long git error message`).join("\n")
    setup = await renderModal(
      [
        syncJob([
          step("fetch", "failed", {
            error: new ResetFailedError({ repoId: "Effect-TS-effect", ref: "origin/main", message: detail })
          })
        ])
      ],
      {},
      { width: 120, height: 24 }
    )
    await interact(setup, () => {})
    const frame = setup.captureCharFrame()

    expect(frame).toContain("[x] Discard  [Up/k] [Down/j] Select  [PgUp/PgDn] Scroll details  [Esc/q] Back")
    expect(frame).toMatch(/> Effect-TS-effect\s+failed\s+5m ago/)
    expect(frame).not.toContain("line 39 of a very long")
  })

  it("scrolls the details pane with PgDn", async () => {
    const detail = Array.from({ length: 40 }, (_, i) => `fatal: line ${i}`).join("\n")
    setup = await renderModal(
      [
        syncJob([
          step("fetch", "failed", {
            error: new ResetFailedError({ repoId: "Effect-TS-effect", ref: "origin/main", message: detail })
          })
        ])
      ],
      {},
      { width: 120, height: 24 }
    )
    await interact(setup, () => {})
    expect(setup.captureCharFrame()).not.toContain("fatal: line 20")

    // The escape sequence a terminal sends for PageDown (there's no KeyCodes entry for it)
    const pageDown = "\u001B[6~"
    await interact(setup, () => setup!.mockInput.pressKey(pageDown))
    await interact(setup, () => setup!.mockInput.pressKey(pageDown))
    expect(setup.captureCharFrame()).toContain("fatal: line 20")
  })

  it("keeps the selected task in view in a long list", async () => {
    const jobs = Array.from({ length: 40 }, (_, i) => ({
      ...syncJob([step("loadRepo", "done")], "completed"),
      id: `syncRepo-repo-${i}`,
      repoId: `acme-repo-${String(i).padStart(2, "0")}`
    }))
    setup = await renderModal(jobs, {}, { width: 120, height: 24 })
    await interact(setup, () => {})

    for (let i = 0; i < 25; i++) {
      await interact(setup, () => setup!.mockInput.pressArrow("down"))
    }
    expect(setup.captureCharFrame()).toContain("> acme-repo-25")
  })

  it("renders each step status with its icon", async () => {
    setup = await renderModal([
      syncJob([
        step("loadRepo", "done"),
        step("fetch", "interrupted"),
        step("diff", "running"),
        step("planChanges", "pending"),
        step("updateStore", "skipped")
      ])
    ])
    await interact(setup, () => {})
    const frame = setup.captureCharFrame()

    expect(frame).toContain("✓ loadRepo")
    expect(frame).toContain("! fetch")
    expect(frame).toContain("◌ diff")
    expect(frame).toContain("· planChanges")
    expect(frame).toContain("- updateStore")
  })

  it("shows a failed step with its error title, detail and hint", async () => {
    setup = await renderModal([
      syncJob([
        step("resetHard", "failed", {
          error: new ResetFailedError({ repoId: "Effect-TS-effect", ref: "abc1234", message: "index.lock exists" })
        })
      ])
    ])
    await interact(setup, () => {})
    const frame = setup.captureCharFrame()

    expect(frame).toContain("✗ resetHard")
    expect(frame).toContain("Could not update the working tree to abc1234")
    expect(frame).toContain("index.lock exists")
    expect(frame).toContain("Hint: Check for local changes")
  })

  it("collapses batch steps into one line with done and failed counts", async () => {
    const batches = Array.from({ length: 40 }, (_, i) =>
      step(`indexBatch:${i}`, i < 12 ? "done" : i < 14 ? "failed" : "pending", {
        error:
          i === 12
            ? new IndexBatchFailedError({ repoId: "Effect-TS-effect", batch: 12, total: 40, phase: "embed", message: "onnx error" })
            : undefined
      })
    )
    setup = await renderModal([syncJob([step("indexBatch", "done"), ...batches])])
    await interact(setup, () => {})
    const frame = setup.captureCharFrame()

    expect(frame).toContain("✗ indexBatch 12/40 (2 failed)")
    expect(frame).toContain("Indexing batch 13/40 failed while embedding")
    expect(frame).not.toContain("indexBatch:")
  })

  it("retries a retryable task with r and discards with x", async () => {
    const onRetry = vi.fn(async () => {})
    const onDiscard = vi.fn(async () => {})
    const job = syncJob([step("fetch", "interrupted")], "interrupted")
    setup = await renderModal([job], { onRetry, onDiscard })
    await interact(setup, () => {})
    expect(setup.captureCharFrame()).toContain("[r] Retry  [x] Discard")

    await interact(setup, () => setup!.mockInput.pressKey("r"))
    expect(onRetry).toHaveBeenCalledWith(job.id)

    await interact(setup, () => setup!.mockInput.pressKey("x"))
    expect(onDiscard).toHaveBeenCalledWith(job.id)
  })

  it("disables retry for a non-retryable error and shows its hint instead", async () => {
    const onRetry = vi.fn(async () => {})
    setup = await renderModal(
      [
        syncJob([
          step("remoteHead", "failed", {
            error: new RemoteBranchMissingError({ repoId: "Effect-TS-effect", branch: "gone", message: "unknown revision" })
          })
        ])
      ],
      { onRetry }
    )
    await interact(setup, () => {})
    expect(setup.captureCharFrame()).toContain("[r] Retry (unavailable)")

    await interact(setup, () => setup!.mockInput.pressKey("r"))
    expect(onRetry).not.toHaveBeenCalled()
    expect(setup.captureCharFrame()).toContain("Discard this job and track a different branch")
  })

  it("shows the error when a retry is rejected", async () => {
    setup = await renderModal([syncJob([step("fetch", "failed")])], {
      onRetry: async () => {
        throw new Error("A job for Effect-TS-effect is already running")
      }
    })
    await interact(setup, () => {})

    await interact(setup, () => setup!.mockInput.pressKey("r"))
    expect(setup.captureCharFrame()).toContain("Error: A job for Effect-TS-effect is already running")
  })
})
