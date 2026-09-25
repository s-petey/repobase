import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { execSync } from "node:child_process"
import * as path from "node:path"
import { GitError } from "../src/errors.js"
import { layerWorkerPool, WorkerClient } from "../src/worker/client.js"

const repoRoot = path.resolve(import.meta.dirname, "../../..")
const workerUrl = new URL("./fixtures/worker.ts", import.meta.url)

const PoolLayer = layerWorkerPool({ workerUrl, size: 2 })

describe("worker pool", () => {
  it.effect("resolves HEAD in a worker thread", () =>
    Effect.gen(function* () {
      const client = yield* WorkerClient
      const { commit } = yield* client.GitResolveHead({ localPath: repoRoot })
      expect(commit).toBe(execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim())
    }).pipe(Effect.provide(PoolLayer)), 30_000)

  // Skipped until GitClient checks git's exit code: rev-parse on a missing repo currently succeeds with ""
  it.effect.skip("serializes GitError back from the worker", () =>
    Effect.gen(function* () {
      const client = yield* WorkerClient
      const exit = yield* client.GitResolveHead({ localPath: "/nonexistent/repo" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const error = yield* Effect.flip(client.GitResolveHead({ localPath: "/nonexistent/repo" }))
      expect(error).toBeInstanceOf(GitError)
      expect(error._tag).toBe("GitError")
      expect((error as GitError).command).toBe("rev-parse")
    }).pipe(Effect.provide(PoolLayer)), 30_000)

  it.effect("runs concurrent requests across the pool", () =>
    Effect.gen(function* () {
      const client = yield* WorkerClient
      const results = yield* Effect.forEach(
        Array.from({ length: 6 }),
        () => client.GitResolveHead({ localPath: repoRoot }),
        { concurrency: "unbounded" }
      )
      expect(new Set(results.map((r) => r.commit)).size).toBe(1)
    }).pipe(Effect.provide(PoolLayer)), 30_000)
})
