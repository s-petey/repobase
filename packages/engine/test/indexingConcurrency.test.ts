import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Ref, Stream, SubscriptionRef } from "effect"
import { addRepo, EmbedProbe, makeSourceRepo, testEnv } from "./fixtures/jobEnv.js"

// Each job fans its batches out over the pool (2 at once here), and several
// jobs run together, so without a shared limit batches from every job embed
// at the same time. Embeds wait at the closed gate until `inFlight` of them
// run at once, so reaching the limit doesn't depend on timing.
const peakWhileAddingTwoRepos = (inFlight: number, indexingConcurrency?: number) =>
  Effect.gen(function* () {
    const probe = yield* EmbedProbe
    const sources = [makeSourceRepo(150), makeSourceRepo(150)]
    yield* probe.gate.close
    const adding = yield* Effect.forEach(sources, (source, i) => addRepo(source.dir, `acme-widgets-${i}`), {
      concurrency: "unbounded"
    }).pipe(Effect.forkChild)

    yield* SubscriptionRef.changes(probe.inFlight).pipe(
      Stream.takeUntil((running) => running >= inFlight),
      Stream.runDrain
    )
    yield* probe.gate.open

    for (const job of yield* Fiber.join(adding)) expect(job.status).toBe("completed")
    return yield* Ref.get(probe.peak)
  }).pipe(Effect.provide(testEnv({ indexingConcurrency }).layer))

describe("indexing concurrency", () => {
  it.live("embeds one batch at a time with a limit of 1", () =>
    Effect.gen(function* () {
      expect(yield* peakWhileAddingTwoRepos(1, 1)).toBe(1)
    }), 60_000)

  it.live("embeds two batches at once with a limit of 2", () =>
    Effect.gen(function* () {
      expect(yield* peakWhileAddingTwoRepos(2, 2)).toBe(2)
    }), 60_000)

  it.live("embeds batches from both jobs at once without a limit", () =>
    Effect.gen(function* () {
      expect(yield* peakWhileAddingTwoRepos(3)).toBeGreaterThanOrEqual(3)
    }), 60_000)
})
