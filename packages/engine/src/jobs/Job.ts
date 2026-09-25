import { DateTime, Effect, Random, Schema } from "effect"
import { RepoMode } from "../schemas.js"
import { StepError } from "./errors.js"

// A job is one addRepo or syncRepo run, split into steps. The job and every
// step's state are persisted after each change, so a failed or interrupted job
// can be retried from the step where it stopped.

/**
 * Where a step runs: cheap bookkeeping on the main thread, everything that can
 * block (git, hashing, embedding, LanceDB writes) on a worker thread
 */
export const StepRunsOn = Schema.Literals(["main", "worker"])
export type StepRunsOn = typeof StepRunsOn.Type

/**
 * pending: not started · running: in progress · done: finished, output saved ·
 * failed: finished with `error` · interrupted: the process stopped mid-step
 */
export const StepStatus = Schema.Literals(["pending", "running", "done", "failed", "interrupted"])
export type StepStatus = typeof StepStatus.Type

export const Step = Schema.Struct({
  // Unique within the job, e.g. "clone" or "indexBatch:3"
  key: Schema.String,
  // The step definition this runs, e.g. "indexBatch" for every batch
  name: Schema.String,
  runsOn: StepRunsOn,
  status: StepStatus,
  attempts: Schema.Number,
  // The step's output, already encoded with its own schema; later steps (and
  // resumed jobs) decode it from here rather than from memory
  output: Schema.optional(Schema.Unknown),
  error: Schema.optional(StepError),
  startedAt: Schema.optional(Schema.DateTimeUtcFromMillis),
  finishedAt: Schema.optional(Schema.DateTimeUtcFromMillis)
})
export type Step = typeof Step.Type

/**
 * running: has steps in progress · failed: a step failed, retryable from there ·
 * interrupted: the process stopped while it ran · completed: every step done ·
 * skipped: nothing to do (e.g. syncing a pinned repo)
 */
export const JobStatus = Schema.Literals(["running", "failed", "interrupted", "completed", "skipped"])
export type JobStatus = typeof JobStatus.Type

export const AddRepoPayload = Schema.Struct({
  url: Schema.String,
  mode: RepoMode
})
export type AddRepoPayload = typeof AddRepoPayload.Type

export const SyncRepoPayload = Schema.Struct({})
export type SyncRepoPayload = typeof SyncRepoPayload.Type

const jobFields = {
  id: Schema.String,
  repoId: Schema.String,
  status: JobStatus,
  createdAt: Schema.DateTimeUtcFromMillis,
  updatedAt: Schema.DateTimeUtcFromMillis,
  steps: Schema.Array(Step)
}

export const AddRepoJob = Schema.Struct({
  ...jobFields,
  kind: Schema.Literal("addRepo"),
  payload: AddRepoPayload
})
export type AddRepoJob = typeof AddRepoJob.Type

export const SyncRepoJob = Schema.Struct({
  ...jobFields,
  kind: Schema.Literal("syncRepo"),
  payload: SyncRepoPayload
})
export type SyncRepoJob = typeof SyncRepoJob.Type

export const Job = Schema.Union([AddRepoJob, SyncRepoJob])
export type Job = typeof Job.Type
export type JobKind = Job["kind"]

/**
 * A new job id: kind, repo, then the current time and a random suffix (so ids
 * sort by creation time); safe as a file name. Uses the Clock and Random
 * services, so tests can control both.
 */
export const makeJobId = (kind: JobKind, repoId: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now
    const suffix = yield* Random.nextIntBetween(0, 36 ** 4)
    return `${kind}-${repoId}-${DateTime.toEpochMillis(now).toString(36)}${suffix.toString(36).padStart(4, "0")}`
  })
