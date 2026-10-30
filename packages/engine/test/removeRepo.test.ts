import { describe, it, expect } from "@effect/vitest"
import { Effect, Option } from "effect"
import { JobAlreadyRunningError, JobRunner } from "../src/jobs/JobRunner.js"
import { removeRepoWithJobs } from "../src/jobs/remove.js"
import { reuseOrStart } from "../src/jobs/reuse.js"
import { RepoStore } from "../src/services/RepoStore.js"
import { addRepo, embedFailures, indexedPaths, makeSourceRepo, stepOf, testEnv } from "./fixtures/jobEnv.js"

const REPO = "acme-widgets"

const failAdd = (source: ReturnType<typeof makeSourceRepo>, marker: string) =>
  Effect.gen(function* () {
    source.write("bang.ts", `${marker}\n`)
    source.commit()
    embedFailures.markers.add(marker)
    const failed = yield* addRepo(source.dir)
    expect(failed.status).toBe("failed")
    expect(stepOf(failed, "saveConfig").status).toBe("done")
    embedFailures.markers.delete(marker)
    return failed
  })

const hasRepo = RepoStore.use((store) => store.getRepo(REPO)).pipe(Effect.map(Option.isSome))

const repoJobIds = JobRunner.use((runner) => runner.jobs).pipe(
  Effect.map((jobs) => jobs.filter((job) => job.repoId === REPO).map((job) => job.id))
)

const addAgain = (url: string) =>
  reuseOrStart({ kind: "addRepo", repoId: REPO, payload: { url } }).pipe(
    Effect.flatMap(({ job }) => JobRunner.use((runner) => runner.await(job.id)))
  )

describe("removeRepoWithJobs", () => {
  it.effect("drops the repo's jobs, so adding it again starts afresh instead of resuming a dead add", () => {
    const MARKER = "REMOVE_THEN_READD"
    const source = makeSourceRepo(5)
    const env = testEnv()
    return Effect.gen(function* () {
      const failed = yield* failAdd(source, MARKER)

      yield* removeRepoWithJobs(REPO)
      expect(yield* hasRepo).toBe(false)
      expect(yield* repoJobIds).toEqual([])

      const job = yield* addAgain(source.dir)
      expect(job.id).not.toBe(failed.id)
      expect(job.status).toBe("completed")
      expect(yield* indexedPaths(REPO)).toHaveLength(6)
    }).pipe(
      Effect.provide(env.layer),
      Effect.ensuring(Effect.sync(() => embedFailures.markers.delete(MARKER)))
    )
  })

  it.effect("refuses while one of the repo's jobs is running, and leaves the repo and its jobs", () => {
    const source = makeSourceRepo(5)
    const env = testEnv()
    return Effect.gen(function* () {
      yield* addRepo(source.dir)
      const runner = yield* JobRunner
      const sync = yield* runner.start({ kind: "syncRepo", repoId: REPO, payload: {} })

      const refused = yield* Effect.flip(removeRepoWithJobs(REPO))

      expect(refused).toBeInstanceOf(JobAlreadyRunningError)
      expect(yield* hasRepo).toBe(true)
      expect(yield* repoJobIds).toContain(sync.id)
      yield* runner.await(sync.id)
    }).pipe(Effect.provide(env.layer))
  })

  it.effect("superseding an add while another of the repo's jobs runs removes nothing", () => {
    const MARKER = "SUPERSEDE_WHILE_BUSY"
    const source = makeSourceRepo(5)
    const env = testEnv()
    return Effect.gen(function* () {
      const failed = yield* failAdd(source, MARKER)
      source.write("later.ts", "export const later = true\n")
      source.commit()
      const runner = yield* JobRunner
      const sync = yield* runner.start({ kind: "syncRepo", repoId: REPO, payload: {} })

      const refused = yield* Effect.flip(reuseOrStart({ kind: "addRepo", repoId: REPO, payload: { url: source.dir } }))

      expect(refused).toBeInstanceOf(JobAlreadyRunningError)
      expect(yield* hasRepo).toBe(true)
      expect(yield* repoJobIds).toContain(failed.id)
      yield* runner.await(sync.id)
    }).pipe(
      Effect.provide(env.layer),
      Effect.ensuring(Effect.sync(() => embedFailures.markers.delete(MARKER)))
    )
  })
})
