import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { SearchError } from "../errors.js"
import { RepoMode, SearchMode, SearchResult } from "../schemas.js"
import {
  CloneFailedError,
  DeleteRemovedFailedError,
  EmbedderLoadFailedError,
  FetchFailedError,
  FinalizeFtsFailedError,
  IndexBatchFailedError,
  PlanIndexFailedError,
  RemoteBranchMissingError,
  ResetFailedError,
  ResolveHeadFailedError
} from "../jobs/errors.js"

// The job steps a worker thread runs. Each fails with its step's own error,
// so the main thread can record it as-is.

/**
 * Clone a repository into `localPath`, replacing any partial clone left there.
 * Without a mode it checks out the remote's default branch.
 */
export class Clone extends Rpc.make("Clone", {
  payload: { repoId: Schema.String, url: Schema.String, localPath: Schema.String, mode: Schema.optional(RepoMode) },
  error: CloneFailedError
}) {}

/**
 * The commit and branch checked out in a local clone
 */
export class ResolveHead extends Rpc.make("ResolveHead", {
  payload: { repoId: Schema.String, localPath: Schema.String },
  success: Schema.Struct({ commit: Schema.String, branch: Schema.String }),
  error: ResolveHeadFailedError
}) {}

/**
 * What a plan contains; the plan itself stays in the job's plan.json
 */
export const PlanSummary = Schema.Struct({
  toIndex: Schema.Number,
  toDelete: Schema.Number,
  skipped: Schema.Number
})
export type PlanSummary = typeof PlanSummary.Type

/**
 * Scan the repo against the index and write the job's plan.json. Only counts
 * come back, so the file list never crosses to the main thread. `force` plans
 * every file, even ones whose hash is already indexed.
 */
export class PlanFullIndex extends Rpc.make("PlanFullIndex", {
  payload: {
    jobId: Schema.String,
    repoId: Schema.String,
    localPath: Schema.String,
    force: Schema.optional(Schema.Boolean)
  },
  success: PlanSummary,
  error: PlanIndexFailedError
}) {}

/**
 * Remove the plan's deleted files from the index
 */
export class DeleteRemoved extends Rpc.make("DeleteRemoved", {
  payload: { jobId: Schema.String, repoId: Schema.String },
  success: Schema.Struct({ count: Schema.Number }),
  error: DeleteRemovedFailedError
}) {}

/**
 * Progress while indexing a batch: each file as it starts, then the result
 */
export const IndexBatchEvent = Schema.Union([
  Schema.TaggedStruct("File", { path: Schema.String }),
  Schema.TaggedStruct("Done", { indexed: Schema.Number, skipped: Schema.Number })
])
export type IndexBatchEvent = typeof IndexBatchEvent.Type

/**
 * Index batch `batch` (0-based) of the job's plan
 */
export class IndexBatch extends Rpc.make("IndexBatch", {
  payload: {
    jobId: Schema.String,
    repoId: Schema.String,
    localPath: Schema.String,
    batch: Schema.Number,
    total: Schema.Number
  },
  success: IndexBatchEvent,
  error: Schema.Union([IndexBatchFailedError, EmbedderLoadFailedError]),
  stream: true
}) {}

/**
 * Compact the index and rebuild full-text search
 */
export class FinalizeIndex extends Rpc.make("FinalizeIndex", {
  payload: { repoId: Schema.String },
  error: FinalizeFtsFailedError
}) {}

/**
 * Fetch from origin
 */
export class Fetch extends Rpc.make("Fetch", {
  payload: { repoId: Schema.String, localPath: Schema.String },
  error: FetchFailedError
}) {}

/**
 * The commit origin/<branch> points at after a fetch
 */
export class RemoteHead extends Rpc.make("RemoteHead", {
  payload: { repoId: Schema.String, localPath: Schema.String, branch: Schema.String },
  success: Schema.Struct({ commit: Schema.String }),
  error: Schema.Union([RemoteBranchMissingError, ResolveHeadFailedError])
}) {}

/**
 * Point the working tree at `ref`
 */
export class ResetHard extends Rpc.make("ResetHard", {
  payload: { repoId: Schema.String, localPath: Schema.String, ref: Schema.String },
  error: ResetFailedError
}) {}

/**
 * Plan a sync: diff `from..to` and plan just those files, or scan the whole
 * repo when there's no previous commit or the diff can't be computed. Writes
 * the job's plan.json and returns counts, like PlanFullIndex.
 */
export class PlanChanges extends Rpc.make("PlanChanges", {
  payload: {
    jobId: Schema.String,
    repoId: Schema.String,
    localPath: Schema.String,
    from: Schema.NullOr(Schema.String),
    to: Schema.String,
    force: Schema.optional(Schema.Boolean)
  },
  success: Schema.Struct({ ...PlanSummary.fields, fullScan: Schema.Boolean }),
  error: PlanIndexFailedError
}) {}

/**
 * Search the index, optionally within one repo, file, or directory
 */
export class Search extends Rpc.make("Search", {
  payload: {
    query: Schema.String,
    mode: SearchMode,
    repo: Schema.optional(Schema.String),
    repos: Schema.optional(Schema.Array(Schema.String)),
    path: Schema.optional(Schema.String),
    glob: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number)
  },
  success: Schema.Array(SearchResult),
  error: SearchError
}) {}

/**
 * Drop the index table from before CURRENT_INDEX_FORMAT 2, once no repo needs
 * it. Best effort: a failure is logged and the next re-index tries again.
 */
export class DropLegacyIndex extends Rpc.make("DropLegacyIndex", {
  payload: { repoId: Schema.String },
  success: Schema.Struct({ dropped: Schema.Boolean })
}) {}

/**
 * Every operation a worker thread can run for the main thread
 */
export class StepRpcs extends RpcGroup.make(
  Clone,
  ResolveHead,
  PlanFullIndex,
  DeleteRemoved,
  IndexBatch,
  FinalizeIndex,
  Fetch,
  RemoteHead,
  ResetHard,
  PlanChanges,
  Search,
  DropLegacyIndex
) {}
