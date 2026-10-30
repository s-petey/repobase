import { Schema } from "effect"
import type { RpcClientError } from "effect/rpc"
import type { GitError, IndexError } from "../errors.js"

// One error class per job step, so a failed step can be shown to the user
// with a specific message and hint. Each is a Schema class: it travels back
// from worker threads and is stored in the job's checkpoint.
//
// Every error carries the repo it concerns, a human-readable `message`
// (usually the underlying error's message) and, optionally, `cause` with raw
// detail such as git's stderr.

const common = {
  repoId: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.String)
}

/**
 * Why a git network operation (clone, fetch) failed, classified from stderr
 */
export const GitFailureReason = Schema.Literals(["auth", "notFound", "network", "diskFull", "unknown"])
export type GitFailureReason = typeof GitFailureReason.Type

/**
 * Where indexing planning failed
 */
export const PlanIndexPhase = Schema.Literals(["glob", "read", "queryExisting", "savePlan"])
export type PlanIndexPhase = typeof PlanIndexPhase.Type

/**
 * Where indexing a batch of files failed
 */
export const IndexBatchPhase = Schema.Literals(["read", "embed", "write"])
export type IndexBatchPhase = typeof IndexBatchPhase.Type

// addRepo: the repo is already in the store
export class RepoAlreadyAddedError extends Schema.TaggedError<RepoAlreadyAddedError>()(
  "RepoAlreadyAddedError",
  common
) {}

// syncRepo: the repo was removed from the store before the job ran
export class RepoMissingError extends Schema.TaggedError<RepoMissingError>()("RepoMissingError", common) {}

// Any step reading ~/.repobase/config.json: it can't be read or parsed
export class ConfigReadFailedError extends Schema.TaggedError<ConfigReadFailedError>()(
  "ConfigReadFailedError",
  common
) {}

export class CloneFailedError extends Schema.TaggedError<CloneFailedError>()("CloneFailedError", {
  ...common,
  url: Schema.String,
  reason: GitFailureReason
}) {}

export class ResolveHeadFailedError extends Schema.TaggedError<ResolveHeadFailedError>()(
  "ResolveHeadFailedError",
  common
) {}

export class SaveConfigFailedError extends Schema.TaggedError<SaveConfigFailedError>()(
  "SaveConfigFailedError",
  common
) {}

export class FetchFailedError extends Schema.TaggedError<FetchFailedError>()("FetchFailedError", {
  ...common,
  reason: GitFailureReason
}) {}

export class RemoteBranchMissingError extends Schema.TaggedError<RemoteBranchMissingError>()(
  "RemoteBranchMissingError",
  {
    ...common,
    branch: Schema.String
  }
) {}

export class DiffFailedError extends Schema.TaggedError<DiffFailedError>()("DiffFailedError", {
  ...common,
  from: Schema.String,
  to: Schema.String
}) {}

export class ResetFailedError extends Schema.TaggedError<ResetFailedError>()("ResetFailedError", {
  ...common,
  ref: Schema.String
}) {}

export class PlanIndexFailedError extends Schema.TaggedError<PlanIndexFailedError>()(
  "PlanIndexFailedError",
  {
    ...common,
    phase: PlanIndexPhase
  }
) {}

export class DeleteRemovedFailedError extends Schema.TaggedError<DeleteRemovedFailedError>()(
  "DeleteRemovedFailedError",
  {
    ...common,
    count: Schema.Number
  }
) {}

export class IndexBatchFailedError extends Schema.TaggedError<IndexBatchFailedError>()(
  "IndexBatchFailedError",
  {
    ...common,
    batch: Schema.Number, // 0-based
    total: Schema.Number,
    file: Schema.optional(Schema.String),
    phase: IndexBatchPhase
  }
) {}

export class EmbedderLoadFailedError extends Schema.TaggedError<EmbedderLoadFailedError>()(
  "EmbedderLoadFailedError",
  common
) {}

export class FinalizeFtsFailedError extends Schema.TaggedError<FinalizeFtsFailedError>()(
  "FinalizeFtsFailedError",
  common
) {}

export class UpdateStoreFailedError extends Schema.TaggedError<UpdateStoreFailedError>()(
  "UpdateStoreFailedError",
  common
) {}

// Any step: the worker thread running it died or could not be reached
export class WorkerCrashedError extends Schema.TaggedError<WorkerCrashedError>()("WorkerCrashedError", {
  ...common,
  step: Schema.String
}) {}

// Any step: it failed with something other than a StepError (a bug), so the
// failure is still recorded and the step can be retried
export class UnexpectedStepError extends Schema.TaggedError<UnexpectedStepError>()("UnexpectedStepError", {
  ...common,
  step: Schema.String
}) {}

/**
 * Every error a job step can fail with
 */
