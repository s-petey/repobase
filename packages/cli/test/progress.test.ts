import { describe, expect, it } from "vitest"
import { CloneFailedError, formatStepError, stepLines, type AddRepoJob } from "@repobase/engine"
import { DateTime } from "effect"
import { failureReport, jobHeading, stepReport } from "../src/progress.js"

const at = DateTime.makeUnsafe(0)
const error = new CloneFailedError({
  repoId: "acme/widgets",
  url: "https://github.com/acme/widgets",
  reason: "network",
  message: "Could not resolve host: github.com"
})

const failedAdd: AddRepoJob = {
  id: "addRepo-acme__widgets-1",
  kind: "addRepo",
  repoId: "acme/widgets",
  payload: { url: "https://github.com/acme/widgets" },
  status: "failed",
  createdAt: at,
  updatedAt: at,
  steps: [
    { key: "checkAbsent", name: "checkAbsent", runsOn: "main", status: "done", attempts: 1 },
    { key: "clone", name: "clone", runsOn: "worker", status: "failed", attempts: 1, error },
    { key: "resolveHead", name: "resolveHead", runsOn: "worker", status: "pending", attempts: 0 }
  ]
}

// Everything the CLI prints for a job that ended: its finished steps, then the summary
const printed = (job: AddRepoJob) => [...stepLines(job).flatMap(stepReport), failureReport(job)].join("\n")

describe("CLI progress output", () => {
  it("names a failed job's error once", () => {
    const { title } = formatStepError(error)
    expect(printed(failedAdd).split(title).length - 1).toBe(1)
  })

  it("says why a job stopped when no step failed", () => {
    const interrupted: AddRepoJob = {
      ...failedAdd,
      status: "interrupted",
      steps: failedAdd.steps.map((s) => (s.key === "clone" ? { ...s, status: "interrupted", error: undefined } : s))
    }
    expect(failureReport(interrupted)).toContain("Stopped before it finished")
  })

  describe("job heading", () => {
    const since = DateTime.makeUnsafe(1000)
    const running = (checkAbsentFinishedAt: DateTime.Utc): AddRepoJob => ({
      ...failedAdd,
      status: "running",
      createdAt: DateTime.add(since, { milliseconds: 1 }),
      steps: [
        { ...failedAdd.steps[0], finishedAt: checkAbsentFinishedAt },
        { ...failedAdd.steps[1], status: "pending", error: undefined },
        failedAdd.steps[2]
      ]
    })

    it("says where a resumed job picks up", () => {
      expect(jobHeading(running(DateTime.subtract(since, { seconds: 30 })), since)).toBe(
        "add acme/widgets (resuming at clone)"
      )
    })

    it("is just the kind and repo for a job this run started", () => {
      expect(jobHeading(running(DateTime.add(since, { milliseconds: 5 })), since)).toBe("add acme/widgets")
    })
  })
})
