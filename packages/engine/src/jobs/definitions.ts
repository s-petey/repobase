import { DateTime, Effect, Option, Ref, Schema, Semaphore, Stream } from "effect"
import type { RpcClientError } from "effect/rpc"
import * as path from "path"
import * as os from "os"
import type { RepoConfig } from "../schemas.js"
import { IndexBatchResult } from "../schemas.js"
import { INDEX_BATCH_SIZE } from "../services/Indexer.js"
import { trackingMode } from "../utils.js"
import { CURRENT_INDEX_FORMAT, needsReindex } from "../indexFormat.js"
import { RepoStore } from "../services/RepoStore.js"
import { IndexingClient, WorkerClient } from "../worker/client.js"
import { PlanSummary } from "../worker/rpcs.js"
import {
  ConfigReadFailedError,
  RepoAlreadyAddedError,
  RepoMissingError,
  SaveConfigFailedError,
  type StepError,
  UpdateStoreFailedError,
  workerCrashed
} from "./errors.js"
import type { AddRepoJob, Job, ReindexRepoJob, SyncRepoJob } from "./Job.js"
import { JobProgress } from "./JobProgress.js"
import {
  fanOut,
  type FanOutDefinition,
  type JobDefinitions,
  type OutputSchema,
  step,
  type StepContext,
  type StepDefinition
} from "./JobRunner.js"

// What addRepo and syncRepo do, as JobRunner steps.
//
// Worker steps are built with workerStep/indexingFanOut: their `run` gets only
// a worker client, so any real work has to go through a worker thread, and
// a worker that dies becomes the step's WorkerCrashedError. Main-thread steps
// only touch config.json, which keeps it single-writer.

type WorkerCall<O> = Effect.Effect<O, StepError | RpcClientError.RpcClientError>

const onWorker = <J extends Job, O>(ctx: StepContext<J>, name: string, call: (client: WorkerClient["Service"]) => WorkerCall<O>) =>
  Effect.gen(function* () {
    const client = yield* WorkerClient
    return yield* call(client).pipe(
      Effect.catchTag("RpcClientError", workerCrashed({ repoId: ctx.job.repoId, step: name }))
    )
  })

const workerStep = <J extends Job, O>(definition: {
  readonly name: string
  readonly output: OutputSchema<O>
  readonly run: (ctx: StepContext<J>, client: WorkerClient["Service"]) => WorkerCall<O>
  readonly finishJob?: StepDefinition<J, O, WorkerClient>["finishJob"]
}): StepDefinition<J, O, WorkerClient> =>
  step({
    name: definition.name,
    runsOn: "worker",
    output: definition.output,
    run: (ctx) => onWorker(ctx, definition.name, (client) => definition.run(ctx, client)),
    ...(definition.finishJob ? { finishJob: definition.finishJob } : {})
  })

// Fan-out steps embed files, so they run on the indexing workers
const indexingFanOut = <J extends Job, I, O, R>(definition: {
  readonly name: string
  readonly output: OutputSchema<O>
  readonly items: (ctx: StepContext<J>) => Effect.Effect<ReadonlyArray<I>, StepError, R>
  readonly run: (
    item: I,
    position: { readonly index: number; readonly total: number },
    ctx: StepContext<J>,
    client: IndexingClient["Service"]
  ) => Effect.Effect<O, StepError | RpcClientError.RpcClientError, JobProgress>
}): FanOutDefinition<J, I, O, R | IndexingClient | JobProgress> =>
  fanOut<J, I, O, R | IndexingClient | JobProgress>({
    name: definition.name,
    runsOn: "worker",
    output: definition.output,
    items: definition.items,
    run: (item, position, ctx) =>
      Effect.gen(function* () {
        const client = yield* IndexingClient
        return yield* definition
          .run(item, position, ctx, client)
          .pipe(
            Effect.catchTag(
              "RpcClientError",
              workerCrashed({ repoId: ctx.job.repoId, step: `${definition.name}:${position.index}` })
            )
          )
      })
  })

