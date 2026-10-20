import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { execSync } from "node:child_process"
import * as path from "node:path"
import { ResolveHeadFailedError } from "../src/jobs/errors.js"
import {
  IndexingClient,
  layerIndexingPool,
  layerQueryFromIndexingPool,
  layerQueryPool,
  layerWorkerPool,
  QueryClient,
  WorkerClient
} from "../src/worker/client.js"
import { WorkerSettings } from "../src/worker/settings.js"

const repoRoot = path.resolve(import.meta.dirname, "../../..")
const workerUrl = new URL("./fixtures/worker.ts", import.meta.url)
const Settings = Layer.succeed(WorkerSettings, { embedLog: "fatal" })

const PoolLayer = layerWorkerPool({ workerUrl, size: 2 }).pipe(Layer.provide(Settings))

// These run real worker threads, so they use the real clock (it.live): shutting
// down an idle worker waits on a timer that the test clock would never advance.

describe("worker pool", () => {
  it.live("resolves HEAD in a worker thread", () =>
    Effect.gen(function* () {
      const client = yield* WorkerClient
      const { commit, branch } = yield* client.ResolveHead({ repoId: "repobase", localPath: repoRoot })
      expect(commit).toBe(execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim())
      expect(branch).toBe(execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot }).toString().trim())
    }).pipe(Effect.provide(PoolLayer)), 30_000)

  it.live("serializes the step error back from the worker", () =>
    Effect.gen(function* () {
      const client = yield* WorkerClient
      const error = yield* Effect.flip(
        client.ResolveHead({ repoId: "missing", localPath: "/nonexistent/repo" })
      )
      expect(error).toBeInstanceOf(ResolveHeadFailedError)
      expect((error as ResolveHeadFailedError).repoId).toBe("missing")
      expect((error as ResolveHeadFailedError).message).toContain("/nonexistent/repo")
    }).pipe(Effect.provide(PoolLayer)), 30_000)

  it.live("runs concurrent requests across the pool", () =>
    Effect.gen(function* () {
      const client = yield* WorkerClient
      const results = yield* Effect.forEach(
        Array.from({ length: 6 }),
        () => client.ResolveHead({ repoId: "repobase", localPath: repoRoot }),
        { concurrency: "unbounded" }
      )
      expect(new Set(results.map((r) => r.commit)).size).toBe(1)
    }).pipe(Effect.provide(PoolLayer)), 30_000)
})

describe("query pool", () => {
  it.live("serves requests from its own worker thread", () =>
    Effect.gen(function* () {
      const query = yield* QueryClient
      const { commit } = yield* query.ResolveHead({ repoId: "repobase", localPath: repoRoot })
      expect(commit).toBe(execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim())
    }).pipe(Effect.provide(layerQueryPool({ workerUrl }).pipe(Layer.provide(Settings)))), 30_000)

  it.live("shares the indexing workers' client when it has no worker of its own", () =>
    Effect.gen(function* () {
      // Compared as a boolean: printing an RPC client (a proxy) on failure never finishes
      expect(Object.is(yield* QueryClient, yield* IndexingClient)).toBe(true)
    }).pipe(
      Effect.provide(layerQueryFromIndexingPool.pipe(Layer.provideMerge(layerIndexingPool({ workerUrl, size: 1 }).pipe(Layer.provide(Settings)))))
    ), 30_000)
})

describe("indexing pool", () => {
  it.live("serves concurrent requests from its fixed set of worker threads", () =>
    Effect.gen(function* () {
      const indexing = yield* IndexingClient
      const results = yield* Effect.forEach(
        Array.from({ length: 4 }),
        () => indexing.ResolveHead({ repoId: "repobase", localPath: repoRoot }),
        { concurrency: "unbounded" }
      )
      expect(new Set(results.map((r) => r.commit)).size).toBe(1)
    }).pipe(Effect.provide(layerIndexingPool({ workerUrl, size: 2 }).pipe(Layer.provide(Settings)))), 30_000)
})
