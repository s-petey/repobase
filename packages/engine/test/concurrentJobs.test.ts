import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { addRepo, makeSourceRepo, testEnv } from "./fixtures/jobEnv.js"

// Several jobs indexing into the one shared LanceDB table at once: each job's
// finalize (compaction and the full-text rebuild) must not fail because
// another job wrote while it ran
describe("concurrent jobs", () => {
  it.live("adds several repositories at once without finalize conflicts", () =>
    Effect.gen(function* () {
      const sources = Array.from({ length: 3 }, () => makeSourceRepo(120))
      const jobs = yield* Effect.forEach(
        sources,
        (source, i) => addRepo(source.dir, `acme-widgets-${i}`),
        { concurrency: "unbounded" }
      )

      for (const job of jobs) {
        const failed = job.steps.find((s) => s.status === "failed")
        expect(failed ? `${failed.key}: ${failed.error?.message} ${failed.error?.cause ?? ""}` : "").toBe("")
        expect(job.status).toBe("completed")
      }
    }).pipe(Effect.provide(testEnv().layer)), 120_000)
})
