#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, SubscriptionRef, Stream, Fiber } from "effect"
import {
  RepobaseEngine,
  RepobaseEngineLayer,
  GitClientLayer,
  RepoStoreLayer,
  IndexerLayer,
  initialProgress,
  type RepoConfig,
  type SearchMode,
  type SearchResult,
  type AddRepoProgress,
} from "@repobase/engine"
import { App } from "./App.js"
import { fileLoggerLayer, defaultLogPath } from "./file-logger.js"
import { featureFlags } from "./config.js"

// File logger for debugging - writes to ~/.repobase/tui.log
const FileLogger = fileLoggerLayer()

// Layer composition with file-based logging
const EngineLive = RepobaseEngineLayer.pipe(
  Layer.provide(GitClientLayer),
  Layer.provide(RepoStoreLayer),
  Layer.provide(IndexerLayer)
)

// provideMerge (not provide) so the file logger is also part of MainLayer's
// output; in Effect v4 loggers are context references, so a merely-provided
// logger layer would not apply to the programs we run and logs would hit the TUI.
// BunServices is provided last so both the engine and the logger share it.
const MainLayer = EngineLive.pipe(
  Layer.provideMerge(FileLogger),
  Layer.provide(BunServices.layer)
)

// Helper to run Effect programs
const runEffect = <A, E>(
  effect: Effect.Effect<A, E, RepobaseEngine>
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(MainLayer))) as Promise<A>

// Main entry point
const main = async () => {
  // Log startup to file
  await runEffect(Effect.log(`TUI starting - logs written to ${defaultLogPath}`))
  
  // Create the renderer - disable exitOnCtrlC so we can handle cleanup properly
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
  })
  
  // Handle Ctrl+C (SIGINT) manually for clean shutdown
  process.on('SIGINT', () => {
    renderer.destroy()
    process.exit(0)
  })

  // Load initial repos
  const initialRepos = await runEffect(RepobaseEngine.use((engine) => engine.listRepos()))
  
  // Cloud config is only checked when the feature is enabled
  const cloudConfigured = featureFlags.cloudSync ? false : false

  // Render the app
  createRoot(renderer).render(
    <App
      initialRepos={initialRepos}
      onAddRepo={async (url: string, onProgress: (p: AddRepoProgress) => void) => {
        // Create the effect that sets up progress tracking
        const addWithProgress = Effect.gen(function* () {
          const engine = yield* RepobaseEngine

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
        
        return await runEffect(addWithProgress)
      }}
      onRemoveRepo={async (id: string) => {
        await runEffect(RepobaseEngine.use((engine) => engine.removeRepo(id)))
      }}
      onSyncRepo={async (id: string) => {
        const result = await runEffect(RepobaseEngine.use((engine) => engine.syncRepo(id)))
        return { updated: result.updated }
      }}
      onSyncAll={async () => {
        const results = await runEffect(RepobaseEngine.use((engine) => engine.syncAll()))
        return results.map((r) => ({ id: r.id, updated: r.updated }))
      }}
      onRefreshRepos={async () => {
        return await runEffect(RepobaseEngine.use((engine) => engine.listRepos()))
      }}
      onSearch={async (query: string, mode: SearchMode) => {
        return await runEffect(RepobaseEngine.use((engine) => engine.search(query, mode)))
      }}
      onQuit={() => {
        renderer.destroy()
        process.exit(0)
      }}
      cloudConfigured={cloudConfigured}
    />
  )
}

main().catch((error) => {
  console.error("Failed to start TUI:", error)
  process.exit(1)
})
