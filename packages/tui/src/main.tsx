// No shebang here: Bun.build turns a `#!/usr/bin/env bun` entry into a bundle
// marked `// @bun`, and Bun then decodes that bundle as Latin-1, garbling every
// non-ASCII character in the TUI. dist/bin/repobase.js carries the shebang.
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Deferred, Effect, Fiber, FiberSet, Layer, Option, Stream } from "effect"
import {
  RepobaseEngine,
  RepobaseEngineLayer,
  GitClientLayer,
  RepoStoreLayer,
  RepoStore,
  IndexerLayer,
  JobRunner,
  JobRunnerLayer,
  JobStoreLayer,
  JobProgress,
  JobProgressLayer,
  makeJobDefinitions,
  defaultDefinitionsConfig,
  deriveRepoId,
  fileLoggerLayer,
  layerWorkerPool,
  layerQueryPool,
  layerQueryFromIndexingPool,
  layerIndexingPool,
  QueryClient,
  logPath,
  hostWorkerCount,
  hostIndexingConcurrency,
  splitPools,
  type SearchMode,
  type AddRepoProgress,
} from "@repobase/engine"
import { App } from "./App.js"
import { featureFlags } from "./config.js"
import { addRepoProgress, jobFailed, jobFailureMessage, syncUpdated } from "./jobProgress.js"
import { resumableSync, resumePoint } from "./jobView.js"
import { LAG_ENV, lagSampler } from "./lagSampler.js"

const FORCE_SYNC_ENV = "REPOBASE_FORCE_SYNC"

// File logger for debugging - writes to ~/.repobase/tui.log
const tuiLogPath = logPath("tui")
const FileLogger = fileLoggerLayer(tuiLogPath)

// Worker threads run from source in dev and from the bundled worker.js in dist
const workerUrl = new URL(
  import.meta.url.endsWith(".tsx") ? "./worker.ts" : "./worker.js",
  import.meta.url
)

// One worker per job step at a time, and one job's batches spread over all of them.
// Searches get their own warm worker, unless the budget only allows one.
const hostPools = Effect.map(hostWorkerCount, (workerCount) => ({ workerCount, pools: splitPools(workerCount.count) }))

const JobsLive = Layer.unwrap(
  Effect.gen(function* () {
    const { pools } = yield* hostPools
    const indexing = yield* hostIndexingConcurrency
    return JobRunnerLayer(
      makeJobDefinitions({ ...defaultDefinitionsConfig(), indexingConcurrency: indexing.count }),
      { concurrency: pools.jobs }
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          pools.query > 0 ? layerQueryPool({ workerUrl }) : layerQueryFromIndexingPool,
          JobStoreLayer,
          JobProgressLayer
        ).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              layerWorkerPool({ workerUrl, size: pools.jobs }),
              layerIndexingPool({ workerUrl, size: indexing.count })
            )
          )
        )
      )
    )
  })
)

// Remove runs through RepobaseEngine on this thread. RepoStore is shared
// by the engine and the job definitions.
const EngineLive = Layer.mergeAll(
  RepobaseEngineLayer.pipe(Layer.provide(GitClientLayer), Layer.provide(IndexerLayer)),
  JobsLive
).pipe(Layer.provideMerge(RepoStoreLayer))

// provideMerge (not provide) so the file logger is also part of MainLayer's
// output; in Effect v4 loggers are context references, so a merely-provided
// logger layer would not apply to the programs we run and logs would hit the TUI.
// BunServices is provided last so both the engine and the logger share it.
const MainLayer = EngineLive.pipe(
  Layer.provideMerge(FileLogger),
  Layer.provide(BunServices.layer)
)

