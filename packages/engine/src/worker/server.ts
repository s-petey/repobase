import { BunServices, BunWorkerRunner } from "@effect/platform-bun"
import { Array as Arr, Effect, FileSystem, Layer, Option, Path, Queue, Stream } from "effect"
import { RpcServer } from "effect/unstable/rpc"
import { fileLoggerLayer, logPath } from "../file-logger.js"
import {
  CloneFailedError,
  cloneFailed,
  DeleteRemovedFailedError,
  type EmbedderLoadFailedError,
  fetchFailed,
  FinalizeFtsFailedError,
  IndexBatchFailedError,
  indexBatchFailed,
  PlanIndexFailedError,
  planIndexFailed,
  remoteHeadFailed,
  ResetFailedError,
  ResolveHeadFailedError
} from "../jobs/errors.js"
import { JobStore, layer as JobStoreLayer } from "../jobs/JobStore.js"
import { GitClient, layer as GitClientLayer } from "../services/GitClient.js"
import { INDEX_BATCH_SIZE, Indexer, layer as IndexerLayer } from "../services/Indexer.js"
import { type IndexBatchEvent, StepRpcs } from "./rpcs.js"

/**
 * Handlers for StepRpcs, run inside the worker thread. Exported so tests can
 * run them in-process against temp directories.
 */