/**
 * Where job definitions keep clones, and how many index batches may run at
 * once across all jobs (see hostIndexingConcurrency)
 */
export interface DefinitionsConfig {
  readonly reposDir: string
  readonly indexingConcurrency: number
}

export const defaultDefinitionsConfig = (): Omit<DefinitionsConfig, "indexingConcurrency"> => ({
  reposDir: path.join(os.homedir(), ".repobase", "repos")
})

export type JobDefinitionsServices = WorkerClient | IndexingClient | RepoStore | JobProgress

export const makeJobDefinitions = (config: DefinitionsConfig): JobDefinitions<JobDefinitionsServices> => {
  const localPath = (repoId: string) => path.join(config.reposDir, repoId)

  // Embedding is CPU-heavy (several cores per batch), so batches from every job share these slots.
  // Fetching, planning and the rest still run in parallel
  const indexingSlots = Semaphore.makeUnsafe(config.indexingConcurrency)

  // --- addRepo -------------------------------------------------------------

  const checkAbsent = step<AddRepoJob, null, RepoStore>({
    name: "checkAbsent",
    runsOn: "main",
    output: Schema.Null,
    run: (ctx) =>
      Effect.gen(function* () {
        const store = yield* RepoStore
        const { repoId } = ctx.job
        const existing = yield* store
          .getRepo(repoId)
          .pipe(Effect.mapError((e) => new ConfigReadFailedError({ repoId, message: e.message })))
        if (Option.isSome(existing)) {
          return yield* new RepoAlreadyAddedError({ repoId, message: `${repoId} is already in your repositories` })
        }
        return null
      })
  })

  const clone = workerStep<AddRepoJob, null>({
    name: "clone",
    output: Schema.Null,
    run: (ctx, client) =>
      client
        .Clone({
          repoId: ctx.job.repoId,
          url: ctx.job.payload.url,
          localPath: localPath(ctx.job.repoId),
          mode: ctx.job.payload.mode
        })
        .pipe(Effect.as(null))
  })

  const resolveHead = workerStep<AddRepoJob, HeadResult>({
    name: "resolveHead",
    output: HeadResult,
    run: (ctx, client) => client.ResolveHead({ repoId: ctx.job.repoId, localPath: localPath(ctx.job.repoId) })
  })

  const saveConfig = step<AddRepoJob, null, RepoStore>({
    name: "saveConfig",
    runsOn: "main",
    output: Schema.Null,
    run: (ctx) =>
      Effect.gen(function* () {
        const store = yield* RepoStore
        const { repoId, payload } = ctx.job
        const { branch } = yield* ctx.output(resolveHead)
        const saveFailed = (e: { readonly message: string }) =>
          new SaveConfigFailedError({ repoId, message: e.message })

        // A retry after this step already saved: same repo, nothing to do
        const existing = yield* store.getRepo(repoId).pipe(Effect.mapError(saveFailed))
        if (Option.isSome(existing)) {
          if (existing.value.url === payload.url) return null
          return yield* new RepoAlreadyAddedError({
            repoId,
            message: `${repoId} is already added from ${existing.value.url}`
          })
        }

        const now = yield* DateTime.now
        const repo: RepoConfig = {
          id: repoId,
          url: payload.url,
          localPath: localPath(repoId),
          mode: payload.mode ?? trackingMode(branch ?? "main"),
          lastSyncedCommit: Option.none(),
          lastSyncedAt: Option.none(),
          addedAt: now,
          cloudEnabled: false,
          lastPushedAt: Option.none(),
          lastPushedCommit: Option.none(),
          indexFormat: CURRENT_INDEX_FORMAT
        }
        yield* store.addRepo(repo).pipe(Effect.mapError(saveFailed))
        return null
      })
  })

  const planFullIndex = workerStep<AddRepoJob, PlanSummary>({
    name: "planFullIndex",
    output: PlanSummary,
    run: (ctx, client) =>
      client.PlanFullIndex({ jobId: ctx.job.id, repoId: ctx.job.repoId, localPath: localPath(ctx.job.repoId) })
  })

  const addIndexing = indexingSteps(planFullIndex, (ctx) => Effect.succeed(localPath(ctx.job.repoId)), indexingSlots)

  const recordSynced = step<AddRepoJob, null, RepoStore>({
    name: "recordSynced",
    runsOn: "main",
    output: Schema.Null,
    run: (ctx) =>
      Effect.gen(function* () {
        const { commit, committedAt } = yield* ctx.output(resolveHead)
        const now = yield* DateTime.now
        yield* RepoStore.use((store) =>
          store.updateRepo(ctx.job.repoId, {
            lastSyncedCommit: Option.some(commit),
            lastSyncedAt: Option.some(now),
            lastSyncedCommitAt: committedAt
          })
        ).pipe(Effect.mapError((e) => new UpdateStoreFailedError({ repoId: ctx.job.repoId, message: e.message })))
        return null
      })
  })

  // --- syncRepo ------------------------------------------------------------

  const loadRepo = step<SyncRepoJob, SyncTarget, RepoStore>({
    name: "loadRepo",
    runsOn: "main",
    output: SyncTarget,
    run: (ctx) =>
      Effect.gen(function* () {
        const store = yield* RepoStore
        const { repoId } = ctx.job
        const repo = yield* store
          .getRepo(repoId)
          .pipe(Effect.mapError((e) => new ConfigReadFailedError({ repoId, message: e.message })))
        if (Option.isNone(repo)) {
          return yield* new RepoMissingError({ repoId, message: `${repoId} is not in your repositories` })
        }
        const { localPath: repoPath, mode, lastSyncedCommit } = repo.value
        return {
          localPath: repoPath,
          branch: mode._tag === "tracking" ? mode.branch : null,
          previousCommit: Option.getOrNull(lastSyncedCommit),
          outdated: needsReindex(repo.value)
        }
      }),
    // Pinned repos don't sync
    finishJob: (target) => (target.branch === null ? Option.some("skipped" as const) : Option.none())
  })

  const syncPath = (ctx: StepContext<SyncRepoJob>) => ctx.output(loadRepo).pipe(Effect.map((t) => t.localPath))

  // Only reached for tracking repos, so branch is set
  const trackedBranch = (ctx: StepContext<SyncRepoJob>) =>
    ctx.output(loadRepo).pipe(Effect.map((t) => ({ ...t, branch: t.branch ?? "main" })))

  const fetch = workerStep<SyncRepoJob, null>({
    name: "fetch",
    output: Schema.Null,
    run: (ctx, client) =>
      syncPath(ctx).pipe(
        Effect.flatMap((repoPath) => client.Fetch({ repoId: ctx.job.repoId, localPath: repoPath })),
        Effect.as(null)
      )
  })

  const resolveRemoteHead = workerStep<SyncRepoJob, RemoteHeadResult>({
    name: "resolveRemoteHead",
    output: RemoteHeadResult,
    run: (ctx, client) =>
      Effect.gen(function* () {
        const target = yield* trackedBranch(ctx)
        const { commit, committedAt } = yield* client.RemoteHead({
          repoId: ctx.job.repoId,
          localPath: target.localPath,
          branch: target.branch
        })
        // An index in an old format needs the full re-index even with nothing new on the remote
        const upToDate = !ctx.job.payload.force && !target.outdated && commit === target.previousCommit
        return { commit, committedAt, upToDate }
      }),
    // Nothing new on the remote: done, no re-index
    finishJob: (head) => (head.upToDate ? Option.some("completed" as const) : Option.none())
  })

  const resetHard = workerStep<SyncRepoJob, null>({
    name: "resetHard",
    output: Schema.Null,
    run: (ctx, client) =>
      Effect.gen(function* () {
        const target = yield* ctx.output(loadRepo)
        // The commit this sync plans, not origin/<branch>: a resumed sync may run
        // after a later fetch moved the branch
        const { commit } = yield* ctx.output(resolveRemoteHead)
        yield* client.ResetHard({ repoId: ctx.job.repoId, localPath: target.localPath, ref: commit })
        return null
      })
  })

  const planChanges = workerStep<SyncRepoJob, SyncPlanSummary>({
    name: "planChanges",
    output: SyncPlanSummary,
    run: (ctx, client) =>
      Effect.gen(function* () {
        const target = yield* ctx.output(loadRepo)
        const head = yield* ctx.output(resolveRemoteHead)
        // A forced sync, or one of a repo in an old index format, re-indexes every
        // file rather than just the diff
        const force = (ctx.job.payload.force ?? false) || target.outdated

        let logMessage = '';
        if (force) {
          logMessage = `${ctx.job.repoId}: re-indexing every file (${target.outdated ? "the index format is outdated" : "forced"})`
        } else if (target.previousCommit === null) {
          logMessage = `${ctx.job.repoId}: no previous sync, so scanning every file`
        } else {
          logMessage = `${ctx.job.repoId}: indexing the changes ${target.previousCommit.slice(0, 8)}..${head.commit.slice(0, 8)}`
        }

        yield* Effect.logDebug(logMessage)
        return yield* client.PlanChanges({
          jobId: ctx.job.id,
          repoId: ctx.job.repoId,
          localPath: target.localPath,
          from: force ? null : target.previousCommit,
          to: head.commit,
          force
        })
      })
  })

  const syncIndexing = indexingSteps(planChanges, syncPath, indexingSlots)

  const updateStore = step<SyncRepoJob, null, RepoStore>({
    name: "updateStore",
    runsOn: "main",
    output: Schema.Null,
    run: (ctx) =>
      Effect.gen(function* () {
        const store = yield* RepoStore
        const { commit, committedAt } = yield* ctx.output(resolveRemoteHead)
        const now = yield* DateTime.now
        yield* store
          .updateRepo(ctx.job.repoId, {
            lastSyncedCommit: Option.some(commit),
            lastSyncedAt: Option.some(now),
            lastSyncedCommitAt: committedAt,
            // Already current, or just fully re-indexed because it wasn't
            indexFormat: CURRENT_INDEX_FORMAT
          })
          .pipe(Effect.mapError((e) => new UpdateStoreFailedError({ repoId: ctx.job.repoId, message: e.message })))
        return null
      })
  })

  // --- reindexRepo ---------------------------------------------------------

  const loadReindexTarget = step<ReindexRepoJob, { readonly localPath: string }, RepoStore>({
    name: "loadRepo",
    runsOn: "main",
    output: Schema.Struct({ localPath: Schema.String }),
    run: (ctx) =>
      Effect.gen(function* () {
        const store = yield* RepoStore
        const { repoId } = ctx.job
        const repo = yield* store
          .getRepo(repoId)
          .pipe(Effect.mapError((e) => new ConfigReadFailedError({ repoId, message: e.message })))
        if (Option.isNone(repo)) {
          return yield* new RepoMissingError({ repoId, message: `${repoId} is not in your repositories` })
        }
        return { localPath: repo.value.localPath }
      })
  })

  const reindexPath = (ctx: StepContext<ReindexRepoJob>) =>
    ctx.output(loadReindexTarget).pipe(Effect.map((t) => t.localPath))

  const planReindex = workerStep<ReindexRepoJob, ReindexPlanSummary>({
    name: "planFullIndex",
    output: ReindexPlanSummary,
    run: (ctx, client) =>
      Effect.gen(function* () {
        const repoPath = yield* reindexPath(ctx)
        // Repos synced before commit dates were recorded get theirs here
        const { commit, committedAt } = yield* client.ResolveHead({ repoId: ctx.job.repoId, localPath: repoPath })
        // Every file: what's indexed was written in an older format
        const plan = yield* client.PlanFullIndex({ jobId: ctx.job.id, repoId: ctx.job.repoId, localPath: repoPath, force: true })
        return { ...plan, commit, committedAt }
      })
  })

  const reindexIndexing = indexingSteps(planReindex, reindexPath, indexingSlots)

  const stampIndexFormat = step<ReindexRepoJob, null, RepoStore>({
    name: "stampIndexFormat",
    runsOn: "main",
    output: Schema.Null,
    run: (ctx) =>
      ctx.output(planReindex).pipe(
        Effect.flatMap(({ committedAt }) =>
          RepoStore.use((store) =>
            store.updateRepo(ctx.job.repoId, {
              indexFormat: CURRENT_INDEX_FORMAT,
              // A job saved before commit dates were recorded has none: keep what's there
              ...(committedAt ? { lastSyncedCommitAt: committedAt } : {})
            })
          )
        ),
        Effect.mapError((e) => new UpdateStoreFailedError({ repoId: ctx.job.repoId, message: e.message })),
        Effect.as(null)
      )
  })

  return {
    addRepo: {
      steps: [checkAbsent, clone, resolveHead, saveConfig, planFullIndex, ...addIndexing, recordSynced]
    },
    syncRepo: {
      steps: [loadRepo, fetch, resolveRemoteHead, resetHard, planChanges, ...syncIndexing, updateStore, ...legacyCleanupSteps<SyncRepoJob>()]
    },
    reindexRepo: {
      steps: [loadReindexTarget, planReindex, ...reindexIndexing, stampIndexFormat, ...legacyCleanupSteps<ReindexRepoJob>()]
    }
  }
}