export const StepError = Schema.Union([
  RepoAlreadyAddedError,
  RepoMissingError,
  ConfigReadFailedError,
  CloneFailedError,
  ResolveHeadFailedError,
  SaveConfigFailedError,
  FetchFailedError,
  RemoteBranchMissingError,
  DiffFailedError,
  ResetFailedError,
  PlanIndexFailedError,
  DeleteRemovedFailedError,
  IndexBatchFailedError,
  EmbedderLoadFailedError,
  FinalizeFtsFailedError,
  UpdateStoreFailedError,
  WorkerCrashedError,
  UnexpectedStepError
])
export type StepError = typeof StepError.Type

/**
 * Whether retrying the step can succeed without the user changing the job.
 * Derived from the error's tag rather than stored, so it can't drift.
 */
export const isRetryable = (error: StepError): boolean => {
  switch (error._tag) {
    case "RepoAlreadyAddedError":
    case "RepoMissingError":
    case "RemoteBranchMissingError":
      return false
    default:
      return true
  }
}

// Checked in order: disk and auth problems also tend to mention the remote
const gitFailurePatterns: ReadonlyArray<readonly [GitFailureReason, RegExp]> = [
  ["diskFull", /no space left on device|disk quota exceeded/i],
  [
    "auth",
    /authentication failed|could not read (username|password)|permission denied \(publickey|terminal prompts disabled|invalid username or password|access denied|host key verification failed/i
  ],
  [
    "notFound",
    /repository '.*' (not found|does not exist)|repository not found|does not appear to be a git repository/i
  ],
  [
    "network",
    /could not resolve host|failed to connect|connection (timed out|refused|reset)|network is unreachable|operation timed out|early eof|rpc failed|unexpected disconnect|ssl certificate|gnutls|tls handshake/i
  ]
]

/**
 * Classify why a git clone or fetch failed from its stderr
 */
export const classifyGitFailure = (stderr: string): GitFailureReason =>
  gitFailurePatterns.find(([, pattern]) => pattern.test(stderr))?.[0] ?? "unknown"

// Git prints this when a ref (e.g. origin/<branch>) doesn't exist
const unknownRevisionPattern = /unknown revision|bad revision|needed a single revision/i

/**
 * Map a failed `git clone` to CloneFailedError
 */
export const cloneFailed =
  (ctx: { readonly repoId: string; readonly url: string }) =>
  (error: GitError): CloneFailedError =>
    new CloneFailedError({
      repoId: ctx.repoId,
      url: ctx.url,
      reason: classifyGitFailure(error.message),
      message: error.message
    })

/**
 * Map a failed `git fetch` to FetchFailedError
 */
export const fetchFailed =
  (ctx: { readonly repoId: string }) =>
  (error: GitError): FetchFailedError =>
    new FetchFailedError({
      repoId: ctx.repoId,
      reason: classifyGitFailure(error.message),
      message: error.message
    })

/**
 * Map a failed `git rev-parse origin/<branch>`: a missing branch can't be
 * fixed by retrying, anything else is a plain resolve failure
 */
export const remoteHeadFailed =
  (ctx: { readonly repoId: string; readonly branch: string }) =>
  (error: GitError): RemoteBranchMissingError | ResolveHeadFailedError =>
    unknownRevisionPattern.test(error.message)
      ? new RemoteBranchMissingError({ repoId: ctx.repoId, branch: ctx.branch, message: error.message })
      : new ResolveHeadFailedError({ repoId: ctx.repoId, message: error.message })

/**
 * Map an Indexer failure while planning to PlanIndexFailedError
 */
export const planIndexFailed =
  (ctx: { readonly repoId: string }) =>
  (error: IndexError): PlanIndexFailedError =>
    new PlanIndexFailedError({
      repoId: ctx.repoId,
      phase:
        error.operation === "planIndex.glob"
          ? "glob"
          : error.operation === "planIndex.queryExisting"
            ? "queryExisting"
            : "read",
      message: error.message
    })

/**
 * Map an Indexer failure while indexing a batch: a model that won't load gets
 * its own error, anything else is a batch failure at the phase it happened
 */
export const indexBatchFailed =
  (ctx: { readonly repoId: string; readonly batch: number; readonly total: number }) =>
  (error: IndexError): IndexBatchFailedError | EmbedderLoadFailedError =>
    error.operation === "loadEmbedder"
      ? new EmbedderLoadFailedError({ repoId: ctx.repoId, message: error.message })
      : new IndexBatchFailedError({
          repoId: ctx.repoId,
          batch: ctx.batch,
          total: ctx.total,
          file: error.path,
          phase: error.operation === "indexBatch.embed" ? "embed" : error.operation === "indexBatch.read" ? "read" : "write",
          message: error.message
        })

/**
 * Map a transport failure (worker died, spawn failed, protocol error) for a step
 */
export const workerCrashed =
  (ctx: { readonly repoId: string; readonly step: string }) =>
  (error: RpcClientError.RpcClientError): WorkerCrashedError =>
    new WorkerCrashedError({
      repoId: ctx.repoId,
      step: ctx.step,
      message: error.message,
      cause: String(error.reason)
    })

/**
 * What the TUI shows for a failed step
 */
export interface StepErrorDisplay {
  readonly title: string
  readonly detail: string
  readonly hint?: string
}

const gitReasonDisplay: Record<GitFailureReason, { readonly title: string; readonly hint: string }> = {
  // GitHub also answers "authentication required" for a URL that doesn't exist
  auth: {
    title: "authentication required",
    hint: "Check the URL, and your git credentials or SSH key if the repository is private"
  },
  notFound: {
    title: "repository not found",
    hint: "Check the URL, or that you have access to a private repository"
  },
  network: {
    title: "network error",
    hint: "Check your connection, then retry"
  },
  diskFull: {
    title: "out of disk space",
    hint: "Free up disk space, then retry"
  },
  unknown: {
    title: "git error",
    hint: "See the details below, then retry"
  }
}

const batchPhaseVerb: Record<IndexBatchPhase, string> = {
  read: "reading",
  embed: "embedding",
  write: "writing"
}

/**
 * Turn a step error into the title, detail and hint the TUI displays
 */
export const formatStepError = (error: StepError): StepErrorDisplay => {
  const detail = error.message
  switch (error._tag) {
    case "RepoAlreadyAddedError":
      return {
        title: `${error.repoId} is already added`,
        detail,
        hint: "Discard this job; sync the repository instead"
      }
    case "RepoMissingError":
      return {
        title: `${error.repoId} is no longer in your repositories`,
        detail,
        hint: "Discard this job"
      }
    case "ConfigReadFailedError":
      return {
        title: "Could not read your repositories config",
        detail,
        hint: "Check that ~/.repobase/config.json is readable and valid JSON, then retry"
      }
    case "CloneFailedError": {
      const reason = gitReasonDisplay[error.reason]
      return { title: `Clone failed: ${reason.title}`, detail, hint: reason.hint }
    }
    case "ResolveHeadFailedError":
      return {
        title: "Could not read the current commit",
        detail,
        hint: "The local clone may be damaged; remove and re-add the repository if retrying fails"
      }
    case "SaveConfigFailedError":
      return {
        title: "Could not save the repository config",
        detail,
        hint: "Check that ~/.repobase is writable, then retry"
      }
    case "FetchFailedError": {
      const reason = gitReasonDisplay[error.reason]
      return { title: `Fetch failed: ${reason.title}`, detail, hint: reason.hint }
    }
    case "RemoteBranchMissingError":
      return {
        title: `Branch ${error.branch} no longer exists on the remote`,
        detail,
        hint: "Discard this job and track a different branch"
      }
    case "DiffFailedError":
      return {
        title: `Could not compare ${error.from.slice(0, 8)}..${error.to.slice(0, 8)}`,
        detail,
        hint: "Retry; if it keeps failing the history may have been rewritten"
      }
    case "ResetFailedError":
      return {
        title: `Could not update the working tree to ${error.ref}`,
        detail,
        hint: "Check for local changes or a locked index in the clone, then retry"
      }
    case "PlanIndexFailedError":
      return {
        title:
          error.phase === "queryExisting"
            ? "Could not read the existing index"
            : error.phase === "savePlan"
              ? "Could not save the indexing plan"
              : "Could not scan the repository files",
        detail,
        hint: "Retry; check that ~/.repobase is readable if it keeps failing"
      }
    case "DeleteRemovedFailedError":
      return {
        title: `Could not remove ${error.count} deleted file(s) from the index`,
        detail,
        hint: "Retry"
      }
    case "IndexBatchFailedError":
      return {
        title: `Indexing batch ${error.batch + 1}/${error.total} failed while ${batchPhaseVerb[error.phase]}${
          error.file ? ` ${error.file}` : ""
        }`,
        detail,
        hint: "Retry to index just the failed batches"
      }
    case "EmbedderLoadFailedError":
      return {
        title: "Could not load the embedding model",
        detail,
        hint: "The model downloads on first use; check your connection, then retry"
      }
    case "FinalizeFtsFailedError":
      return {
        title: "Could not rebuild the keyword search index",
        detail,
        hint: "Retry; semantic search still works in the meantime"
      }
    case "UpdateStoreFailedError":
      return {
        title: "Could not record the sync",
        detail,
        hint: "Check that ~/.repobase is writable, then retry"
      }
    case "WorkerCrashedError":
      return {
        title: `A worker thread stopped during ${error.step}`,
        detail,
        hint: "Retry; see ~/.repobase/worker.log if it keeps happening"
      }
    case "UnexpectedStepError":
      return {
        title: `Unexpected error during ${error.step}`,
        detail,
        hint: "Retry; see ~/.repobase/tui.log and ~/.repobase/worker.log if it keeps happening"
      }
  }
}
