import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { IndexingClient, WorkerClient } from "../src/worker/client.js"
import { addRepo, makeSourceRepo, testEnv } from "./fixtures/jobEnv.js"

// The job tests' env refuses RPCs sent to the wrong pool; these check that it
// does, so a passing job test means embedding ran only on the indexing workers
describe("indexing routing", () => {
  it.effect("the job pool refuses index batches, and the indexing pool refuses other steps", () =>
    Effect.gen(function* () {
      const jobs = yield* WorkerClient
      const indexing = yield* IndexingClient
      const request = { jobId: "j", repoId: "r", localPath: "/nowhere", batch: 0, total: 1 }

      expect(() => jobs.IndexBatch(request)).toThrow("IndexBatch ran on the job pool")
      expect(() => indexing.ResolveHead({ repoId: "r", localPath: "/nowhere" })).toThrow(
        "ResolveHead ran on the indexing pool"
      )
      // The indexing pool still serves batches
      expect(Stream.isStream(indexing.IndexBatch(request))).toBe(true)
    }).pipe(Effect.provide(testEnv().layer))
  )

  it.effect("an add indexes through the indexing pool", () => {
    const source = makeSourceRepo(60)
    return Effect.gen(function* () {
      const job = yield* addRepo(source.dir)
      expect(job.status).toBe("completed")
    }).pipe(Effect.provide(testEnv().layer))
  }, 60_000)
})
