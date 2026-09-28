import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { execSync } from "node:child_process"
import * as path from "node:path"
import { ResolveHeadFailedError } from "../src/jobs/errors.js"
import { layerQueryFromJobPool, layerQueryPool, layerWorkerPool, QueryClient, WorkerClient } from "../src/worker/client.js"

const repoRoot = path.resolve(import.meta.dirname, "../../..")
const workerUrl = new URL("./fixtures/worker.ts", import.meta.url)

const PoolLayer = layerWorkerPool({ workerUrl, size: 2 })

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
    }).pipe(Effect.provide(layerQueryPool({ workerUrl }))), 30_000)

  it.live("shares the job pool's client when it has no worker of its own", () =>
    Effect.gen(function* () {
      // Compared as a boolean: printing an RPC client (a proxy) on failure never finishes
      expect(Object.is(yield* QueryClient, yield* WorkerClient)).toBe(true)
    }).pipe(
      Effect.provide(layerQueryFromJobPool.pipe(Layer.provideMerge(PoolLayer)))
    ), 30_000)
})