// The whole TUI session is one Effect program. MainLayer is built once for the
// session, and BunRuntime.runMain interrupts the program on SIGINT/SIGTERM so
// every finalizer below runs on the way out.
const program = Effect.gen(function* () {
  yield* Effect.log(`TUI starting - logs written to ${tuiLogPath}`)
  const { workerCount, pools } = yield* hostPools
  const indexing = yield* hostIndexingConcurrency
  const forceSync = yield* Config.Boolean(FORCE_SYNC_ENV).pipe(Config.withDefault(false))
  const debugLag = yield* Config.Boolean(LAG_ENV).pipe(Config.withDefault(false))
  if (workerCount.warning) yield* Effect.logWarning(workerCount.warning)
  if (indexing.warning) yield* Effect.logWarning(indexing.warning)
  yield* Effect.log(`Workers: ${pools.jobs} for jobs, ${pools.query} for search, ${indexing.count} for indexing`)
  if (debugLag) yield* Effect.forkScoped(lagSampler)
  if (forceSync) yield* Effect.logWarning(`${FORCE_SYNC_ENV}=1: every sync re-indexes all files`)

  const engine = yield* RepobaseEngine
  const runner = yield* JobRunner
  const progress = yield* JobProgress
  const repoStore = yield* RepoStore
  const query = yield* QueryClient

  // Runs effects from React callbacks as fibers owned by this program's scope,
  // so anything still in flight is interrupted on shutdown
  const runPromise = yield* FiberSet.makeRuntimePromise()
  const runFork = yield* FiberSet.makeRuntime()

  // Added before the renderer, so this runs once the renderer has released the
  // terminal and before the worker pools close. runMain only interrupts again on
  // a repeated SIGINT, so a worker that hangs would leave the process running;
  // a Ctrl+C from here on exits right away.
  const workerTotal = pools.jobs + pools.query + indexing.count
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      process.once("SIGINT", () => process.exit(130))
      process.stderr.write(
        `Shutting down up to ${workerTotal} worker threads; a busy one can take up to 5s. Press Ctrl+C to force quit.\n`
      )
    })
  )

  // Disable exitOnCtrlC so shutdown goes through the program's finalizers
  const renderer = yield* Effect.acquireRelease(
    Effect.promise(() => createCliRenderer({ exitOnCtrlC: false })),
    (renderer) => Effect.sync(() => renderer.destroy())
  )

  // Load initial repos
  const initialRepos = yield* engine.listRepos()

  // Cloud config is only checked when the feature is enabled
  const cloudConfigured = featureFlags.cloudSync ? false : false

  // Completed by the App when the user quits
  const quit = yield* Deferred.make<void>()

  // A second quit while the renderer is still up exits right away
  let quitting = false
  const onQuit = () => {
    if (quitting) {
      renderer.destroy()
      process.exit(130)
    }
    quitting = true
    Deferred.doneUnsafe(quit, Effect.void)
  }

  const runSync = (repoId: string) =>
    Effect.gen(function* () {
      const unfinished = resumableSync(yield* runner.jobs, repoId)
      const job = unfinished
        ? yield* runner.retry(unfinished.id)
        : yield* runner.start({ kind: "syncRepo", repoId, payload: { force: forceSync } })
      return {
        job: yield* runner.await(job.id),
        resumedFrom: unfinished ? (resumePoint(unfinished) ?? "where it stopped") : undefined
      }
    })

  // Render the app
  createRoot(renderer).render(
    <App
      initialRepos={initialRepos}
      onAddRepo={(url: string, onProgress: (p: AddRepoProgress) => void) =>
        runPromise(
          Effect.gen(function* () {
            const repoId = yield* Effect.try({
              try: () => deriveRepoId(url),
              catch: () => new Error(`Not a GitHub repository URL: ${url}`)
            })
            const job = yield* runner.start({ kind: "addRepo", repoId, payload: { url } })

            // Show the job's steps and per-file indexing progress in the modal
            const reporter = yield* Stream.zipLatest(runner.changes, progress.changes).pipe(
              Stream.map(([jobs, files]) => {
                const current = jobs.find((j) => j.id === job.id)
                return current ? addRepoProgress(current, files.get(job.id)) : undefined
              }),
              Stream.runForEach((p) => (p ? Effect.sync(() => onProgress(p)) : Effect.void)),
              Effect.forkChild
            )

            const done = yield* runner.await(job.id)
            onProgress(addRepoProgress(done))
            yield* Fiber.interrupt(reporter)
            yield* progress.clear(job.id)

            if (done.status !== "completed") {
              return yield* Effect.fail(new Error(jobFailureMessage(done)))
            }
            return Option.getOrThrow(yield* repoStore.getRepo(repoId))
          })
        )
      }
      onRemoveRepo={(id: string) => runPromise(engine.removeRepo(id))}
      onSyncRepo={(id: string) =>
        runPromise(
          runSync(id).pipe(
            Effect.flatMap(({ job, resumedFrom }) =>
              jobFailed(job)
                ? Effect.fail(new Error(jobFailureMessage(job)))
                : Effect.succeed({ updated: syncUpdated(job), resumedFrom })
            )
          )
        )
      }
      onSyncAll={() =>
        runPromise(
          Effect.gen(function* () {
            const { repos } = yield* repoStore.load()
            // One job per repo, all at once; their batches share the worker pool.
            // A repo that already has a job running is left to that job.
            const runs = yield* Effect.forEach(
              repos,
              (repo) =>
                runSync(repo.id).pipe(
                  Effect.map(Option.some),
                  Effect.catchTag("JobAlreadyRunningError", () => Effect.succeed(Option.none()))
                ),
              { concurrency: "unbounded" }
            )
            const finished = runs.filter(Option.isSome).map((r) => r.value)
            const failed = finished.map((r) => r.job).filter(jobFailed)
            if (failed.length > 0) {
              return yield* Effect.fail(
                new Error(
                  `${failed.length} of ${finished.length} syncs failed; ${failed[0].repoId}: ${jobFailureMessage(failed[0])}`
                )
              )
            }
            return finished.map(({ job, resumedFrom }) => ({
              id: job.repoId,
              updated: syncUpdated(job),
              resumed: resumedFrom !== undefined
            }))
          })
        )
      }
      onRefreshRepos={() => runPromise(engine.listRepos())}
      onSearch={(text: string, mode: SearchMode) =>
        runPromise(query.Search({ query: text, mode }).pipe(Effect.map((results) => [...results])))
      }
      onJobsChange={(listener) => {
        const fiber = runFork(Stream.runForEach(runner.changes, (jobs) => Effect.sync(() => listener(jobs))))
        return () => {
          runFork(Fiber.interrupt(fiber))
        }
      }}
      onRetryJob={(jobId) => runPromise(runner.retry(jobId).pipe(Effect.asVoid))}
      onDiscardJob={(jobId) => runPromise(runner.discard(jobId))}
      onQuit={onQuit}
      cloudConfigured={cloudConfigured}
      workerLimit={pools.jobs}
    />
  )

  yield* Deferred.await(quit)
})

BunRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(MainLayer)))
