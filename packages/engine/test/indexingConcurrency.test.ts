import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { addRepo, embedConcurrency, makeSourceRepo, testEnv } from "./fixtures/jobEnv.js"

// Each job fans its batches out over the pool (2 at once here), and several
// jobs run together, so without a shared limit batches from every job embed
// at the same time
const peakWhileAddingTwoRepos = (indexingConcurrency?: number) =>
  Effect.gen(function* () {
    const sources = [makeSourceRepo(150), makeSourceRepo(150)]
    embedConcurrency.peak = 0
    const jobs = yield* Effect.forEach(sources, (source, i) => addRepo(source.dir, `acme-widgets-${i}`), {
      concurrency: "unbounded"
    })
    for (const job of jobs) expect(job.status).toBe("completed")
    return embedConcurrency.peak
  }).pipe(Effect.provide(testEnv({ indexingConcurrency }).layer))

describe("indexing concurrency", () => {
  // One test, so the cases run one after another: they share the embed counter,
  // and the engine's tests otherwise run concurrently
  it.live("limits how many batches embed at once across all jobs", () =>
    Effect.gen(function* () {
      expect(yield* peakWhileAddingTwoRepos(1)).toBe(1)
      expect(yield* peakWhileAddingTwoRepos(2)).toBe(2)
      expect(yield* peakWhileAddingTwoRepos()).toBeGreaterThan(2)
    }), 180_000)
})
