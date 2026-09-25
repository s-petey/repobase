import { describe, it, expect } from "@effect/vitest"
import { Effect, Fiber, Option, Stream } from "effect"
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
import { Indexer } from "../src/services/Indexer.js"
import { RepoStore } from "../src/services/RepoStore.js"
import { addRepo, embedFailures, indexedPaths, makeSourceRepo, stepOf, testEnv } from "./fixtures/jobEnv.js"

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
        "finalizeIndex"
      ])
      expect(stepOf(job, "planFullIndex").output).toEqual({ toIndex: 60, toDelete: 0, skipped: 0 })
      expect(stepOf(job, "indexBatch:0").output).toEqual({ indexed: 50, skipped: 0 })
      expect(stepOf(job, "indexBatch:1").output).toEqual({ indexed: 10, skipped: 0 })

      const repo = Option.getOrThrow(yield* RepoStore.use((store) => store.getRepo("acme-widgets")))
      expect(repo.url).toBe(source.dir)
      expect(repo.localPath).toBe(path.join(env.reposDir, "acme-widgets"))
      expect(Option.getOrThrow(repo.lastSyncedCommit)).toBe(source.head())
      expect(nodeFs.existsSync(path.join(repo.localPath, "file-00.ts"))).toBe(true)

      expect(yield* indexedPaths("acme-widgets")).toHaveLength(60)
      const results = yield* Indexer.use((indexer) => indexer.searchKeyword("value42", { repo: "acme-widgets" }))
      expect(results.map((r) => r.path)).toContain("file-42.ts")
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
})
