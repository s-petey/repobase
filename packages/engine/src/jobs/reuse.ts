import { Effect, Option, Schema } from "effect"
import { RepoStore } from "../services/RepoStore.js"
import { WorkerClient } from "../worker/client.js"
import type { Job, JobKind } from "./Job.js"
import { JobRunner, type NewJob } from "./JobRunner.js"
import { resumableJob, resumePoint } from "./view.js"

const PLANNED_COMMIT_STEP: Record<JobKind, string> = {
  addRepo: "resolveHead",
  syncRepo: "resolveRemoteHead",
  reindexRepo: "planFullIndex"
}

const PlannedCommit = Schema.Struct({ commit: Schema.String })

export const plannedCommit = (job: Job): Option.Option<string> =>
  Option.fromNullishOr(job.steps.find((s) => s.key === PLANNED_COMMIT_STEP[job.kind] && s.status === "done")).pipe(
    Option.flatMap((step) => Schema.decodeUnknownOption(PlannedCommit)(step.output)),
    Option.map(({ commit }) => commit)
  )

const currentCommit = (request: NewJob) =>
  Effect.gen(function* () {
    const client = yield* WorkerClient
    const { repoId } = request
    const remoteCommit = (url: string, branch?: string) =>
      client.RemoteBranchHead({ repoId, url, branch }).pipe(Effect.map(({ commit }) => Option.some(commit)))

    if (request.kind === "addRepo") {
      const { url, mode } = request.payload
      return mode?._tag === "pinned" ? Option.none() : yield* remoteCommit(url, mode?.branch)
    }

    const repo = yield* RepoStore.use((store) => store.getRepo(repoId))
    if (Option.isNone(repo)) return Option.none()
    if (request.kind === "reindexRepo") {
      const head = yield* client.ResolveHead({ repoId, localPath: repo.value.localPath })
      return Option.some(head.commit)
    }
    const { url, mode } = repo.value
    return mode._tag === "pinned" ? Option.none() : yield* remoteCommit(url, mode.branch)
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`Could not check whether ${request.repoId} changed: ${error.message}`).pipe(
        Effect.as(Option.none<string>())
      )
    )
  )

/**
 * Whether an unfinished job would still index what `request` asks for. When
 * that can't be told (nothing planned yet, a pinned ref, the remote unreachable),
 * it is.
 */
export const isCurrent = (job: Job, request: NewJob = job) =>
  Effect.gen(function* () {
    if (
      job.kind === "syncRepo" &&
      request.kind === "syncRepo" &&
      (job.payload.force ?? false) !== (request.payload.force ?? false)
    ) {
      return false
    }
    const planned = plannedCommit(job)
    if (Option.isNone(planned)) return true
    const current = yield* currentCommit(request)
    return Option.match(current, { onNone: () => true, onSome: (commit) => commit === planned.value })
  })

export const reuseOrStart = (request: NewJob) =>
  Effect.gen(function* () {
    const runner = yield* JobRunner
    const unfinished = resumableJob(yield* runner.jobs, request.repoId, request.kind)
    if (unfinished && (yield* isCurrent(unfinished, request))) {
      return { job: yield* runner.retry(unfinished.id), resumedFrom: resumePoint(unfinished) ?? "where it stopped" }
    }
    const job = yield* runner.start(request)
    if (unfinished) yield* runner.supersede(unfinished.id, job.id)
    return { job, resumedFrom: undefined }
  })