/**
 * After a repo is stamped with the current index format: drop the legacy index
 * table (see LEGACY_FILES_TABLE in Indexer.ts) once no repo needs it any more
 */
const legacyCleanupSteps = <J extends Job>() => {
  const checkLegacyIndex = step<J, { readonly unused: boolean }, RepoStore>({
    name: "checkLegacyIndex",
    runsOn: "main",
    output: Schema.Struct({ unused: Schema.Boolean }),
    run: (ctx) =>
      RepoStore.use((store) => store.load()).pipe(
        Effect.map((data) => ({ unused: !data.repos.some(needsReindex) })),
        Effect.mapError((e) => new ConfigReadFailedError({ repoId: ctx.job.repoId, message: e.message }))
      )
  })

  const dropLegacyIndex = workerStep<J, null>({
    name: "dropLegacyIndex",
    output: Schema.Null,
    run: (ctx, client) =>
      Effect.gen(function* () {
        const { unused } = yield* ctx.output(checkLegacyIndex)
        // Alone, like finalizeIndex: other jobs may be writing to the index
        if (unused) yield* ctx.indexLock.exclusive(client.DropLegacyIndex({ repoId: ctx.job.repoId }))
        return null
      })
  })

  return [checkLegacyIndex, dropLegacyIndex] as const
}