export const HandlersLayer = StepRpcs.toLayer(
  Effect.gen(function* () {
    const git = yield* GitClient
    const indexer = yield* Indexer
    const jobs = yield* JobStore
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const readPlan = (jobId: string) => jobs.readPlan(jobId).pipe(Effect.map(Option.getOrUndefined))

    return StepRpcs.of({
      Clone: ({ repoId, url, localPath }) =>
        Effect.gen(function* () {
          // A retried clone starts from scratch: drop whatever a failed attempt left
          yield* Effect.all([
            fs.remove(localPath, { recursive: true, force: true }),
            fs.makeDirectory(path.dirname(localPath), { recursive: true })
          ]).pipe(
            Effect.mapError(
              (e) => new CloneFailedError({ repoId, url, reason: "unknown", message: e.message })
            )
          )
          yield* git.clone(url, localPath).pipe(Effect.mapError(cloneFailed({ repoId, url })))
        }),

      ResolveHead: ({ repoId, localPath }) =>
        Effect.all({ commit: git.getCurrentCommit(localPath), branch: git.getCurrentBranch(localPath) }).pipe(
          Effect.mapError((e) => new ResolveHeadFailedError({ repoId, message: e.message }))
        ),

      PlanFullIndex: ({ jobId, repoId, localPath }) =>
        Effect.gen(function* () {
          const plan = yield* indexer
            .planFullIndex(repoId, localPath)
            .pipe(Effect.mapError(planIndexFailed({ repoId })))
          yield* jobs
            .writePlan(jobId, plan)
            .pipe(
              Effect.mapError((e) => new PlanIndexFailedError({ repoId, phase: "savePlan", message: e.message }))
            )
          return { toIndex: plan.toIndex.length, toDelete: plan.toDelete.length, skipped: plan.skipped }
        }),

      DeleteRemoved: ({ jobId, repoId }) =>
        Effect.gen(function* () {
          const plan = yield* readPlan(jobId).pipe(
            Effect.mapError((e) => new DeleteRemovedFailedError({ repoId, count: 0, message: e.message }))
          )
          if (!plan) {
            return yield* new DeleteRemovedFailedError({
              repoId,
              count: 0,
              message: `No indexing plan saved for job ${jobId}`
            })
          }
          yield* indexer
            .deletePaths(repoId, plan.toDelete)
            .pipe(
              Effect.mapError(
                (e) => new DeleteRemovedFailedError({ repoId, count: plan.toDelete.length, message: e.message })
              )
            )
          return { count: plan.toDelete.length }
        }),

      IndexBatch: ({ jobId, repoId, localPath, batch, total }) =>
        Stream.callback<IndexBatchEvent, IndexBatchFailedError | EmbedderLoadFailedError>((queue) =>
          Effect.gen(function* () {
            const batchError = (message: string) =>
              new IndexBatchFailedError({ repoId, batch, total, phase: "read", message })
            const plan = yield* readPlan(jobId).pipe(Effect.mapError((e) => batchError(e.message)))
            if (!plan) return yield* batchError(`No indexing plan saved for job ${jobId}`)

            // The same chunking the main thread used to count batches
            const files = Arr.chunksOf(plan.toIndex, INDEX_BATCH_SIZE)[batch] ?? []
            const result = yield* indexer
              .indexBatch(repoId, localPath, files, {
                onFile: (file) => Queue.offer(queue, { _tag: "File", path: file }).pipe(Effect.asVoid)
              })
              .pipe(Effect.mapError(indexBatchFailed({ repoId, batch, total })))

            yield* Queue.offer(queue, { _tag: "Done", ...result })
            yield* Queue.end(queue)
          }).pipe(
            // Fail the stream itself; a failure left in the callback would
            // leave the caller waiting on a queue that never ends
            Effect.catch((error) => Queue.fail(queue, error))
          )
        ),

      FinalizeIndex: ({ repoId }) =>
        indexer
          .finalizeIndex()
          .pipe(Effect.mapError((e) => new FinalizeFtsFailedError({ repoId, message: e.message }))),

      Fetch: ({ repoId, localPath }) =>
        git.fetch(localPath).pipe(Effect.mapError(fetchFailed({ repoId }))),

      RemoteHead: ({ repoId, localPath, branch }) =>
        git.getRemoteHead(localPath, branch).pipe(
          Effect.map((commit) => ({ commit })),
          Effect.mapError(remoteHeadFailed({ repoId, branch }))
        ),

      ResetHard: ({ repoId, localPath, ref }) =>
        git
          .resetHard(localPath, ref)
          .pipe(Effect.mapError((e) => new ResetFailedError({ repoId, ref, message: e.message }))),

      PlanChanges: ({ jobId, repoId, localPath, from, to, force }) =>
        Effect.gen(function* () {
          // Only the files that changed, if git can tell us; otherwise scan everything
          const changes =
            from === null
              ? Option.none()
              : yield* git.diffNameStatus(localPath, from, to).pipe(
                  Effect.map(Option.some),
                  Effect.catch((e) =>
                    Effect.logWarning(`${repoId}: diff ${from}..${to} failed, re-indexing everything: ${e.message}`).pipe(
                      Effect.as(Option.none())
                    )
                  )
                )
          const plan = yield* Option.match(changes, {
            onNone: () => indexer.planFullIndex(repoId, localPath, { force }),
            onSome: (changed) => indexer.planChanges(repoId, localPath, changed)
          }).pipe(Effect.mapError(planIndexFailed({ repoId })))
          yield* jobs
            .writePlan(jobId, plan)
            .pipe(
              Effect.mapError((e) => new PlanIndexFailedError({ repoId, phase: "savePlan", message: e.message }))
            )
          return {
            toIndex: plan.toIndex.length,
            toDelete: plan.toDelete.length,
            skipped: plan.skipped,
            fullScan: Option.isNone(changes)
          }
        }),

      Search: ({ query, mode, repo, path, limit }) => {
        const options = { repo, path, limit }
        switch (mode) {
          case "keyword":
            return indexer.searchKeyword(query, options)
          case "semantic":
            return indexer.searchSemantic(query, options)
          case "hybrid":
            return indexer.searchHybrid(query, options)
        }
      }
    })
  })
)

// provideMerge so the file logger is in the context the RPC server and its
// handlers are built with; otherwise worker logs would go to stdout.
const WorkerLayer = RpcServer.layer(StepRpcs).pipe(
  Layer.provide(HandlersLayer),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(BunWorkerRunner.layer),
  Layer.provide(Layer.mergeAll(GitClientLayer, IndexerLayer, JobStoreLayer)),
  Layer.provideMerge(fileLoggerLayer(logPath("worker"))),
  Layer.provide(BunServices.layer)
)

/**
 * Entry point for a worker thread: serve StepRpcs until the pool closes this
 * worker. The worker runner handles the close message from the main thread,
 * so there are no process signal handlers here.
 */
export const runWorker = () => {
  Effect.runFork(Layer.launch(WorkerLayer))
}
