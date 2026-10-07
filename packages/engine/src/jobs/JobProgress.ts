import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect"

/**
 * Live per-file progress of a job's indexing. It changes on every file, so it
 * isn't saved with the job; after a restart it starts again from the batches
 * that are already done.
 */
export interface FileProgress {
  readonly filesStarted: number
  readonly totalFiles: number
  // The file most recently started by any of the job's batches
  readonly currentFile?: string
  // The file each running batch (by 0-based index) is on; several run at once
  readonly batches: ReadonlyMap<number, string>
}

export interface JobProgressService {
  // Start tracking a job: `alreadyDone` counts files in batches finished earlier
  readonly begin: (jobId: string, totalFiles: number, alreadyDone: number) => Effect.Effect<void>
  readonly fileStarted: (jobId: string, batch: number, path: string) => Effect.Effect<void>
  // A batch stopped, finished or not: it's no longer on any file
  readonly batchEnded: (jobId: string, batch: number) => Effect.Effect<void>
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
        update(jobId, () => ({ filesStarted: alreadyDone, totalFiles, batches: new Map() })),
      fileStarted: (jobId, batch, path) =>
        update(jobId, (current) =>
          current
            ? {
                ...current,
                filesStarted: Math.min(current.totalFiles, current.filesStarted + 1),
                currentFile: path,
                batches: new Map(current.batches).set(batch, path)
              }
            : undefined
        ),
      batchEnded: (jobId, batch) =>
        update(jobId, (current) => {
          if (!current) return undefined
          const batches = new Map(current.batches)
          batches.delete(batch)
          return { ...current, batches }
        }),
      clear: (jobId) => update(jobId, () => undefined),
      changes: SubscriptionRef.changes(state)
    })
  })
)
