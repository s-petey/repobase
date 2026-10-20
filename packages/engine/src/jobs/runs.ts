import { Effect } from "effect"
import { JobRunner, type NewJob } from "./JobRunner.js"
import { kindLabel, resumableJob, resumePoint, unfinishedIndexing } from "./view.js"

export const startOrResume = (job: NewJob) =>
  Effect.gen(function* () {
    const runner = yield* JobRunner
    const unfinished = resumableJob(yield* runner.jobs, job.repoId, job.kind)
    const started = unfinished ? yield* runner.retry(unfinished.id) : yield* runner.start(job)
    return { job: started, resumedFrom: unfinished ? (resumePoint(unfinished) ?? "where it stopped") : undefined }
  })

export const runSync = (repoId: string, options: { readonly force?: boolean } = {}) =>
  Effect.gen(function* () {
    const runner = yield* JobRunner
    const sync = startOrResume({ kind: "syncRepo", repoId, payload: { force: options.force ?? false } }).pipe(
      Effect.flatMap(({ job, resumedFrom }) => runner.await(job.id).pipe(Effect.map((done) => ({ job: done, resumedFrom }))))
    )

    const indexing = unfinishedIndexing(yield* runner.jobs, repoId)
    if (!indexing) return yield* sync

    const finished = yield* runner.retry(indexing.id).pipe(Effect.flatMap((job) => runner.await(job.id)))
    const resumedFrom = `${resumePoint(indexing) ?? "where it stopped"} of the unfinished ${kindLabel[indexing.kind]}`
    if (finished.status !== "completed") return { job: finished, resumedFrom }
    return { ...(yield* sync), resumedFrom }
  })
