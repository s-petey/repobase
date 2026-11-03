import { Context, DateTime, Effect, Fiber, FileSystem, Layer, Option, Path, Stream, SubscriptionRef } from "effect"
import {
  GitError,
  IndexError,
  InvalidRepoUrlError,
  RepoAlreadyExistsError,
  RepoNotFoundError,
  SearchError,
  StoreError
} from "../errors.js"
import type {
  AddRepoProgress,
  IndexSummary,
  IndexingProgress,
  RepoConfig,
  RepoMode,
  SearchMode,
  SearchResult,
  SyncResult
} from "../schemas.js"
import { deriveRepoId, migratedRepoId, trackingMode } from "../utils.js"
import { CURRENT_INDEX_FORMAT, needsReindex } from "../indexFormat.js"
import { GitClient } from "./GitClient.js"
import { RepoStore } from "./RepoStore.js"
import { Indexer, type SearchOptions, initialIndexingProgress } from "./Indexer.js"
import * as os from "os"

/**
 * Initial progress state
 */
export const initialProgress: AddRepoProgress = {
  stage: "cloning",
  progress: 0,
  message: "Starting..."
}

/**
 * Calculate overall progress from indexing progress (50-95% range)
 */
const calcIndexingProgress = (indexing: IndexingProgress): number => {
  if (indexing.totalFiles === 0) return 50
  const pct = (indexing.filesProcessed / indexing.totalFiles) * 45 // 45% range for indexing
  return Math.min(95, 50 + pct)
}

/**
 * Options for adding a repository
 */
export interface AddRepoOptions {
  readonly mode?: RepoMode
  readonly progressRef?: SubscriptionRef.SubscriptionRef<AddRepoProgress>
}

/**
 * All possible engine errors
 */
export type EngineError =
  | GitError
  | StoreError
  | IndexError
  | SearchError
  | RepoNotFoundError
  | RepoAlreadyExistsError
  | InvalidRepoUrlError

/**
 * RepobaseEngine service interface
 */
export interface RepobaseEngineService {
  readonly addRepo: (
    url: string,
    options?: AddRepoOptions
  ) => Effect.Effect<RepoConfig, EngineError>
  readonly removeRepo: (id: string) => Effect.Effect<void, EngineError>
  readonly listRepos: () => Effect.Effect<Array<RepoConfig>, EngineError>
  readonly getRepo: (
    id: string
  ) => Effect.Effect<Option.Option<RepoConfig>, EngineError>
  readonly syncRepo: (id: string) => Effect.Effect<SyncResult, EngineError>
  readonly syncAll: () => Effect.Effect<Array<SyncResult>, EngineError>
  readonly reindexRepo: (id: string) => Effect.Effect<IndexSummary & { readonly id: string }, EngineError>
  readonly migrateRepoId: (id: string) => Effect.Effect<string, EngineError>
  readonly search: (
    query: string,
    mode: SearchMode,
    options?: SearchOptions
  ) => Effect.Effect<SearchResult[], EngineError>
}

/**
 * RepobaseEngine service tag
 */
export class RepobaseEngine extends Context.Service<RepobaseEngine, RepobaseEngineService>()(
  "@repobase/engine/RepobaseEngine"
) {}

/**
 * Create the RepobaseEngine service implementation, with clones in `reposDir`
 * (default ~/.repobase/repos)
 */