// What loadRepo reads from config.json for a sync; branch is null when pinned
const SyncTarget = Schema.Struct({
  localPath: Schema.String,
  branch: Schema.NullOr(Schema.String),
  previousCommit: Schema.NullOr(Schema.String),
  outdated: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(false)))
})
type SyncTarget = typeof SyncTarget.Type

// committedAt is optional in step outputs: jobs saved before it was recorded don't have it
const HeadResult = Schema.Struct({
  commit: Schema.String,
  branch: Schema.optional(Schema.String),
  committedAt: Schema.optional(Schema.DateTimeUtcFromMillis)
})
type HeadResult = typeof HeadResult.Type

const RemoteHeadResult = Schema.Struct({
  commit: Schema.String,
  committedAt: Schema.optional(Schema.DateTimeUtcFromMillis),
  upToDate: Schema.Boolean
})
type RemoteHeadResult = typeof RemoteHeadResult.Type

const ReindexPlanSummary = Schema.Struct({
  ...PlanSummary.fields,
  commit: Schema.optional(Schema.String),
  committedAt: Schema.optional(Schema.DateTimeUtcFromMillis)
})
type ReindexPlanSummary = typeof ReindexPlanSummary.Type

const SyncPlanSummary = Schema.Struct({ ...PlanSummary.fields, fullScan: Schema.Boolean })
type SyncPlanSummary = typeof SyncPlanSummary.Type

