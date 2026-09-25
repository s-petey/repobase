import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect"

/**
 * Live per-file progress of a job's indexing. It changes on every file, so it
 * isn't saved with the job; after a restart it starts again from the batches
 * that are already done.
 */
export interface FileProgress {
  readonly filesStarted: number
  readonly totalFiles: number
  readonly currentFile?: string
}

export interface JobProgressService {
  // Start tracking a job: `alreadyDone` counts files in batches finished earlier
  readonly begin: (jobId: string, totalFiles: number, alreadyDone: number) => Effect.Effect<void>
  readonly fileStarted: (jobId: string, path: string) => Effect.Effect<void>
  readonly clear: (jobId: string) => Effect.Effect<void>
  readonly changes: Stream.Stream<ReadonlyMap<string, FileProgress>>
}

export class JobProgress extends Context.Service<JobProgress, JobProgressService>()(
  "@repobase/engine/JobProgress"
) {}

export const layer: Layer.Layer<JobProgress> = Layer.effect(
  JobProgress,
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<ReadonlyMap<string, FileProgress>>(new Map())
    const update = (jobId: string, f: (current: FileProgress | undefined) => FileProgress | undefined) =>
      SubscriptionRef.update(state, (all) => {
        const next = new Map(all)
        const value = f(all.get(jobId))
        if (value) next.set(jobId, value)
        else next.delete(jobId)
        return next
      })

    return JobProgress.of({
      begin: (jobId, totalFiles, alreadyDone) =>
        update(jobId, () => ({ filesStarted: alreadyDone, totalFiles })),
      fileStarted: (jobId, path) =>
        update(jobId, (current) =>
          current
            ? { ...current, filesStarted: Math.min(current.totalFiles, current.filesStarted + 1), currentFile: path }
            : undefined
        ),
      clear: (jobId) => update(jobId, () => undefined),
      changes: SubscriptionRef.changes(state)
    })
  })
)