export const makeWith = (config: { readonly reposDir?: string } = {}) => Effect.gen(function* () {
  const git = yield* GitClient
  const store = yield* RepoStore
  const indexer = yield* Indexer
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const reposDir = config.reposDir ?? path.join(os.homedir(), ".repobase", "repos")

  // An owner's directory under repos/ goes once its last repo is removed
  const removeIfEmptyOwnerDir = (dir: string) =>
    Effect.gen(function* () {
      if (path.dirname(dir) !== reposDir) return
      const entries = yield* fs.readDirectory(dir)
      if (entries.length === 0) yield* fs.remove(dir, { recursive: true })
    }).pipe(Effect.catch(() => Effect.void))

  const addRepo: RepobaseEngineService["addRepo"] = (url, options) =>
    Effect.gen(function* () {
      const progressRef = options?.progressRef

      // Helper to update progress
      const updateProgress = (update: Partial<AddRepoProgress>) =>
        progressRef
          ? SubscriptionRef.update(progressRef, (prev) => ({ ...prev, ...update }))
          : Effect.void

      const id = yield* Effect.try({
        try: () => deriveRepoId(url),
        catch: () => new InvalidRepoUrlError({ url, message: `${url} isn't a GitHub repository URL` })
      })
      const localPath = path.join(reposDir, id)

      // Check if already exists
      const existing = yield* store.getRepo(id)
      if (Option.isSome(existing)) {
        yield* updateProgress({ stage: "error", message: `Repository ${id} already exists` })
        return yield* Effect.fail(new RepoAlreadyExistsError({ id }))
      }

      // Ensure the owner's directory exists: the clone goes in repos/<owner>/<name>
      yield* fs.makeDirectory(path.dirname(localPath), { recursive: true }).pipe(
        Effect.mapError(
          (e) => new StoreError({ operation: "makeDirectory", message: e.message })
        )
      )

      // Clone the repository
      yield* updateProgress({
        stage: "cloning",
        progress: 10,
        message: `Cloning ${url}...`
      })
      yield* Effect.log(`Cloning ${url}...`)
      yield* git.clone(url, localPath, options?.mode)

      yield* updateProgress({
        stage: "cloning",
        progress: 40,
        message: "Clone complete, preparing..."
      })

      // Get current commit
      const currentCommit = yield* git.getCurrentCommit(localPath)

      // Build config: by default, track the branch the clone checked out (the remote's default)
      const mode = options?.mode ?? trackingMode(yield* git.getCurrentBranch(localPath))
      const now = yield* DateTime.now
      const repo: RepoConfig = {
        id,
        url,
        localPath,
        mode,
        lastSyncedCommit: Option.none(),
        lastSyncedAt: Option.none(),
        addedAt: now,
        // Cloud sync fields - disabled by default
        cloudEnabled: false,
        lastPushedAt: Option.none(),
        lastPushedCommit: Option.none(),
        indexFormat: CURRENT_INDEX_FORMAT
      }

      // Save config
      yield* store.addRepo(repo)

      yield* updateProgress({
        stage: "indexing",
        progress: 50,
        message: `Indexing ${id}...`,
        filesIndexed: 0,
        totalFiles: 0
      })

      // Create indexing progress ref for granular updates
      const indexingProgressRef = yield* SubscriptionRef.make<IndexingProgress>(initialIndexingProgress)

      // Subscribe to indexing progress changes and forward them
      const forwarderFiber = yield* Effect.forkChild(
        Stream.runForEach(SubscriptionRef.changes(indexingProgressRef), (indexingState) =>
          Effect.gen(function* () {
            if (!progressRef) return

            const overallProgress = calcIndexingProgress(indexingState)
            const phaseMessage = indexingState.phase === "scanning"
              ? "Scanning files..."
              : indexingState.phase === "finalizing"
                ? "Finalizing index..."
                : `Indexing: ${indexingState.currentFile ?? "..."}`

            yield* SubscriptionRef.update(progressRef, (prev) => ({
              ...prev,
              progress: overallProgress,
              message: phaseMessage,
              filesIndexed: indexingState.filesProcessed,
              totalFiles: indexingState.totalFiles,
              currentFile: indexingState.currentFile
            }))
          })
        ).pipe(Effect.catch(() => Effect.void))
      )

      // Index the repository with progress tracking
      yield* Effect.log(`Indexing ${id}...`)
      const indexResult = yield* indexer.indexRepo(id, localPath, { progressRef: indexingProgressRef })
      yield* Effect.log(
        `Indexed ${indexResult.filesIndexed} files in ${indexResult.durationMs}ms`
      )

      // Clean up forwarder
      yield* Fiber.interrupt(forwarderFiber)

      const synced = {
        lastSyncedCommit: Option.some(currentCommit),
        lastSyncedAt: Option.some(yield* DateTime.now),
        lastSyncedCommitAt: yield* git.getCommitTime(localPath, currentCommit)
      }
      yield* store.updateRepo(id, synced)

      yield* updateProgress({
        stage: "complete",
        progress: 100,
        message: `Added ${id}`,
        filesIndexed: indexResult.filesIndexed,
        totalFiles: indexResult.filesIndexed
      })

      yield* Effect.log(`Added repository: ${id}`)

      return { ...repo, ...synced }
    })

  const removeRepo: RepobaseEngineService["removeRepo"] = (id) =>
    Effect.gen(function* () {
      const repoOpt = yield* store.getRepo(id)
      const repo = yield* Option.match(repoOpt, {
        onNone: () => Effect.fail(new RepoNotFoundError({ id })),
        onSome: Effect.succeed
      })

      // Remove from index first
      yield* Effect.log(`Removing index for ${id}...`)
      yield* indexer.removeIndex(id)

      // Remove files
      yield* fs.remove(repo.localPath, { recursive: true }).pipe(
        Effect.catch(() => Effect.void) // Ignore if already deleted
      )
      yield* removeIfEmptyOwnerDir(path.dirname(repo.localPath))

      // Remove from store
      yield* store.removeRepo(id)
      yield* Effect.log(`Removed repository: ${id}`)
    })

  const listRepos: RepobaseEngineService["listRepos"] = () =>
    store.load().pipe(Effect.map((d) => [...d.repos]))

  const getRepo: RepobaseEngineService["getRepo"] = (id) => store.getRepo(id)

  const syncRepo: RepobaseEngineService["syncRepo"] = (id) =>
    Effect.gen(function* () {
      const repoOpt = yield* store.getRepo(id)
      const repo = yield* Option.match(repoOpt, {
        onNone: () => Effect.fail(new RepoNotFoundError({ id })),
        onSome: Effect.succeed
      })

      // Pinned repos don't sync
      if (repo.mode._tag === "pinned") {
        yield* Effect.log(`${id}: pinned to ${repo.mode.ref}, skipping sync`)
        return {
          id,
          updated: false,
          previousCommit: repo.lastSyncedCommit,
          currentCommit: Option.getOrElse(
            repo.lastSyncedCommit,
            () => "unknown"
          )
        }
      }

      // Fetch from remote
      yield* Effect.log(`Fetching ${id}...`)
      yield* git.fetch(repo.localPath)

      // Check if update needed; an index in an old format is re-indexed even with nothing new
      const remoteHead = yield* git.getRemoteHead(repo.localPath, repo.mode.branch)
      const previousCommit = repo.lastSyncedCommit
      const outdated = needsReindex(repo)
      const needsUpdate = outdated || Option.match(previousCommit, {
        onNone: () => true,
        onSome: (prev) => prev !== remoteHead
      })

      if (!needsUpdate) {
        yield* Effect.log(`${id}: already up to date`)
        return {
          id,
          updated: false,
          previousCommit,
          currentCommit: remoteHead
        }
      }

      // Get changed files via git diff (if we have a previous commit)
      const changes = yield* Option.match(previousCommit, {
        onNone: () => Effect.succeed([]),
        onSome: (prev) => git.diffNameStatus(repo.localPath, prev, remoteHead)
      })

      // The commit the diff was taken against
      yield* git.resetHard(repo.localPath, remoteHead)

      // Update index
      let indexSummary: IndexSummary
      if (outdated) {
        yield* Effect.log(`Re-indexing every file of ${id} in the current index format...`)
        indexSummary = yield* indexer.indexRepo(id, repo.localPath, { force: true })
      } else if (changes.length > 0) {
        // Incremental indexing
        yield* Effect.log(`Incrementally indexing ${changes.length} changed files...`)
        indexSummary = yield* indexer.indexChanges(id, repo.localPath, changes)
      } else {
        // Full re-index (first sync or no previous commit)
        yield* Effect.log(`Full re-indexing ${id}...`)
        indexSummary = yield* indexer.indexRepo(id, repo.localPath)
      }

      yield* Effect.log(
        `Indexed ${indexSummary.filesIndexed} files, deleted ${indexSummary.filesDeleted} in ${indexSummary.durationMs}ms`
      )

      // Update store
      yield* store.updateRepo(id, {
        lastSyncedCommit: Option.some(remoteHead),
        lastSyncedAt: Option.some(yield* DateTime.now),
        lastSyncedCommitAt: yield* git.getCommitTime(repo.localPath, remoteHead),
        indexFormat: CURRENT_INDEX_FORMAT
      })
      if (outdated) yield* dropLegacyIndexIfUnused

      yield* Effect.log(
        `${id}: updated to ${remoteHead.slice(0, 8)}`
      )

      return {
        id,
        updated: true,
        previousCommit,
        currentCommit: remoteHead,
        indexSummary
      }
    })

  // The legacy index table goes once no repo is in an old format (see LEGACY_FILES_TABLE).
  // Best effort, like the job step: a failure is logged and the next re-index tries again
  const dropLegacyIndexIfUnused = Effect.gen(function* () {
    const { repos } = yield* store.load()
    if (repos.some(needsReindex)) return
    if (yield* indexer.dropLegacyIndex()) yield* Effect.log("Dropped the old index table")
  }).pipe(Effect.catch((e) => Effect.logWarning(`Dropping the old index table failed, will retry: ${e.message}`)))

  const requireRepo = (id: string) =>
    store.getRepo(id).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new RepoNotFoundError({ id })), onSome: Effect.succeed }))
    )

  const migrateRepoId: RepobaseEngineService["migrateRepoId"] = (id) =>
    Effect.gen(function* () {
      const repo = yield* requireRepo(id)
      const newId = migratedRepoId(repo)
      if (newId === undefined) return id

      // Already added again under its new id: this one is a duplicate
      if (Option.isSome(yield* store.getRepo(newId))) {
        yield* Effect.log(`${id} was added again as ${newId}; removing the old copy`)
        yield* removeRepo(id)
        return newId
      }

      // Each step can be re-run, so a migration that stopped partway finishes next time
      const localPath = path.join(reposDir, newId)
      yield* Effect.gen(function* () {
        if (yield* fs.exists(repo.localPath)) {
          yield* fs.makeDirectory(path.dirname(localPath), { recursive: true })
          yield* fs.rename(repo.localPath, localPath)
        }
      }).pipe(Effect.mapError((e) => new StoreError({ operation: "moveClone", message: e.message })))
      yield* indexer.removeIndex(id)
      yield* store.modify((data) => ({
        ...data,
        repos: data.repos.map((r) => (r.id === id ? { ...r, id: newId, localPath } : r))
      }))
      yield* Effect.log(`Renamed ${id} to ${newId}`)
      return newId
    })

  const reindexRepo: RepobaseEngineService["reindexRepo"] = (requestedId) =>
    Effect.gen(function* () {
      const id = yield* migrateRepoId(requestedId)
      const repo = yield* requireRepo(id)
      yield* Effect.log(`Re-indexing every file of ${id} in the current index format...`)
      const summary = yield* indexer.indexRepo(id, repo.localPath, { force: true })
      const lastSyncedCommitAt = yield* git.getCommitTime(repo.localPath, "HEAD")
      yield* store.updateRepo(id, { indexFormat: CURRENT_INDEX_FORMAT, lastSyncedCommitAt })
      yield* dropLegacyIndexIfUnused
      return { ...summary, id }
    })

  const syncAll: RepobaseEngineService["syncAll"] = () =>
    Effect.gen(function* () {
      const data = yield* store.load()
      if (data.repos.length === 0) {
        yield* Effect.log("No repositories to sync")
        return []
      }
      yield* Effect.log(`Syncing ${data.repos.length} repositories...`)
      return yield* Effect.forEach(data.repos, (repo) => syncRepo(repo.id))
    })

  const search: RepobaseEngineService["search"] = (query, mode, options) => {
    switch (mode) {
      case "keyword":
        return indexer.searchKeyword(query, options)
      case "semantic":
        return indexer.searchSemantic(query, options)
      case "hybrid":
        return indexer.searchHybrid(query, options)
    }
  }

  return RepobaseEngine.of({
    addRepo,
    removeRepo,
    listRepos,
    getRepo,
    syncRepo,
    syncAll,
    reindexRepo,
    migrateRepoId,
    search
  })
})

export const make = makeWith()

/**
 * RepobaseEngine layer - requires GitClient, RepoStore, Indexer, FileSystem and Path
 */
export const layer = Layer.effect(RepobaseEngine, make)

/**
 * RepobaseEngine with clones in a custom directory
 */
export const layerWith = (config: { readonly reposDir: string }) => Layer.effect(RepobaseEngine, makeWith(config))
