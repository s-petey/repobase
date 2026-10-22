import { Effect } from "effect"
import { RepobaseEngine } from "../services/RepobaseEngine.js"
import { JobAlreadyRunningError, JobRunner } from "./JobRunner.js"
import { kindLabel } from "./view.js"

export const removeRepoWithJobs = (repoId: string) =>
  Effect.gen(function* () {
    const runner = yield* JobRunner
    const jobs = (yield* runner.jobs).filter((job) => job.repoId === repoId)
    const running = jobs.find((job) => job.status === "running")
    if (running) {
      return yield* new JobAlreadyRunningError({
        repoId,
        message: `A ${kindLabel[running.kind]} of ${repoId} is running; wait for it or discard it in Tasks`
      })
    }
    yield* Effect.forEach(jobs, (job) => runner.discard(job.id), { discard: true })
    yield* RepobaseEngine.use((engine) => engine.removeRepo(repoId))
  })
