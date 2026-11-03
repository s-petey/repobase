// No shebang here: Bun.build turns a `#!/usr/bin/env bun` entry into a bundle
// marked `// @bun`, and Bun then decodes that bundle as Latin-1, garbling every
// non-ASCII character in the TUI. dist/bin/repobase.js carries the shebang.
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Cause, Config, Context, Deferred, Effect, Exit, Fiber, FiberSet, Layer, Option, Stream } from "effect"
import {
  RepobaseEngine,
  RepobaseEngineLayer,
  GitClientLayer,
  RepoStoreLayer,
  RepoStore,
  IndexerLayer,
  JobRunner,
  JobRunnerLayer,
  JobStore,
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
  otlpLayer,
  WorkerSettings,
  heldBy,
  jobFailed,
  jobFailureMessage,
  removeRepoWithJobs,
  reuseOrStart,
  runningHere,
  runSync as syncRepo,
  syncUpdated,
  WorkerClient,
  type PoolSizes,
  type SearchMode,
  type AddRepoProgress,
} from "@repobase/engine"
import { App } from "./App.js"
import { featureFlags } from "./config.js"
import { addRepoProgress } from "./jobProgress.js"
import { LAG_ENV, lagSampler } from "./lagSampler.js"
import { filterToGlob, type SearchFilter } from "./searchView.js"
import { shutdown } from "./shutdown.js"

const FORCE_SYNC_ENV = "REPOBASE_FORCE_SYNC"

// File logger for debugging - writes to ~/.repobase/tui.log
const tuiLogPath = logPath("tui")
const FileLogger = fileLoggerLayer(tuiLogPath)

// Worker threads run from source in dev and from the bundled worker.js in dist
const workerUrl = new URL(
  import.meta.url.endsWith(".tsx") ? "./worker.ts" : "./worker.js",
  import.meta.url
)

/**
 * How the worker budget is split: one worker per job step at a time, a warm
 * worker for searches unless the budget only allows one, and the indexing
 * workers every job's batches share
 */
class HostPools extends Context.Service<HostPools, {
  readonly pools: PoolSizes
  readonly indexing: number
}>()("@repobase/tui/HostPools") {
  static readonly layer = Layer.effect(HostPools)(
    Effect.gen(function* () {
      const workerCount = yield* hostWorkerCount
      const indexing = yield* hostIndexingConcurrency
      if (workerCount.warning) yield* Effect.logWarning(workerCount.warning)
      if (indexing.warning) yield* Effect.logWarning(indexing.warning)
      return { pools: splitPools(workerCount.count), indexing: indexing.count }
    })
  )
}

// Unwrapped because the pool sizes, and whether searches get their own worker,
// come from HostPools. A layer value is built once however many layers it's
// provided to, so the runner and the search client share IndexingPool's workers,
// and JobProgressLayer is both offered and used.
const JobsLive = Layer.unwrap(
  Effect.gen(function* () {
    const { pools, indexing } = yield* HostPools
    const IndexingPool = layerIndexingPool({ workerUrl, size: indexing })
    const QueryPool =
      pools.query > 0 ? layerQueryPool({ workerUrl }) : layerQueryFromIndexingPool.pipe(Layer.provide(IndexingPool))
    return Layer.mergeAll(
      JobRunnerLayer(makeJobDefinitions({ ...defaultDefinitionsConfig(), indexingConcurrency: indexing }), {
        concurrency: indexing,
        processName: "tui",
        followOthers: true
      }),
      QueryPool,
      JobProgressLayer
    ).pipe(
      Layer.provide([IndexingPool, JobProgressLayer]),
      Layer.provideMerge(layerWorkerPool({ workerUrl, size: pools.jobs })),
      Layer.provideMerge(JobStoreLayer)
    )
  })
)

// Remove runs through RepobaseEngine on this thread. RepoStore is shared
// by the engine and the job definitions.
const EngineLive = Layer.mergeAll(
  RepobaseEngineLayer.pipe(Layer.provide(GitClientLayer), Layer.provide(IndexerLayer)),
  JobsLive
).pipe(Layer.provideMerge(RepoStoreLayer))

// This thread exports to the same endpoint its workers are sent
const TelemetryLive = Layer.unwrap(
  Effect.gen(function* () {
    const { otlpEndpoint } = yield* WorkerSettings
    return otlpLayer("repobase-tui", Option.fromUndefinedOr(otlpEndpoint))
  })
)

// WorkerSettings and HostPools are each built once, and everything above
// shares them.
// provideMerge (not provide) so the file logger is also part of MainLayer's
// output; in Effect v4 loggers are context references, so a merely-provided
// logger layer would not apply to the programs we run and logs would hit the TUI.
// BunServices is provided last so both the engine and the logger share it.
const MainLayer = EngineLive.pipe(
  Layer.provideMerge(TelemetryLive),
  Layer.provideMerge([WorkerSettings.layer, HostPools.layer]),
  Layer.provideMerge(FileLogger),
  Layer.provide(BunServices.layer)
)

