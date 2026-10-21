import { Effect } from "effect"
import type { Job } from "./Job.js"
import { JobRunner, type NewJob } from "./JobRunner.js"
import { isCurrent, reuseOrStart } from "./reuse.js"
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
    const startSync = reuseOrStart({ kind: "syncRepo", repoId, payload: { force: options.force ?? false } })
    const finish = (started: { readonly job: Job; readonly resumedFrom: string | undefined }) =>
      runner.await(started.job.id).pipe(Effect.map((job) => ({ ...started, job })))

    const indexing = unfinishedIndexing(yield* runner.jobs, repoId)
    if (!indexing) return yield* finish(yield* startSync)

    if (!(yield* isCurrent(indexing))) {
      const started = yield* startSync
      yield* runner.supersede(indexing.id, started.job.id)
      return yield* finish(started)
    }

    const finished = yield* runner.retry(indexing.id).pipe(Effect.flatMap((job) => runner.await(job.id)))
    const resumedFrom = `${resumePoint(indexing) ?? "where it stopped"} of the unfinished ${kindLabel[indexing.kind]}`
    if (finished.status !== "completed") return { job: finished, resumedFrom }
    return { ...(yield* finish(yield* startSync)), resumedFrom }
  })