/**
 * The steps that apply a job's saved plan, shared by addRepo and syncRepo:
 * drop deleted files, index in batches across the worker pool, then finalize
 */
const indexingSteps = <J extends Job, P extends PlanSummary>(
  plan: StepDefinition<J, P, any>,
  repoPath: (ctx: StepContext<J>) => Effect.Effect<string>,
  indexingSlots: Semaphore.Semaphore
) => {
  const deleteRemoved = workerStep<J, { readonly count: number }>({
    name: "deleteRemoved",
    output: Schema.Struct({ count: Schema.Number }),
    run: (ctx, client) => ctx.indexLock.write(client.DeleteRemoved({ jobId: ctx.job.id, repoId: ctx.job.repoId }))
  })

  const indexBatch = indexingFanOut<J, number, IndexBatchResult, JobProgress>({
    name: "indexBatch",
    output: IndexBatchResult,
    items: (ctx) =>
      Effect.gen(function* () {
        const summary = yield* ctx.output(plan)
        const batches = Math.ceil(summary.toIndex / INDEX_BATCH_SIZE)
        // Files in batches a previous attempt finished count as progress already
        const alreadyDone = ctx.job.steps
          .filter((s) => s.name === "indexBatch" && s.key !== "indexBatch" && s.status === "done")
          .reduce((sum, s) => {
            const result = Schema.decodeUnknownOption(IndexBatchResult)(s.output)
            return sum + Option.match(result, { onNone: () => 0, onSome: (r) => r.indexed + r.skipped })
          }, 0)
        yield* JobProgress.use((progress) => progress.begin(ctx.job.id, summary.toIndex, alreadyDone))
        return Array.from({ length: batches }, (_, i) => i)
      }),
    run: (batch, { total }, ctx, client) =>
      Effect.gen(function* () {
        const progress = yield* JobProgress
        const result = yield* Ref.make<IndexBatchResult>({ indexed: 0, skipped: 0 })
        const localPath = yield* repoPath(ctx)
        yield* indexingSlots.withPermit(ctx.indexLock.write(
          client.IndexBatch({ jobId: ctx.job.id, repoId: ctx.job.repoId, localPath, batch, total }).pipe(
            Stream.runForEach((event) =>
              event._tag === "File"
                ? progress.fileStarted(ctx.job.id, batch, event.path)
                : Ref.set(result, { indexed: event.indexed, skipped: event.skipped })
            ),
            Effect.ensuring(progress.batchEnded(ctx.job.id, batch))
          )
        ))
        return yield* Ref.get(result)
      })
  })

  const finalizeIndex = step<J, null, WorkerClient | JobProgress>({
    name: "finalizeIndex",
    runsOn: "worker",
    output: Schema.Null,
    // The batches are done, so their live progress goes. Then alone: compaction
    // and the full-text rebuild fail if another job writes meanwhile
    run: (ctx) =>
      JobProgress.use((progress) => progress.clear(ctx.job.id)).pipe(
        Effect.andThen(
          onWorker(ctx, "finalizeIndex", (client) =>
            ctx.indexLock.exclusive(client.FinalizeIndex({ repoId: ctx.job.repoId }))
          )
        ),
        Effect.as(null)
      )
  })

  return [deleteRemoved, indexBatch, finalizeIndex] as const
}
