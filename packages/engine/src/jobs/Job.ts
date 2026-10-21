import { DateTime, Effect, Random, Schema } from "effect"
import { RepoMode } from "../schemas.js"
import { StepError } from "./errors.js"

// A job is one addRepo, syncRepo or reindexRepo run, split into steps. The job and every
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
 * failed: finished with `error` · interrupted: the process stopped mid-step ·
 * skipped: not needed because an earlier step ended the job early
 */
export const StepStatus = Schema.Literals(["pending", "running", "done", "failed", "interrupted", "skipped"])
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
  mode: Schema.optional(RepoMode)
})
export type AddRepoPayload = typeof AddRepoPayload.Type

export const SyncRepoPayload = Schema.Struct({
  // Re-index every file even when the repo is already up to date (a dev aid)
  force: Schema.optional(Schema.Boolean)
})
export type SyncRepoPayload = typeof SyncRepoPayload.Type

/**
 * The process that last ran a job (e.g. "tui" or "cli"), so another process
 * can tell a job that's still running from one left behind by a process that
 * exited
 */
export const JobOwner = Schema.Struct({ pid: Schema.Number, name: Schema.String })
export type JobOwner = typeof JobOwner.Type

const jobFields = {
  id: Schema.String,
  repoId: Schema.String,
  status: JobStatus,
  createdAt: Schema.DateTimeUtcFromMillis,
  updatedAt: Schema.DateTimeUtcFromMillis,
  owner: Schema.optional(JobOwner),
  supersededBy: Schema.optional(Schema.String),
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

/**
 * Index every file of a repo again in the current index format, without
 * fetching (see CURRENT_INDEX_FORMAT). Runs for pinned repos too.
 */
export const ReindexRepoJob = Schema.Struct({
  ...jobFields,
  kind: Schema.Literal("reindexRepo"),
  payload: Schema.Struct({})
})
export type ReindexRepoJob = typeof ReindexRepoJob.Type

export const Job = Schema.Union([AddRepoJob, SyncRepoJob, ReindexRepoJob])
export type Job = typeof Job.Type
export type JobKind = Job["kind"]

export const superseded = (job: Job): boolean => job.supersededBy !== undefined

/**
 * A new job id: kind, repo, then the current time and a random suffix; safe as
 * a file name. The time is when the job was first started: a retry moves its
 * createdAt, not its id. Uses the Clock and Random services, so tests can
 * control both.
 */
export const makeJobId = (kind: JobKind, repoId: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now
    const suffix = yield* Random.nextIntBetween(0, 36 ** 4)
    // The id names the job's files, so the "/" in "owner/name" can't stay in it.
    // The job keeps its real repoId; nothing parses the id back.
    const repoPart = repoId.replaceAll("/", "__")
    return `${kind}-${repoPart}-${DateTime.toEpochMillis(now).toString(36)}${suffix.toString(36).padStart(4, "0")}`
  })
