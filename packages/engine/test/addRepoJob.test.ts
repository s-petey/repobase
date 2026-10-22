import { describe, it, expect } from "@effect/vitest"
import { DateTime, Effect, Fiber, Option, Stream } from "effect"
import * as nodeFs from "node:fs"
import * as path from "node:path"
import {
  CloneFailedError,
  formatStepError,
  IndexBatchFailedError,
  isRetryable,
  RepoAlreadyAddedError
} from "../src/jobs/errors.js"
import { JobProgress } from "../src/jobs/JobProgress.js"
import { JobRunner } from "../src/jobs/JobRunner.js"
import { reuseOrStart } from "../src/jobs/reuse.js"
import { Indexer } from "../src/services/Indexer.js"
import { RepoStore } from "../src/services/RepoStore.js"
import { pinnedMode, trackingMode } from "../src/utils.js"
import {
  addRepo,
  embedFailures,
  indexedPaths,
  makeSourceRepo,
  stepOf,
  syncRepo,
  testEnv
} from "./fixtures/jobEnv.js"

describe("addRepo job", () => {
  it.effect("clones, saves the config and indexes in batches", () => {
    const source = makeSourceRepo()
    const env = testEnv()
    return Effect.gen(function* () {
      const job = yield* addRepo(source.dir)

      expect(job.status).toBe("completed")
      expect(job.steps.map((s) => s.key)).toEqual([
        "checkAbsent",
        "clone",
        "resolveHead",
        "saveConfig",
        "planFullIndex",
        "deleteRemoved",
        "indexBatch",
        "indexBatch:0",
        "indexBatch:1",
        "finalizeIndex",
        "recordSynced"
      ])
      expect(stepOf(job, "planFullIndex").output).toEqual({ toIndex: 60, toDelete: 0, skipped: 0 })
      expect(stepOf(job, "indexBatch:0").output).toEqual({ indexed: 50, skipped: 0 })
      expect(stepOf(job, "indexBatch:1").output).toEqual({ indexed: 10, skipped: 0 })

      const repo = Option.getOrThrow(yield* RepoStore.use((store) => store.getRepo("acme-widgets")))
      expect(repo.url).toBe(source.dir)
      expect(repo.localPath).toBe(path.join(env.reposDir, "acme-widgets"))
      expect(Option.getOrThrow(repo.lastSyncedCommit)).toBe(source.head())
      expect(repo.lastSyncedCommitAt && DateTime.toEpochMillis(repo.lastSyncedCommitAt)).toBe(source.commitTime())
      expect(nodeFs.existsSync(path.join(repo.localPath, "file-00.ts"))).toBe(true)

      expect(yield* indexedPaths("acme-widgets")).toHaveLength(60)
      const results = yield* Indexer.use((indexer) => indexer.searchKeyword("value42", { repo: "acme-widgets" }))
      expect(results.map((r) => r.path)).toContain("file-42.ts")
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("adds, syncs and searches a repo whose id is GitHub's owner/name", () => {
    const source = makeSourceRepo()
    const env = testEnv()
    return Effect.gen(function* () {
      const added = yield* addRepo(source.dir, "acme/widgets")
      expect(added.status).toBe("completed")

      const repo = Option.getOrThrow(yield* RepoStore.use((store) => store.getRepo("acme/widgets")))
      expect(repo.localPath).toBe(path.join(env.reposDir, "acme", "widgets"))
      expect(nodeFs.existsSync(path.join(repo.localPath, "file-00.ts"))).toBe(true)

      source.write("file-00.ts", "export const changed = true\n")
      source.commit()
      const synced = yield* syncRepo("acme/widgets")
      expect(synced.status).toBe("completed")
      expect(stepOf(synced, "planChanges").output).toMatchObject({ toIndex: 1 })

      const results = yield* Indexer.use((indexer) => indexer.searchKeyword("changed", { repo: "acme/widgets" }))
      expect(results.map((r) => r.path)).toContain("file-00.ts")
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("tracks the repo's default branch, even when it isn't main", () => {
    const source = makeSourceRepo(3, "master")
    const env = testEnv()
    return Effect.gen(function* () {
      expect((yield* addRepo(source.dir)).status).toBe("completed")

      const repo = Option.getOrThrow(yield* RepoStore.use((store) => store.getRepo("acme-widgets")))
      expect(repo.mode).toEqual({ _tag: "tracking", branch: "master" })

      // And syncing that branch works
      source.write("new.ts", "export const n = 1\n")
      source.commit()
      const sync = yield* syncRepo()
      expect(sync.status).toBe("completed")
      expect(stepOf(sync, "updateStore").status).toBe("done")
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("clones and tracks a branch that isn't the default", () => {
    const source = makeSourceRepo(3)
    source.branch("dev")
    source.write("main-only.ts", "export const m = 1\n")
    source.commit()
    const env = testEnv()
    return Effect.gen(function* () {
      const job = yield* JobRunner.use((runner) =>
        runner
          .start({ kind: "addRepo", repoId: "acme-widgets", payload: { url: source.dir, mode: trackingMode("dev") } })
          .pipe(Effect.flatMap((j) => runner.await(j.id)))
      )
      expect(job.status).toBe("completed")

      const repo = Option.getOrThrow(yield* RepoStore.use((store) => store.getRepo("acme-widgets")))
      expect(repo.mode).toEqual({ _tag: "tracking", branch: "dev" })
      expect(yield* indexedPaths("acme-widgets")).not.toContain("main-only.ts")
      expect((yield* syncRepo()).status).toBe("completed")
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("checks out a pinned ref, not the default branch", () => {
    const source = makeSourceRepo(3, "master")
    source.tag("v1.0.0")
    source.write("after-tag.ts", "export const later = 1\n")
    source.commit()
    const env = testEnv()
    return Effect.gen(function* () {
      const job = yield* JobRunner.use((runner) =>
        runner
          .start({
            kind: "addRepo",
            repoId: "acme-widgets",
            payload: { url: source.dir, mode: pinnedMode("v1.0.0") }
          })
          .pipe(Effect.flatMap((j) => runner.await(j.id)))
      )
      expect(job.status).toBe("completed")

      const repo = Option.getOrThrow(yield* RepoStore.use((store) => store.getRepo("acme-widgets")))
      expect(repo.mode).toEqual({ _tag: "pinned", ref: "v1.0.0" })
      expect(nodeFs.existsSync(path.join(repo.localPath, "after-tag.ts"))).toBe(false)
      expect(yield* indexedPaths("acme-widgets")).toEqual(["file-00.ts", "file-01.ts", "file-02.ts"])
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("reports per-file progress while batches run", () => {
    const source = makeSourceRepo()
    const env = testEnv()
    return Effect.gen(function* () {
      const seen: Array<number> = []
      const progress = yield* JobProgress
      const watcher = yield* progress.changes.pipe(
        Stream.runForEach((all) =>
          Effect.sync(() => {
            for (const p of all.values()) seen.push(p.filesStarted)
          })
        ),
        Effect.forkChild
      )
      yield* Effect.yieldNow

      const job = yield* addRepo(source.dir)
      yield* Fiber.interrupt(watcher)

      expect(job.status).toBe("completed")
      expect(seen.at(-1)).toBe(60)
      expect(new Set(seen).size).toBeGreaterThan(10)
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("fails at clone with a bespoke error when the repo doesn't exist", () => {
    const env = testEnv()
    return Effect.gen(function* () {
      const job = yield* addRepo("/nonexistent/source/repo")

      expect(job.status).toBe("failed")
      const error = stepOf(job, "clone").error
      expect(error).toBeInstanceOf(CloneFailedError)
      expect(error && formatStepError(error).title).toBe("Clone failed: repository not found")
      expect(stepOf(job, "saveConfig").status).toBe("pending")
      expect(Option.isNone(yield* RepoStore.use((store) => store.getRepo("acme-widgets")))).toBe(true)
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("refuses to add a repo twice, without a retry", () => {
    const source = makeSourceRepo(3)
    const env = testEnv()
    return Effect.gen(function* () {
      expect((yield* addRepo(source.dir)).status).toBe("completed")

      const second = yield* addRepo(source.dir)

      expect(second.status).toBe("failed")
      const error = stepOf(second, "checkAbsent").error
      expect(error).toBeInstanceOf(RepoAlreadyAddedError)
      expect(error && isRetryable(error)).toBe(false)
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("retries only the failed batch", () => {
    const source = makeSourceRepo()
    source.write("file-55.ts", "EXPLODE\n")
    source.commit("boom")
    const env = testEnv()
    return Effect.gen(function* () {
      embedFailures.explode = true
      const failed = yield* addRepo(source.dir)

      // Glob order decides which batch file-55.ts lands in; exactly one fails
      expect(failed.status).toBe("failed")
      const batches = failed.steps.filter((s) => s.key.startsWith("indexBatch:"))
      const bad = batches.filter((s) => s.status === "failed")
      const good = batches.filter((s) => s.status === "done")
      expect(bad).toHaveLength(1)
      expect(good).toHaveLength(1)
      const error = bad[0].error
      expect(error).toBeInstanceOf(IndexBatchFailedError)
      expect(error && formatStepError(error).title).toMatch(
        /^Indexing batch [12]\/2 failed while embedding file-55\.ts$/
      )

      embedFailures.explode = false
      const runner = yield* JobRunner
      yield* runner.retry(failed.id)
      const job = yield* runner.await(failed.id)

      expect(job.status).toBe("completed")
      expect(stepOf(job, good[0].key).attempts).toBe(1)
      expect(stepOf(job, bad[0].key).attempts).toBe(2)
      expect(stepOf(job, "clone").attempts).toBe(1)
      expect(yield* indexedPaths("acme-widgets")).toHaveLength(60)
    }).pipe(
      Effect.provide(env.layer),
      Effect.ensuring(Effect.sync(() => (embedFailures.explode = false)))
    )
  }, 60_000)

  it.effect("isn't synced until it's indexed, so a sync after it stops partway indexes the rest", () => {
    const marker = "FAIL_UNTIL_SYNC"
    const source = makeSourceRepo()
    source.write("file-55.ts", `${marker}\n`)
    source.commit("boom")
    const env = testEnv()
    return Effect.gen(function* () {
      embedFailures.markers.add(marker)
      const failed = yield* addRepo(source.dir)
      expect(failed.status).toBe("failed")
      const indexed = (yield* indexedPaths("acme-widgets")).length
      expect(indexed).toBeLessThan(60)

      // The repo is saved, but not as synced at the cloned commit
      const repo = Option.getOrThrow(yield* RepoStore.use((store) => store.getRepo("acme-widgets")))
      expect(Option.isNone(repo.lastSyncedCommit)).toBe(true)

      // So a sync with nothing new on the remote still finishes the indexing,
      // re-embedding only the files that are missing
      embedFailures.markers.delete(marker)
      const synced = yield* syncRepo()
      expect(synced.status).toBe("completed")
      expect(stepOf(synced, "planChanges").output).toMatchObject({ toIndex: 60 - indexed, fullScan: true })
      expect(yield* indexedPaths("acme-widgets")).toHaveLength(60)
      const after = Option.getOrThrow(yield* RepoStore.use((store) => store.getRepo("acme-widgets")))
      expect(Option.getOrThrow(after.lastSyncedCommit)).toBe(source.head())
    }).pipe(
      Effect.provide(env.layer),
      Effect.ensuring(Effect.sync(() => embedFailures.markers.delete(marker)))
    )
  }, 60_000)
})

describe("adding again after an add failed partway", () => {
  const REPO = "acme-widgets"

  const failAdd = (source: ReturnType<typeof makeSourceRepo>, marker: string) =>
    Effect.gen(function* () {
      source.write("bang.ts", `${marker}\n`)
      source.commit()
      embedFailures.markers.add(marker)
      const failed = yield* addRepo(source.dir)
      expect(failed.status).toBe("failed")
      expect(stepOf(failed, "saveConfig").status).toBe("done")
      embedFailures.markers.delete(marker)
      return failed
    })

  const addAgain = (url: string) =>
    reuseOrStart({ kind: "addRepo", repoId: REPO, payload: { url } }).pipe(
      Effect.flatMap(({ job, resumedFrom }) =>
        JobRunner.use((runner) => runner.await(job.id)).pipe(Effect.map((done) => ({ job: done, resumedFrom })))
      )
    )

  it.effect("resumes it while the remote is where it cloned from", () => {
    const MARKER = "ADD_AGAIN_RESUME"
    const source = makeSourceRepo(5)
    const env = testEnv()
    return Effect.gen(function* () {
      const failed = yield* failAdd(source, MARKER)

      const { job, resumedFrom } = yield* addAgain(source.dir)

      expect(job.id).toBe(failed.id)
      expect(job.status).toBe("completed")
      expect(resumedFrom).toBe("indexBatch")
      expect(stepOf(job, "clone").attempts).toBe(1)
    }).pipe(
      Effect.provide(env.layer),
      Effect.ensuring(Effect.sync(() => embedFailures.markers.delete(MARKER)))
    )
  })

  it.effect("removes what it left and adds from scratch once the remote moved", () => {
    const MARKER = "ADD_AGAIN_MOVED"
    const source = makeSourceRepo(5)
    const env = testEnv()
    return Effect.gen(function* () {
      const failed = yield* failAdd(source, MARKER)
      source.write("later.ts", "export const later = true\n")
      source.commit()

      const { job, resumedFrom } = yield* addAgain(source.dir)

      expect(job.id).not.toBe(failed.id)
      expect(job.status).toBe("completed")
      expect(resumedFrom).toBeUndefined()
      const runner = yield* JobRunner
      yield* runner.changes.pipe(
        Stream.filter((jobs) => !jobs.some((j) => j.id === failed.id)),
        Stream.runHead
      )
      const { repos } = yield* RepoStore.use((store) => store.load())
      expect(repos.filter((r) => r.id === REPO)).toHaveLength(1)
      expect(Option.getOrThrow(repos[0].lastSyncedCommit)).toBe(source.head())
      expect(yield* indexedPaths(REPO)).toHaveLength(7)
    }).pipe(
      Effect.provide(env.layer),
      Effect.ensuring(Effect.sync(() => embedFailures.markers.delete(MARKER)))
    )
  })
})
