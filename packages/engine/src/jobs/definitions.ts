import { DateTime, Effect, Option, Ref, Schema, Stream } from "effect"
import type { RpcClientError } from "effect/unstable/rpc"
import * as path from "path"
import * as os from "os"
import type { RepoConfig } from "../schemas.js"
import { IndexBatchResult } from "../schemas.js"
import { INDEX_BATCH_SIZE } from "../services/Indexer.js"
import { trackingMode } from "../utils.js"
import { RepoStore } from "../services/RepoStore.js"
import { WorkerClient } from "../worker/client.js"
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
import type { AddRepoJob, Job, SyncRepoJob } from "./Job.js"
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
// Worker steps are built with workerStep/workerFanOut: their `run` gets only
// the worker client, so any real work has to go through a worker thread, and
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

const workerFanOut = <J extends Job, I, O, R>(definition: {
  readonly name: string
  readonly output: OutputSchema<O>
  readonly items: (ctx: StepContext<J>) => Effect.Effect<ReadonlyArray<I>, StepError, R>
  readonly run: (
    item: I,
    position: { readonly index: number; readonly total: number },
    ctx: StepContext<J>,
    client: WorkerClient["Service"]
  ) => Effect.Effect<O, StepError | RpcClientError.RpcClientError, JobProgress>
}): FanOutDefinition<J, I, O, R | WorkerClient | JobProgress> =>
  fanOut<J, I, O, R | WorkerClient | JobProgress>({
    name: definition.name,
    runsOn: "worker",
    output: definition.output,
    items: definition.items,
    run: (item, position, ctx) =>
      Effect.gen(function* () {
        const client = yield* WorkerClient
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
 * Where job definitions keep clones
 */
export interface DefinitionsConfig {
  readonly reposDir: string
}

export const defaultDefinitionsConfig = (): DefinitionsConfig => ({
  reposDir: path.join(os.homedir(), ".repobase", "repos")
})

export type JobDefinitionsServices = WorkerClient | RepoStore | JobProgress

export const makeJobDefinitions = (config: DefinitionsConfig): JobDefinitions<JobDefinitionsServices> => {
  const localPath = (repoId: string) => path.join(config.reposDir, repoId)

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
        .Clone({ repoId: ctx.job.repoId, url: ctx.job.payload.url, localPath: localPath(ctx.job.repoId) })
        .pipe(Effect.as(null))
  })

  const resolveHead = workerStep<AddRepoJob, { readonly commit: string; readonly branch?: string }>({
    name: "resolveHead",
    output: Schema.Struct({ commit: Schema.String, branch: Schema.optional(Schema.String) }),
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
        const { commit, branch } = yield* ctx.output(resolveHead)
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

        // RepoConfig still uses JS Date (see the DateTime follow-up todo)
        const now = DateTime.toDate(yield* DateTime.now)
        const repo: RepoConfig = {
          id: repoId,
          url: payload.url,
          localPath: localPath(repoId),
          mode: payload.mode ?? trackingMode(branch ?? "main"),
          lastSyncedCommit: Option.some(commit),
          lastSyncedAt: Option.some(now),
          addedAt: now,
          cloudEnabled: false,
          lastPushedAt: Option.none(),
          lastPushedCommit: Option.none()
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

  const addIndexing = indexingSteps(planFullIndex, (ctx) => Effect.succeed(localPath(ctx.job.repoId)))

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
          previousCommit: Option.getOrNull(lastSyncedCommit)
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
        const { commit } = yield* client.RemoteHead({
          repoId: ctx.job.repoId,
          localPath: target.localPath,
          branch: target.branch
        })
        return { commit, upToDate: commit === target.previousCommit }
      }),
    // Nothing new on the remote: done, no re-index
    finishJob: (head) => (head.upToDate ? Option.some("completed" as const) : Option.none())
  })

  const resetHard = workerStep<SyncRepoJob, null>({
    name: "resetHard",
    output: Schema.Null,
    run: (ctx, client) =>
      Effect.gen(function* () {
        const target = yield* trackedBranch(ctx)
        // origin/<branch>, since the clone is shallow
        yield* client.ResetHard({
          repoId: ctx.job.repoId,
          localPath: target.localPath,
          ref: `origin/${target.branch}`
        })
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
        return yield* client.PlanChanges({
          jobId: ctx.job.id,
          repoId: ctx.job.repoId,
          localPath: target.localPath,
          from: target.previousCommit,
          to: head.commit
        })
      })
  })

  const syncIndexing = indexingSteps(planChanges, syncPath)

  const updateStore = step<SyncRepoJob, null, RepoStore>({
    name: "updateStore",
    runsOn: "main",
    output: Schema.Null,
    run: (ctx) =>
      Effect.gen(function* () {
        const store = yield* RepoStore
        const { commit } = yield* ctx.output(resolveRemoteHead)
        // RepoConfig still uses JS Date (see the DateTime follow-up todo)
        const now = DateTime.toDate(yield* DateTime.now)
        yield* store
          .updateRepo(ctx.job.repoId, { lastSyncedCommit: Option.some(commit), lastSyncedAt: Option.some(now) })
          .pipe(Effect.mapError((e) => new UpdateStoreFailedError({ repoId: ctx.job.repoId, message: e.message })))
        return null
      })
  })

  return {
    addRepo: {
      steps: [checkAbsent, clone, resolveHead, saveConfig, planFullIndex, ...addIndexing]
    },
    syncRepo: {
      steps: [loadRepo, fetch, resolveRemoteHead, resetHard, planChanges, ...syncIndexing, updateStore]
    }
  }
}

// What loadRepo reads from config.json for a sync; branch is null when pinned
const SyncTarget = Schema.Struct({
  localPath: Schema.String,
  branch: Schema.NullOr(Schema.String),
  previousCommit: Schema.NullOr(Schema.String)
})
type SyncTarget = typeof SyncTarget.Type

const RemoteHeadResult = Schema.Struct({ commit: Schema.String, upToDate: Schema.Boolean })
type RemoteHeadResult = typeof RemoteHeadResult.Type

const SyncPlanSummary = Schema.Struct({ ...PlanSummary.fields, fullScan: Schema.Boolean })
type SyncPlanSummary = typeof SyncPlanSummary.Type

/**
 * The steps that apply a job's saved plan, shared by addRepo and syncRepo:
 * drop deleted files, index in batches across the worker pool, then finalize
 */
const indexingSteps = <J extends Job, P extends PlanSummary>(
  plan: StepDefinition<J, P, any>,
  repoPath: (ctx: StepContext<J>) => Effect.Effect<string>
) => {
  const deleteRemoved = workerStep<J, { readonly count: number }>({
    name: "deleteRemoved",
    output: Schema.Struct({ count: Schema.Number }),
    run: (ctx, client) => client.DeleteRemoved({ jobId: ctx.job.id, repoId: ctx.job.repoId })
  })

  const indexBatch = workerFanOut<J, number, IndexBatchResult, JobProgress>({
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
        yield* client
          .IndexBatch({
            jobId: ctx.job.id,
            repoId: ctx.job.repoId,
            localPath: yield* repoPath(ctx),
            batch,
            total
          })
          .pipe(
            Stream.runForEach((event) =>
              event._tag === "File"
                ? progress.fileStarted(ctx.job.id, event.path)
                : Ref.set(result, { indexed: event.indexed, skipped: event.skipped })
            )
          )
        return yield* Ref.get(result)
      })
  })

  const finalizeIndex = workerStep<J, null>({
    name: "finalizeIndex",
    output: Schema.Null,
    // One full-text rebuild at a time across jobs
    run: (ctx, client) =>
      ctx.ftsLock.withPermit(client.FinalizeIndex({ repoId: ctx.job.repoId })).pipe(Effect.as(null))
  })

  return [deleteRemoved, indexBatch, finalizeIndex] as const
}
