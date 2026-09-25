import { describe, it, expect } from "@effect/vitest"
import { BunServices } from "@effect/platform-bun"
import { Effect, Fiber, Layer, Option, Ref, Stream } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { execSync } from "node:child_process"
import * as crypto from "node:crypto"
import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { makeJobDefinitions } from "../src/jobs/definitions.js"
import {
  CloneFailedError,
  formatStepError,
  IndexBatchFailedError,
  isRetryable,
  RepoAlreadyAddedError
} from "../src/jobs/errors.js"
import type { Job } from "../src/jobs/Job.js"
import { JobProgress, layer as JobProgressLayer } from "../src/jobs/JobProgress.js"
import { JobRunner, layer as JobRunnerLayer } from "../src/jobs/JobRunner.js"
import { layerWith as JobStoreLayerWith } from "../src/jobs/JobStore.js"
import type { RepoStoreData } from "../src/schemas.js"
import { layer as GitClientLayer } from "../src/services/GitClient.js"
import { Indexer, layerWith as IndexerLayerWith } from "../src/services/Indexer.js"
import { RepoStore } from "../src/services/RepoStore.js"
import { WorkerClient } from "../src/worker/client.js"
import { StepRpcs } from "../src/worker/rpcs.js"
import { HandlersLayer } from "../src/worker/server.js"
import { trackingMode } from "../src/utils.js"

// The addRepo job end to end: the real step definitions and the real worker
// handlers (in-process, through RpcTest instead of a thread), with git, LanceDB
// and the job store in temp directories. Only the embedding model is faked.

const tempDir = (prefix: string) => nodeFs.mkdtempSync(path.join(os.tmpdir(), `repobase-${prefix}-`))

// A git repo with enough files for two index batches
const makeSourceRepo = (files = 60) => {
  const dir = tempDir("source")
  for (let i = 0; i < files; i++) {
    nodeFs.writeFileSync(path.join(dir, `file-${String(i).padStart(2, "0")}.ts`), `export const value${i} = ${i}\n`)
  }
  execSync("git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: dir })
  return { dir, head: execSync("git rev-parse HEAD", { cwd: dir }).toString().trim() }
}

let explode = false
const fakeEmbed = async (text: string) => {
  if (explode && text.includes("EXPLODE")) throw new Error("model crashed")
  const seed = crypto.createHash("sha256").update(text).digest()
  return Array.from({ length: 384 }, (_, i) => seed[i % seed.length] / 255 + 0.01)
}

const MemoryRepoStore = Layer.effect(
  RepoStore,
  Effect.gen(function* () {
    const data = yield* Ref.make<RepoStoreData>({ version: 1, repos: [] })
    const load = () => Ref.get(data)
    return RepoStore.of({
      load,
      save: (next) => Ref.set(data, next),
      getRepo: (id) => load().pipe(Effect.map((d) => Option.fromNullishOr(d.repos.find((r) => r.id === id)))),
      addRepo: (repo) => Ref.update(data, (d) => ({ ...d, repos: [...d.repos, repo] })),
      updateRepo: (id, update) =>
        Ref.update(data, (d) => ({ ...d, repos: d.repos.map((r) => (r.id === id ? { ...r, ...update } : r)) })),
      removeRepo: (id) => Ref.update(data, (d) => ({ ...d, repos: d.repos.filter((r) => r.id !== id) }))
    })
  })
)

const testEnv = () => {
  const reposDir = tempDir("repos")
  const WorkerSide = Layer.mergeAll(GitClientLayer, IndexerLayerWith({ indexDir: tempDir("index"), embed: fakeEmbed }))
  const Workers = Layer.effect(WorkerClient)(RpcTest.makeClient(StepRpcs)).pipe(
    Layer.provide(HandlersLayer),
    Layer.provideMerge(WorkerSide)
  )
  const layer = JobRunnerLayer(makeJobDefinitions({ reposDir }), { concurrency: 2 }).pipe(
    Layer.provideMerge(Layer.mergeAll(Workers, MemoryRepoStore, JobProgressLayer)),
    Layer.provideMerge(JobStoreLayerWith({ dir: tempDir("jobs") })),
    Layer.provide(BunServices.layer)
  )
  return { reposDir, layer }
}

const addRepo = (url: string, repoId = "acme-widgets") =>
  JobRunner.use((runner) =>
    runner
      .start({ kind: "addRepo", repoId, payload: { url, mode: trackingMode("main") } })
      .pipe(Effect.flatMap((job) => runner.await(job.id)))
  )

const stepOf = (job: Job, key: string) => job.steps.find((s) => s.key === key)!

const indexedPaths = (repo: string) =>
  Indexer.use((indexer) => indexer.globFiles("**", { repo, limit: 10_000 })).pipe(
    Effect.map((files) => files.map((f) => f.path).sort())
  )

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
      expect(Option.getOrThrow(repo.lastSyncedCommit)).toBe(source.head)
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
    nodeFs.writeFileSync(path.join(source.dir, "file-55.ts"), "EXPLODE\n")
    execSync("git -c user.email=t@t -c user.name=t commit -qam boom", { cwd: source.dir })
    const env = testEnv()
    return Effect.gen(function* () {
      explode = true
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

      explode = false
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
      Effect.ensuring(Effect.sync(() => (explode = false)))
    )
  }, 60_000)
})