// The whole TUI session is one Effect program. MainLayer is built once for the
// session, and BunRuntime.runMain interrupts the program on SIGINT/SIGTERM so
// every finalizer below runs on the way out.
const program = Effect.gen(function* () {
  yield* Effect.log(`TUI starting - logs written to ${tuiLogPath}`)
  const { pools, indexing } = yield* HostPools
  const forceSync = yield* Config.Boolean(FORCE_SYNC_ENV).pipe(Config.withDefault(false))
  const debugLag = yield* Config.Boolean(LAG_ENV).pipe(Config.withDefault(false))
  yield* Effect.log(`Workers: ${pools.jobs} for jobs, ${pools.query} for search, ${indexing} for indexing`)
  if (debugLag) yield* Effect.forkScoped(lagSampler)
  if (forceSync) yield* Effect.logWarning(`${FORCE_SYNC_ENV}=1: every sync re-indexes all files`)

  const engine = yield* RepobaseEngine
  const runner = yield* JobRunner
  const progress = yield* JobProgress
  const repoStore = yield* RepoStore
  const jobStore = yield* JobStore
  const query = yield* QueryClient
  const jobServices = yield* Effect.context<JobRunner | RepoStore | WorkerClient | RepobaseEngine>()

  // Runs effects from React callbacks as fibers owned by this program's scope,
  // so anything still in flight is interrupted on shutdown
  const runPromise = yield* FiberSet.makeRuntimePromise()
  const runFork = yield* FiberSet.makeRuntime()

  // Added before the renderer, so this runs once the renderer has released the
  // terminal. It exits the process itself, so MainLayer never closes the worker
  // pools (see shutdown.ts). A failure is left to runMain to report.
  yield* Effect.addFinalizer((exit) => {
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) return Effect.void
    return Effect.gen(function* () {
      process.once("SIGINT", () => process.exit(130))
      const running = (yield* runner.jobs).filter(runningHere).length
      yield* shutdown({
        running,
        interruptJobs: runner.interruptAll,
        notice: (message) => process.stderr.write(`${message}\n`),
        exit: (code) => process.exit(code),
        // Quitting from the app succeeds; a signal from outside interrupts the program
        code: Exit.isSuccess(exit) ? 0 : 130
      })
    })
  })

  // Disable exitOnCtrlC so shutdown goes through the program's finalizers
  const renderer = yield* Effect.acquireRelease(
    Effect.promise(() => createCliRenderer({ exitOnCtrlC: false })),
    (renderer) =>
      Effect.promise(() => {
        renderer.destroy()
        return renderer.closed
      })
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

  const runSync = (repoId: string) => syncRepo(repoId, { force: forceSync }).pipe(Effect.provide(jobServices))

  const busyElsewhere = jobStore.heldElsewhere().pipe(
    Effect.flatMap(([held]) =>
      held === undefined
        ? Effect.void
        : Effect.fail(new Error(`${heldBy(held)} is running a task; try again once it's done`))
    )
  )

  // Re-index in the background; false when the repo already has a job running.
  // A repo with an id from before owner/name ids gets its new id first, and its
  // jobs under the old id go: they can't resume under a name the repo no longer has.
  const startReindex = (oldId: string) =>
    Effect.gen(function* () {
      if ((yield* runner.jobs).some((j) => j.repoId === oldId && j.status === "running")) return false
      const repoId = yield* engine.migrateRepoId(oldId)
      if (repoId !== oldId) {
        const stale = (yield* runner.jobs).filter((j) => j.repoId === oldId)
        yield* Effect.forEach(stale, (j) => runner.discard(j.id), { discard: true })
      }
      yield* reuseOrStart({ kind: "reindexRepo", repoId, payload: {} }).pipe(Effect.provide(jobServices))
      return true
    }).pipe(Effect.catchTag("JobAlreadyRunningError", () => Effect.succeed(false)))

  // Render the app
  createRoot(renderer).render(
    <App
      initialRepos={initialRepos}
      onAddRepo={(url: string, onProgress: (p: AddRepoProgress) => void) =>
        runPromise(
          Effect.gen(function* () {
            yield* busyElsewhere
            const repoId = yield* Effect.try({
              try: () => deriveRepoId(url),
              catch: () => new Error(`Not a GitHub repository URL: ${url}`)
            })
            const { job } = yield* reuseOrStart({ kind: "addRepo", repoId, payload: { url } }).pipe(
              Effect.provide(jobServices)
            )

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
      onRemoveRepo={(id: string) =>
        runPromise(busyElsewhere.pipe(Effect.andThen(removeRepoWithJobs(id).pipe(Effect.provide(jobServices)))))
      }
      onSyncRepo={(id: string) =>
        runPromise(
          busyElsewhere.pipe(
            Effect.andThen(runSync(id)),
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
            yield* busyElsewhere
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
      onReindexRepos={(repoIds) =>
        runPromise(
          busyElsewhere.pipe(
            Effect.andThen(Effect.forEach(repoIds, startReindex)),
            Effect.map((started) => started.filter(Boolean).length)
          )
        )
      }
      onSearch={(text: string, mode: SearchMode, filter: SearchFilter | undefined, repos) =>
        runPromise(
          query
            .Search({ query: text, mode, repos, glob: filter ? filterToGlob(filter) : undefined })
            .pipe(Effect.map((results) => [...results]))
        )
      }
      onJobsChange={(listener) => {
        const fiber = runFork(Stream.runForEach(runner.changes, (jobs) => Effect.sync(() => listener(jobs))))
        return () => {
          runFork(Fiber.interrupt(fiber))
        }
      }}
      onProgressChange={(listener) => {
        const fiber = runFork(Stream.runForEach(progress.changes, (files) => Effect.sync(() => listener(files))))
        return () => {
          runFork(Fiber.interrupt(fiber))
        }
      }}
      onRetryJob={(jobId) => runPromise(busyElsewhere.pipe(Effect.andThen(runner.retry(jobId)), Effect.asVoid))}
      onDiscardJob={(jobId) => runPromise(runner.discard(jobId))}
      onQuit={onQuit}
      cloudConfigured={cloudConfigured}
      workerLimit={pools.jobs}
    />
  )

  yield* Deferred.await(quit)
})

BunRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(MainLayer)))
