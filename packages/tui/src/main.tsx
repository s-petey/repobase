// No shebang here: Bun.build turns a `#!/usr/bin/env bun` entry into a bundle
// marked `// @bun`, and Bun then decodes that bundle as Latin-1, garbling every
// non-ASCII character in the TUI. dist/bin/repobase.js carries the shebang.
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Fiber, FiberSet, Layer, Option, Stream } from "effect"
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
  trackingMode,
  fileLoggerLayer,
  layerWorkerPool,
  logPath,
  resolveHostWorkerCount,
  splitPools,
  type SearchMode,
  type AddRepoProgress,
} from "@repobase/engine"
import { App } from "./App.js"
import { featureFlags } from "./config.js"
import { addRepoProgress, jobFailed, jobFailureMessage, syncUpdated } from "./jobProgress.js"

// File logger for debugging - writes to ~/.repobase/tui.log
const tuiLogPath = logPath("tui")
const FileLogger = fileLoggerLayer(tuiLogPath)

// Worker threads run from source in dev and from the bundled worker.js in dist
const workerUrl = new URL(
  import.meta.url.endsWith(".tsx") ? "./worker.ts" : "./worker.js",
  import.meta.url
)

// One worker per job step at a time, and one job's batches spread over all of them
const workerCount = resolveHostWorkerCount()
const jobWorkers = splitPools(workerCount.count).jobs

// Add and sync run as jobs: steps checkpointed on disk, heavy work on workers
const JobsLive = JobRunnerLayer(makeJobDefinitions(defaultDefinitionsConfig()), {
  concurrency: jobWorkers
}).pipe(
  Layer.provideMerge(
    Layer.mergeAll(layerWorkerPool({ workerUrl, size: jobWorkers }), JobStoreLayer, JobProgressLayer)
  )
)

// Search and remove still run through RepobaseEngine on this thread. RepoStore
// is shared by the engine and the job definitions.
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
  if (workerCount.warning) yield* Effect.logWarning(workerCount.warning)

  const engine = yield* RepobaseEngine
  const runner = yield* JobRunner
  const progress = yield* JobProgress
  const repoStore = yield* RepoStore

  // Runs effects from React callbacks as fibers owned by this program's scope,
  // so anything still in flight is interrupted on shutdown
  const runPromise = yield* FiberSet.makeRuntimePromise()

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

  // Run a sync job to the end
  const runSync = (repoId: string) =>
    runner
      .start({ kind: "syncRepo", repoId, payload: {} })
      .pipe(Effect.flatMap((job) => runner.await(job.id)))

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
            const job = yield* runner.start({
              kind: "addRepo",
              repoId,
              payload: { url, mode: trackingMode("main") }
            })

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
            Effect.flatMap((job) =>
              jobFailed(job)
                ? Effect.fail(new Error(jobFailureMessage(job)))
                : Effect.succeed({ updated: syncUpdated(job) })
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
            const jobs = yield* Effect.forEach(
              repos,
              (repo) =>
                runSync(repo.id).pipe(
                  Effect.map(Option.some),
                  Effect.catchTag("JobAlreadyRunningError", () => Effect.succeed(Option.none()))
                ),
              { concurrency: "unbounded" }
            )
            const finished = jobs.filter(Option.isSome).map((j) => j.value)
            const failed = finished.filter(jobFailed)
            if (failed.length > 0) {
              return yield* Effect.fail(
                new Error(
                  `${failed.length} of ${finished.length} syncs failed; ${failed[0].repoId}: ${jobFailureMessage(failed[0])}`
                )
              )
            }
            return finished.map((job) => ({ id: job.repoId, updated: syncUpdated(job) }))
          })
        )
      }
      onRefreshRepos={() => runPromise(engine.listRepos())}
      onSearch={(query: string, mode: SearchMode) => runPromise(engine.search(query, mode))}
      onQuit={() => {
        Deferred.doneUnsafe(quit, Effect.void)
      }}
      cloudConfigured={cloudConfigured}
    />
  )

  yield* Deferred.await(quit)
})

BunRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(MainLayer)))
