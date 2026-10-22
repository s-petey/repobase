import { RGBA } from "@opentui/core"
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
import { Profiler, useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { interact, teardown } from "../test/helpers.js"
import { colors } from "../theme/index.js"
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

describe("TasksView live progress", () => {
  const running = (id: string): Job => ({
    ...syncJob([step("indexBatch:0", "done"), step("indexBatch:1", "running"), step("indexBatch:2", "running")], "running"),
    id
  })

  it("shows a running task's file count and the file each running batch is on", async () => {
    const job = running("sync-1")
    const progress = new Map([
      [job.id, { filesStarted: 812, totalFiles: 3410, currentFile: "b.ts", batches: new Map([[2, "src/b.ts"], [1, "src/a.ts"]]) }]
    ])
    setup = await testRender(
      <TasksView
        jobs={[job]}
        onProgressChange={(listener) => {
          listener(progress)
          return () => {}
        }}
        now={now}
        onRetry={async () => {}}
        onDiscard={async () => {}}
        onClose={() => {}}
      />,
      { width: 140, height: 30 }
    )
    await interact(setup, () => {})
    const lines = setup.captureCharFrame().split("\n")
    const lineOf = (text: string) => lines.findIndex((l) => l.includes(text))

    expect(lineOf("Indexing 812 / 3,410 files")).toBeGreaterThan(-1)
    // In batch order, under the count
    expect(lineOf("batch 2/3      src/a.ts")).toBeGreaterThan(lineOf("Indexing 812"))
    expect(lineOf("batch 3/3      src/b.ts")).toBeGreaterThan(lineOf("batch 2/3      src/a.ts"))
  })

  it("shows nothing extra for a task that isn't running", async () => {
    const job = syncJob([step("indexBatch:0", "failed")])
    setup = await testRender(
      <TasksView
        jobs={[job]}
        onProgressChange={(listener) => {
          listener(new Map([[job.id, { filesStarted: 1, totalFiles: 2, batches: new Map([[0, "src/a.ts"]]) }]]))
          return () => {}
        }}
        now={now}
        onRetry={async () => {}}
        onDiscard={async () => {}}
        onClose={() => {}}
      />,
      { width: 140, height: 30 }
    )
    await interact(setup, () => {})

    expect(setup.captureCharFrame()).not.toContain("Indexing 1 / 2 files")
  })
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

  it("lines up the status and age columns whatever the age reads", async () => {
    const recent = { ...syncJob([step("loadRepo", "done")]), id: "recent", repoId: "acme-recent" }
    const old = {
      ...syncJob([step("loadRepo", "done")], "interrupted"),
      id: "old",
      repoId: "acme-old",
      updatedAt: DateTime.subtract(now, { days: 1 })
    }
    setup = await renderModal([recent, old])
    await interact(setup, () => {})
    const rows = setup.captureCharFrame().split("\n")
    const row = (repoId: string) => rows.find((line) => line.includes(repoId))!

    expect(row("acme-old")).toContain("yesterday")
    expect(row("acme-old").indexOf("interrupted")).toBe(row("acme-recent").indexOf("failed"))
    expect(row("acme-old").indexOf("yesterday") + "yesterday".length).toBe(
      row("acme-recent").indexOf("5m ago") + "5m ago".length
    )
  })

  describe("when the task list changes under the cursor", () => {
    const task = (id: string) => ({ ...syncJob([step("loadRepo", "done")]), id, repoId: `acme-${id}` })
    let setJobs: (jobs: ReadonlyArray<Job>) => void = () => {}
    const Harness = ({ initial, onDiscard }: { initial: ReadonlyArray<Job>; onDiscard: (jobId: string) => Promise<void> }) => {
      const [jobs, set] = useState(initial)
      setJobs = set
      return <TasksView jobs={jobs} now={now} onRetry={async () => {}} onDiscard={onDiscard} onClose={() => {}} />
    }

    it("keeps the selected task when a newer one is listed above it", async () => {
      const onDiscard = vi.fn(async () => {})
      const [a, b, c] = [task("a"), task("b"), task("c")]
      setup = await testRender(<Harness initial={[a, b, c]} onDiscard={onDiscard} />, { width: 140, height: 50 })
      await interact(setup, () => setup?.mockInput.pressKey("j"))
      await interact(setup, () => setup?.mockInput.pressKey("j"))

      await interact(setup, () => setJobs([task("new"), a, b, c]))
      expect(setup.captureCharFrame()).toContain("> acme-c")

      await interact(setup, () => setup?.mockInput.pressKey("x"))
      expect(onDiscard).toHaveBeenCalledWith("c")
    })

    it("follows the selected task in the same commit that changes the list", async () => {
      const onDiscard = vi.fn(async () => {})
      const [a, b, c] = [task("a"), task("b"), task("c")]
      let commits = 0
      setup = await testRender(
        <Profiler id="tasks" onRender={() => commits++}>
          <Harness initial={[a, b, c]} onDiscard={onDiscard} />
        </Profiler>,
        { width: 140, height: 50 }
      )
      await interact(setup, () => setup?.mockInput.pressKey("j"))

      commits = 0
      await interact(setup, () => setJobs([task("new"), a, b, c]))
      expect(commits).toBe(1)

      commits = 0
      await interact(setup, () => setJobs([task("new"), a, c]))
      expect(commits).toBe(1)
    })

    it("moves to the task now in its place when the selected one goes", async () => {
      const onDiscard = vi.fn(async () => {})
      const [a, b, c] = [task("a"), task("b"), task("c")]
      setup = await testRender(<Harness initial={[a, b, c]} onDiscard={onDiscard} />, { width: 140, height: 50 })
      await interact(setup, () => setup?.mockInput.pressKey("j"))

      await interact(setup, () => setJobs([a, c]))
      expect(setup.captureCharFrame()).toContain("> acme-c")

      await interact(setup, () => setJobs([task("new"), a, c]))
      await interact(setup, () => setup?.mockInput.pressKey("x"))
      expect(onDiscard).toHaveBeenCalledWith("c")
    })
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

    expect(frame).toContain("[x] Discard  [j/k] Select  [l] Steps  [Esc/q] Close")
    expect(frame).toMatch(/> Effect-TS-effect\s+failed\s+5m ago/)
    expect(frame).not.toContain("line 39 of a very long")
  })

  it("scrolls the details pane with PgDn", async () => {
    const steps = Array.from({ length: 40 }, (_, i) => step(`step${i}`, "done"))
    setup = await renderModal([syncJob(steps)], {}, { width: 120, height: 24 })
    await interact(setup, () => {})
    expect(setup.captureCharFrame()).not.toContain("✓ step20")

    // The escape sequence a terminal sends for PageDown (there's no KeyCodes entry for it)
    const pageDown = "\u001B[6~"
    await interact(setup, () => setup!.mockInput.pressKey(pageDown))
    await interact(setup, () => setup!.mockInput.pressKey(pageDown))
    expect(setup.captureCharFrame()).toContain("✓ step20")
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

  it("shows a failed step's error title in the list, and its detail and hint once opened", async () => {
    setup = await renderModal([
      syncJob([
        step("resetHard", "failed", {
          error: new ResetFailedError({ repoId: "Effect-TS-effect", ref: "abc1234", message: "index.lock exists" })
        })
      ])
    ])
    await interact(setup, () => {})
    let frame = setup.captureCharFrame()
    expect(frame).toContain("✗ resetHard")
    expect(frame).toContain("Could not update the working tree to abc1234")
    expect(frame).not.toContain("index.lock exists")

    await interact(setup, () => setup!.mockInput.pressKey("l"))
    await interact(setup, () => setup!.mockInput.pressKey("l"))
    frame = setup.captureCharFrame()
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

  it("shows a superseded task as superseded, and doesn't retry it", async () => {
    const onRetry = vi.fn(async () => {})
    setup = await renderModal(
      [{ ...syncJob([step("fetch", "interrupted")], "interrupted"), supersededBy: "syncRepo-Effect-TS-effect-2" }],
      { onRetry }
    )
    await interact(setup, () => {})
    const frame = setup.captureCharFrame()

    expect(frame).toMatch(/> Effect-TS-effect\s+superseded\s+5m ago/)
    expect(frame).toContain("sync Effect-TS-effect · superseded")
    expect(frame).toContain("[r] Retry (unavailable)")

    await interact(setup, () => setup!.mockInput.pressKey("r"))
    expect(onRetry).not.toHaveBeenCalled()
    expect(setup.captureCharFrame()).toContain("A newer task replaced this one")
  })

  describe("levels", () => {
    const longError = (lines: number) =>
      syncJob([
        step("fetch", "failed", {
          error: new ResetFailedError({
            repoId: "Effect-TS-effect",
            ref: "origin/main",
            message: Array.from({ length: lines }, (_, i) => `fatal: line ${i}`).join("\n")
          })
        })
      ])
    const manyJobs = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        ...syncJob([step("loadRepo", "done")], "completed"),
        id: `syncRepo-repo-${i}`,
        repoId: `acme-repo-${String(i).padStart(2, "0")}`
      }))

    // Whether the list pane's and the detail pane's borders use the focus color
    const focused = (s: TestRendererSetup) => {
      const focusColor = RGBA.fromHex(colors.status.info.default)
      const corners = s
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .filter((span) => span.text.includes("┌"))
      return { list: focusColor.equals(corners[0]!.fg), detail: focusColor.equals(corners[1]!.fg) }
    }

    const press = (key: string, times = 1) =>
      Array.from({ length: times }).reduce<Promise<void>>(
        (done) => done.then(() => interact(setup!, () => setup!.mockInput.pressKey(key))),
        Promise.resolve()
      )

    it("moves between the task list and the steps with h/l and the arrows", async () => {
      setup = await renderModal([syncJob([step("loadRepo", "done")])])
      await interact(setup, () => {})
      expect(focused(setup)).toEqual({ list: true, detail: false })
      expect(setup.captureCharFrame()).toContain("[j/k] Select  [l] Steps")

      await press("l")
      expect(focused(setup)).toEqual({ list: false, detail: true })
      expect(setup.captureCharFrame()).toContain("[j/k] Step  [h] Tasks")

      await press("h")
      expect(focused(setup)).toEqual({ list: true, detail: false })
      await interact(setup, () => setup!.mockInput.pressArrow("right"))
      expect(focused(setup)).toEqual({ list: false, detail: true })
      await interact(setup, () => setup!.mockInput.pressArrow("left"))
      expect(focused(setup)).toEqual({ list: true, detail: false })
    })

    it("steps through the checklist with j/k, keeping the cursor in view, and leaves the task selected", async () => {
      const steps = Array.from({ length: 40 }, (_, i) => step(`step${i}`, "done"))
      setup = await renderModal([syncJob(steps), ...manyJobs(3)], {}, { width: 120, height: 24 })
      await interact(setup, () => {})

      await press("l")
      expect(setup.captureCharFrame()).toContain("> ✓ step0")
      await press("j", 25)
      let frame = setup.captureCharFrame()
      expect(frame).toContain("> ✓ step25")
      expect(frame).toMatch(/> Effect-TS-effect/)

      await press("g")
      expect(setup.captureCharFrame()).toContain("> ✓ step0")
      await interact(setup, () => setup!.mockInput.pressKey("g", { shift: true }))
      frame = setup.captureCharFrame()
      expect(frame).toContain("> ✓ step39")
    })

    it("opens a step's error with l, scrolls it with j/k and G/g, and goes back with h", async () => {
      setup = await renderModal(
        [syncJob([step("loadRepo", "done"), ...longError(40).steps, step("planChanges", "pending")])],
        {},
        { width: 120, height: 30 }
      )
      await interact(setup, () => {})
      const frame = setup.captureCharFrame()
      expect(frame).not.toContain("fatal: line 0")
      expect(frame).toContain("· planChanges")

      await press("l")
      const lines = setup.captureCharFrame().split("\n")
      expect(lines.find((line) => line.includes("✓ loadRepo"))).not.toContain("›")
      expect(lines.find((line) => line.includes("✗ fetch"))).toContain("✗ fetch ›")
      expect(lines.find((line) => line.includes("· planChanges"))).not.toContain("›")
      expect(setup.captureCharFrame()).toContain("[j/k] Step  [h] Tasks")

      await press("j")
      expect(setup.captureCharFrame()).toContain("[j/k] Step  [l] Details  [h] Tasks")
      await press("l")
      expect(setup.captureCharFrame()).toContain("fetch")
      expect(setup.captureCharFrame()).toContain("fatal: line 0")
      expect(setup.captureCharFrame()).toContain("[j/k] Scroll  [g/G] Top/Bottom  [PgUp/PgDn] Page  [h] Back")

      await press("j", 20)
      expect(setup.captureCharFrame()).toContain("fatal: line 20")
      await interact(setup, () => setup!.mockInput.pressKey("g", { shift: true }))
      expect(setup.captureCharFrame()).toContain("fatal: line 39")
      await press("g")
      expect(setup.captureCharFrame()).not.toContain("fatal: line 39")

      await press("h")
      expect(setup.captureCharFrame()).toContain("> ✗ fetch")
      expect(setup.captureCharFrame()).not.toContain("fatal: line 0")
    })

    it("does nothing on l for a step without details", async () => {
      setup = await renderModal([syncJob([step("loadRepo", "done")])])
      await interact(setup, () => {})

      await press("l", 2)
      expect(setup.captureCharFrame()).toContain("> ✓ loadRepo")
      expect(setup.captureCharFrame()).toContain("[j/k] Step  [h] Tasks")
    })

    const batchFailed = (batch: number) =>
      new IndexBatchFailedError({
        repoId: "Effect-TS-effect",
        batch,
        total: 5,
        file: `src/bad${batch}.ts`,
        phase: "embed",
        message: `onnx error ${batch}`
      })

    it("lists every batch, marking the interrupted one and starting the cursor on it", async () => {
      const job = syncJob(
        [
          step("indexBatch", "interrupted"),
          ...Array.from({ length: 30 }, (_, i) => step(`indexBatch:${i}`, "done")),
          step("indexBatch:30", "interrupted"),
          step("indexBatch:31", "pending")
        ],
        "interrupted"
      )
      setup = await renderModal([job], {}, { width: 120, height: 24 })
      await interact(setup, () => {})

      await press("l")
      expect(setup.captureCharFrame()).toContain("> ! indexBatch 30/32 ›")
      await press("l")
      await interact(setup, () => {})
      await interact(setup, () => {})
      let frame = setup.captureCharFrame()
      expect(frame).toContain("> ! batch 31/32 interrupted")
      expect(frame).not.toContain("> ✓ batch 1/32")

      await press("l")
      expect(setup.captureCharFrame()).toContain("[j/k] Batch  [h] Steps")

      await press("j")
      frame = setup.captureCharFrame()
      expect(frame).toContain("> · batch 32/32")
      expect(frame).not.toContain("batch 32/32 interrupted")

      await press("g")
      frame = setup.captureCharFrame()
      expect(frame).toContain("> ✓ batch 1/32")
      expect(frame).not.toContain("batch 31/32 interrupted")
    })

    it("opens the batch line into its batches, and a failed one into its error", async () => {
      const batches = Array.from({ length: 5 }, (_, i) =>
        i === 1 || i === 3
          ? step(`indexBatch:${i}`, "failed", { error: batchFailed(i) })
          : step(`indexBatch:${i}`, "done")
      )
      setup = await renderModal([syncJob([step("indexBatch", "done"), ...batches])])
      await interact(setup, () => {})

      await press("l")
      expect(setup.captureCharFrame()).toContain("> ✗ indexBatch 3/5 (2 failed) ›")
      await press("l")
      let frame = setup.captureCharFrame()
      expect(frame.split("\n").find((line) => line.includes("✓ batch 1/5"))).not.toContain("›")
      expect(frame).toContain("> ✗ batch 2/5 ›")
      expect(frame).toContain("✓ batch 3/5")
      expect(frame).toContain("✗ batch 4/5 ›")
      expect(frame).toContain("✓ batch 5/5")
      expect(frame).toContain("[j/k] Batch  [l] Error  [h] Steps")

      await press("j", 2)
      await press("l")
      frame = setup.captureCharFrame()
      expect(frame).toContain("indexBatch 3/5 (2 failed) › batch 4/5")
      expect(frame).toContain("onnx error 3")

      await press("h", 2)
      expect(setup.captureCharFrame()).toContain("> ✗ indexBatch 3/5 (2 failed) ›")
    })

    it("doesn't open a batch line with no failed batches", async () => {
      const batches = Array.from({ length: 3 }, (_, i) => step(`indexBatch:${i}`, "done"))
      setup = await renderModal([syncJob([step("indexBatch", "done"), ...batches], "completed")])
      await interact(setup, () => {})

      await press("l", 2)
      const frame = setup.captureCharFrame()
      expect(frame.split("\n").find((line) => line.includes("> ✓ indexBatch 3/3"))).not.toContain("›")
      expect(frame).toContain("[j/k] Step  [h] Tasks")
      expect(frame).not.toContain("batch 1/3")
    })

    it("starts the step cursor over when another task is selected", async () => {
      setup = await renderModal([syncJob([step("loadRepo", "done"), step("fetch", "done")]), ...manyJobs(2)])
      await interact(setup, () => {})
      await press("l")
      await press("j")
      expect(setup.captureCharFrame()).toContain("> ✓ fetch")

      await press("h")
      await press("j")
      await press("k")
      await press("l")
      expect(setup.captureCharFrame()).toContain("> ✓ loadRepo")
    })

    it("jumps to the first and last task with g/G", async () => {
      setup = await renderModal(manyJobs(30), {}, { width: 120, height: 24 })
      await interact(setup, () => {})

      await interact(setup, () => setup!.mockInput.pressKey("g", { shift: true }))
      expect(setup.captureCharFrame()).toContain("> acme-repo-29")
      await press("g")
      expect(setup.captureCharFrame()).toContain("> acme-repo-00")
    })

    it("retries, discards and closes from any level", async () => {
      const onRetry = vi.fn(async () => {})
      const onDiscard = vi.fn(async () => {})
      const onClose = vi.fn()
      const job = syncJob([step("fetch", "interrupted")], "interrupted")
      setup = await testRender(
        <TasksView jobs={[job]} now={now} onRetry={onRetry} onDiscard={onDiscard} onClose={onClose} />,
        { width: 140, height: 50 }
      )
      await interact(setup, () => {})

      await press("l")
      await press("r")
      await press("x")
      await press("q")
      expect(onRetry).toHaveBeenCalledWith(job.id)
      expect(onDiscard).toHaveBeenCalledWith(job.id)
      expect(onClose).toHaveBeenCalled()
    })
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
