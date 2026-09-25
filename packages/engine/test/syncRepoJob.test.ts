import { describe, it, expect } from "@effect/vitest"
import { Effect, Option } from "effect"
import {
  formatStepError,
  IndexBatchFailedError,
  isRetryable,
  RemoteBranchMissingError,
  RepoMissingError
} from "../src/jobs/errors.js"
import { JobRunner } from "../src/jobs/JobRunner.js"
import { Indexer } from "../src/services/Indexer.js"
import { RepoStore } from "../src/services/RepoStore.js"
import { pinnedMode, trackingMode } from "../src/utils.js"
import {
  addRepo,
  embedFailures,
  indexedPaths,
  makeSourceRepo,
  statuses,
  stepOf,
  syncRepo,
  testEnv
} from "./fixtures/jobEnv.js"

const REPO = "acme-widgets"

const lastSyncedCommit = RepoStore.use((store) => store.getRepo(REPO)).pipe(
  Effect.map((repo) => Option.getOrThrow(Option.getOrThrow(repo).lastSyncedCommit))
)

describe("syncRepo job", () => {
  it.effect("stops after resolving the remote head when nothing changed", () => {
    const source = makeSourceRepo(3)
    const env = testEnv()
    return Effect.gen(function* () {
      yield* addRepo(source.dir)

      const job = yield* syncRepo()

      expect(job.status).toBe("completed")
      expect(statuses(job)).toEqual({
        loadRepo: "done",
        fetch: "done",
        resolveRemoteHead: "done",
        resetHard: "skipped",
        planChanges: "skipped",
        deleteRemoved: "skipped",
        indexBatch: "skipped",
        finalizeIndex: "skipped",
        updateStore: "skipped"
      })
      expect(stepOf(job, "resolveRemoteHead").output).toEqual({ commit: source.head(), upToDate: true })
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("indexes only what changed, drops deleted files and records the new commit", () => {
    const source = makeSourceRepo()
    const env = testEnv()
    return Effect.gen(function* () {
      yield* addRepo(source.dir)
      source.write("file-01.ts", "export const zanzibar = 'changed'\n") // modified
      source.write("brand-new.ts", "export const fresh = true\n") // added
      source.remove("file-02.ts") // deleted
      source.rename("file-03.ts", "renamed.ts") // renamed: D + A
      source.commit()

      const job = yield* syncRepo()

      expect(job.status).toBe("completed")
      expect(stepOf(job, "planChanges").output).toEqual({ toIndex: 3, toDelete: 2, skipped: 0, fullScan: false })
      expect(stepOf(job, "deleteRemoved").output).toEqual({ count: 2 })
      expect(stepOf(job, "indexBatch:0").output).toEqual({ indexed: 3, skipped: 0 })
      expect(yield* lastSyncedCommit).toBe(source.head())

      const paths = yield* indexedPaths(REPO)
      expect(paths).toHaveLength(60)
      expect(paths).toContain("brand-new.ts")
      expect(paths).toContain("renamed.ts")
      expect(paths).not.toContain("file-02.ts")
      expect(paths).not.toContain("file-03.ts")
      // The full-text index was rebuilt with the new contents
      const hits = yield* Indexer.use((indexer) => indexer.searchKeyword("zanzibar", { repo: REPO }))
      expect(hits.map((h) => h.path)).toEqual(["file-01.ts"])
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("scans everything when there is no previous commit", () => {
    const source = makeSourceRepo(5)
    const env = testEnv()
    return Effect.gen(function* () {
      yield* addRepo(source.dir)
      yield* RepoStore.use((store) => store.updateRepo(REPO, { lastSyncedCommit: Option.none() }))

      const job = yield* syncRepo()

      expect(job.status).toBe("completed")
      expect(stepOf(job, "planChanges").output).toMatchObject({ fullScan: true })
      expect(yield* lastSyncedCommit).toBe(source.head())
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("skips a pinned repo", () => {
    const source = makeSourceRepo(3)
    const env = testEnv()
    return Effect.gen(function* () {
      yield* addRepo(source.dir)
      yield* RepoStore.use((store) => store.updateRepo(REPO, { mode: pinnedMode("v1.0.0") }))

      const job = yield* syncRepo()

      expect(job.status).toBe("skipped")
      expect(statuses(job)).toMatchObject({ loadRepo: "done", fetch: "skipped", updateStore: "skipped" })
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("fails without a retry when the repo was removed", () => {
    const env = testEnv()
    return Effect.gen(function* () {
      const job = yield* syncRepo("not-added")

      expect(job.status).toBe("failed")
      const error = stepOf(job, "loadRepo").error
      expect(error).toBeInstanceOf(RepoMissingError)
      expect(error && isRetryable(error)).toBe(false)
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("fails without a retry when the tracked branch is gone", () => {
    const source = makeSourceRepo(3)
    const env = testEnv()
    return Effect.gen(function* () {
      yield* addRepo(source.dir)
      yield* RepoStore.use((store) => store.updateRepo(REPO, { mode: trackingMode("gone") }))

      const job = yield* syncRepo()

      expect(job.status).toBe("failed")
      const error = stepOf(job, "resolveRemoteHead").error
      expect(error).toBeInstanceOf(RemoteBranchMissingError)
      expect(error && formatStepError(error).title).toBe("Branch gone no longer exists on the remote")
      expect(error && isRetryable(error)).toBe(false)
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("resumes a failed sync without fetching or resetting again", () => {
    const source = makeSourceRepo(5)
    const env = testEnv()
    return Effect.gen(function* () {
      yield* addRepo(source.dir)
      const before = yield* lastSyncedCommit
      source.write("boom.ts", "EXPLODE\n")
      source.commit()

      embedFailures.explode = true
      const failed = yield* syncRepo()
      expect(failed.status).toBe("failed")
      expect(stepOf(failed, "indexBatch:0").error).toBeInstanceOf(IndexBatchFailedError)
      // The store isn't updated until the sync has fully succeeded
      expect(yield* lastSyncedCommit).toBe(before)

      embedFailures.explode = false
      const runner = yield* JobRunner
      yield* runner.retry(failed.id)
      const job = yield* runner.await(failed.id)

      expect(job.status).toBe("completed")
      expect(stepOf(job, "fetch").attempts).toBe(1)
      expect(stepOf(job, "resetHard").attempts).toBe(1)
      expect(stepOf(job, "planChanges").attempts).toBe(1)
      expect(stepOf(job, "indexBatch:0").attempts).toBe(2)
      expect(yield* lastSyncedCommit).toBe(source.head())
      expect(yield* indexedPaths(REPO)).toContain("boom.ts")
    }).pipe(
      Effect.provide(env.layer),
      Effect.ensuring(Effect.sync(() => (embedFailures.explode = false)))
    )
  }, 60_000)
})
