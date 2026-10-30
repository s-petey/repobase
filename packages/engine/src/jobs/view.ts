import { DateTime } from "effect"
import { formatStepError, isRetryable, type StepErrorDisplay } from "./errors.js"
import { type Job, type Step, type StepStatus, superseded } from "./Job.js"
import { runningElsewhere } from "./owner.js"

export interface StepLine {
  readonly key: string
  readonly label: string
  readonly status: StepStatus
  readonly error?: StepErrorDisplay
  readonly children?: ReadonlyArray<StepLine>
}

export const stepIcon: Record<StepStatus, string> = {
  done: "✓",
  failed: "✗",
  running: "◌",
  pending: "·",
  interrupted: "!",
  skipped: "-"
}

const isFanOutItem = (step: Step) => step.key !== step.name

const groupStatus = (steps: ReadonlyArray<Step>): StepStatus => {
  const has = (status: StepStatus) => steps.some((s) => s.status === status)
  if (has("failed")) return "failed"
  if (has("interrupted")) return "interrupted"
  if (has("running")) return "running"
  if (steps.every((s) => s.status === "done")) return "done"
  if (steps.every((s) => s.status === "skipped")) return "skipped"
  return "pending"
}

const errorOf = (step: Step | undefined) => (step?.error ? formatStepError(step.error) : undefined)

const fanOutIndex = (key: string): number => Number(key.slice(key.indexOf(":") + 1))

export const stepLines = (job: Job): ReadonlyArray<StepLine> =>
  job.steps.flatMap((step): ReadonlyArray<StepLine> => {
    if (isFanOutItem(step)) return []

    const items = job.steps.filter((s) => s.name === step.name && isFanOutItem(s))
    if (items.length === 0) {
      return [{ key: step.key, label: step.name, status: step.status, error: errorOf(step) }]
    }

    const done = items.filter((s) => s.status === "done").length
    const failed = items.filter((s) => s.status === "failed")
    const label = `${step.name} ${done}/${items.length}${failed.length > 0 ? ` (${failed.length} failed)` : ""}`
    return [
      {
        key: step.key,
        label,
        status: groupStatus(items),
        error: errorOf(failed[0]),
        children: (done === items.length ? [] : items).map((item) => ({
          key: item.key,
          label: `batch ${fanOutIndex(item.key) + 1}/${items.length}${item.status === "interrupted" ? " interrupted" : ""}`,
          status: item.status,
          error: errorOf(item)
        }))
      }
    ]
  })

export const retryState = (job: Job): { readonly canRetry: boolean; readonly reason?: string } => {
  if (runningElsewhere(job)) {
    return { canRetry: false, reason: `Running in another repobase process (${job.owner?.name})` }
  }
  if (job.status !== "failed" && job.status !== "interrupted") {
    return { canRetry: false, reason: `Only failed or interrupted tasks can be retried (this one is ${job.status})` }
  }
  if (superseded(job)) {
    return { canRetry: false, reason: "A newer task replaced this one" }
  }

  const permanent = job.steps.find((s) => s.status === "failed" && s.error && !isRetryable(s.error))
  if (permanent?.error) {
    return { canRetry: false, reason: formatStepError(permanent.error).hint ?? "Retrying can't fix this; discard it" }
  }
  return { canRetry: true }
}

export const kindLabel: Record<Job["kind"], string> = {
  addRepo: "add",
  syncRepo: "sync",
  reindexRepo: "re-index"
}

const RESUMABLE_FAILED_STEPS: ReadonlySet<string> = new Set([
  "deleteRemoved",
  "indexBatch",
  "finalizeIndex",
  "updateStore",
  "stampIndexFormat",
  "recordSynced"
])

export const resumableJob = (
  jobs: ReadonlyArray<Job>,
  repoId: string,
  kind: Job["kind"] = "syncRepo"
): Job | undefined => {
  let latest: Job | undefined
  for (const job of jobs) {
    if (job.kind !== kind || job.repoId !== repoId) continue
    if (!latest || DateTime.toEpochMillis(job.createdAt) > DateTime.toEpochMillis(latest.createdAt)) {
      latest = job
    }
  }
  if (!latest || superseded(latest)) return undefined

  if (latest.status === "interrupted") return latest
  if (latest.status !== "failed" || !retryState(latest).canRetry) return undefined

  const failed = latest.steps.find((s) => s.status === "failed")
  return failed && RESUMABLE_FAILED_STEPS.has(failed.name) ? latest : undefined
}

export const unfinishedIndexing = (jobs: ReadonlyArray<Job>, repoId: string): Job | undefined =>
  resumableJob(jobs, repoId, "addRepo") ?? resumableJob(jobs, repoId, "reindexRepo")

export const resumePoint = (job: Job): string | undefined => {
  const batches = job.steps.filter((s) => s.name === "indexBatch" && s.key !== "indexBatch")
  const done = batches.filter((s) => s.status === "done").length
  if (batches.length > 0 && done > 0 && done < batches.length) {
    return `batch ${done + 1}/${batches.length}`
  }
  return job.steps.find((s) => s.status !== "done" && s.status !== "skipped")?.name
}

export const jobFailureMessage = (job: Job): string => {
  const failed = job.steps.find((s) => s.status === "failed" && s.error)
  if (failed?.error) return formatStepError(failed.error).title
  return job.status === "interrupted" ? "Stopped before it finished" : `Job ${job.status}`
}

export const syncUpdated = (job: Job): boolean =>
  job.status === "completed" && job.steps.some((s) => s.key === "updateStore" && s.status === "done")

export const jobFailed = (job: Job): boolean => job.status === "failed" || job.status === "interrupted"
