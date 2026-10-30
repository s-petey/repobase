import { Effect } from "effect"
import { RepobaseEngine } from "../services/RepobaseEngine.js"
import { JobRunner } from "./JobRunner.js"

export const discardJobsAndRemove = (repoId: string) =>
  Effect.gen(function* () {
    const runner = yield* JobRunner
    const jobs = (yield* runner.jobs).filter((job) => job.repoId === repoId)
    yield* Effect.forEach(jobs, (job) => runner.discard(job.id), { discard: true })
    yield* RepobaseEngine.use((engine) => engine.removeRepo(repoId))
  })

export const removeRepoWithJobs = (repoId: string) =>
  JobRunner.use((runner) => runner.whileClaimed(repoId, discardJobsAndRemove(repoId)))
