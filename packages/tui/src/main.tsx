// No shebang here: Bun.build turns a `#!/usr/bin/env bun` entry into a bundle
// marked `// @bun`, and Bun then decodes that bundle as Latin-1, garbling every
// non-ASCII character in the TUI. dist/bin/repobase.js carries the shebang.
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Deferred, Effect, FiberSet, Layer, SubscriptionRef, Stream, Fiber } from "effect"
import {
  RepobaseEngine,
  RepobaseEngineLayer,
  GitClientLayer,
  RepoStoreLayer,
  IndexerLayer,
  initialProgress,
  fileLoggerLayer,
  layerWorkerPool,
  logPath,
  type SearchMode,
  type AddRepoProgress,
} from "@repobase/engine"
import { App } from "./App.js"
import { featureFlags } from "./config.js"

// File logger for debugging - writes to ~/.repobase/tui.log
const tuiLogPath = logPath("tui")
const FileLogger = fileLoggerLayer(tuiLogPath)

// Worker threads run from source in dev and from the bundled worker.js in dist
const workerUrl = new URL(
  import.meta.url.endsWith(".tsx") ? "./worker.ts" : "./worker.js",
  import.meta.url
)

// Layer composition with file-based logging
const EngineLive = Layer.mergeAll(
  RepobaseEngineLayer.pipe(
    Layer.provide(GitClientLayer),
    Layer.provide(RepoStoreLayer),
    Layer.provide(IndexerLayer)
  ),
  layerWorkerPool({ workerUrl })
)

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

  const engine = yield* RepobaseEngine

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

  // Render the app
  createRoot(renderer).render(
    <App
      initialRepos={initialRepos}
      onAddRepo={(url: string, onProgress: (p: AddRepoProgress) => void) =>
        runPromise(
          Effect.gen(function* () {
            // Create a SubscriptionRef for progress updates
            const progressRef = yield* SubscriptionRef.make<AddRepoProgress>(initialProgress)

            // Fork a fiber to listen for progress updates and call the callback
            const listenerFiber = yield* Stream.runForEach(
              SubscriptionRef.changes(progressRef),
              (progress) => Effect.sync(() => onProgress(progress))
            ).pipe(Effect.forkChild)

            // Run addRepo with the progress ref
            const result = yield* engine.addRepo(url, { progressRef })

            // Clean up the listener fiber
            yield* Fiber.interrupt(listenerFiber)

            return result
          })
        )
      }
      onRemoveRepo={(id: string) => runPromise(engine.removeRepo(id))}
      onSyncRepo={(id: string) =>
        runPromise(
          engine.syncRepo(id).pipe(Effect.map((result) => ({ updated: result.updated })))
        )
      }
      onSyncAll={() =>
        runPromise(
          engine
            .syncAll()
            .pipe(Effect.map((results) => results.map((r) => ({ id: r.id, updated: r.updated }))))
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
