import { describe, it, expect } from "@effect/vitest"
import { Effect, Option, Stream } from "effect"
import { type FileProgress, JobProgress, layer as JobProgressLayer } from "../src/jobs/JobProgress.js"

const latest = JobProgress.use((progress) => progress.changes.pipe(Stream.runHead)).pipe(
  Effect.map(Option.getOrElse((): ReadonlyMap<string, FileProgress> => new Map()))
)

describe("JobProgress", () => {
  it.effect("tracks the file each running batch is on, and the overall count", () =>
    Effect.gen(function* () {
      const progress = yield* JobProgress
      yield* progress.begin("job", 10, 2)
      yield* progress.fileStarted("job", 3, "a.ts")
      yield* progress.fileStarted("job", 4, "b.ts")
      yield* progress.fileStarted("job", 3, "c.ts")

      const job = (yield* latest).get("job")!
      expect(job).toMatchObject({ filesStarted: 5, totalFiles: 10, currentFile: "c.ts" })
      expect([...job.batches]).toEqual([
        [3, "c.ts"],
        [4, "b.ts"]
      ])
    }).pipe(Effect.provide(JobProgressLayer))
  )

  it.effect("forgets a batch once it ends", () =>
    Effect.gen(function* () {
      const progress = yield* JobProgress
      yield* progress.begin("job", 10, 0)
      yield* progress.fileStarted("job", 0, "a.ts")
      yield* progress.fileStarted("job", 1, "b.ts")

      yield* progress.batchEnded("job", 0)

      expect([...(yield* latest).get("job")!.batches]).toEqual([[1, "b.ts"]])
    }).pipe(Effect.provide(JobProgressLayer))
  )

  it.effect("ignores files and batch ends for jobs it isn't tracking", () =>
    Effect.gen(function* () {
      const progress = yield* JobProgress
      yield* progress.fileStarted("other", 0, "a.ts")
      yield* progress.batchEnded("other", 0)

      expect((yield* latest).has("other")).toBe(false)
    }).pipe(Effect.provide(JobProgressLayer))
  )
})
