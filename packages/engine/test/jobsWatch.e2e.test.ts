import { describe, expect, it } from "@effect/vitest"
import { BunServices } from "@effect/platform-bun"
import { DateTime, Effect, Fiber, FileSystem, Option, Path, Schema, type Scope, Stream } from "effect"
import { spawnSync } from "node:child_process"
import { Job } from "../src/jobs/Job.js"
import { type JobDefinitions, type JobRunner, make as makeJobRunner } from "../src/jobs/JobRunner.js"
import { JobStore, layerWith } from "../src/jobs/JobStore.js"

const job: Job = {
  id: "syncRepo-acme-widgets-1",
  kind: "syncRepo",
  repoId: "acme-widgets",
  payload: {},
  status: "running",
  createdAt: DateTime.makeUnsafe(0),
  updatedAt: DateTime.makeUnsafe(0),
  steps: []
}

const jobFile = `${job.id}.json`

const watcherStartup = Effect.sleep("100 millis")

const watchFor = (dir: string, matches: (event: FileSystem.WatchEvent) => boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const waiting = yield* fs.watch(dir).pipe(
      Stream.filter(matches),
      Stream.runHead,
      Effect.timeout("5 seconds"),
      Effect.forkChild
    )
    yield* watcherStartup
    return waiting
  })

const inJobsFolder = <A, E>(
  test: (dir: string) => Effect.Effect<A, E, JobStore | FileSystem.FileSystem | Path.Path | Scope.Scope>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "repobase-watch-" })
    return yield* test(dir).pipe(Effect.provide(layerWith({ dir })))
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer))

describe("OS file watching - verification of behavior", { concurrent: false }, () => {
  it.live("sees a new job's file created when the store saves it", () =>
    inJobsFolder((dir) =>
      Effect.gen(function* () {
        const waiting = yield* watchFor(dir, (event) => event.path === jobFile)

        yield* JobStore.use((store) => store.save(job))

        const event = yield* Fiber.join(waiting)
        expect(event).toEqual(Option.some({ _tag: "Create", path: jobFile }))
      })
    ))

  it.live("sees a saved job's file created again, not updated, since the store renames over it", () =>
    inJobsFolder((dir) =>
      Effect.gen(function* () {
        yield* JobStore.use((store) => store.save(job))
        const waiting = yield* watchFor(dir, (event) => event.path === jobFile)

        yield* JobStore.use((store) => store.save({ ...job, status: "completed" }))

        const event = yield* Fiber.join(waiting)
        expect(event).toEqual(Option.some({ _tag: "Create", path: jobFile }))
      })
    ))

  it.live("sees a job's file removed when the store removes it", () =>
    inJobsFolder((dir) =>
      Effect.gen(function* () {
        yield* JobStore.use((store) => store.save(job))
        const waiting = yield* watchFor(dir, (event) => event.path === jobFile && event._tag === "Remove")

        yield* JobStore.use((store) => store.remove(job.id))

        const event = yield* Fiber.join(waiting)
        expect(event).toEqual(Option.some({ _tag: "Remove", path: jobFile }))
      })
    ))

  it.live("sees a job's file another process writes", () =>
    inJobsFolder((dir) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const waiting = yield* watchFor(dir, (event) => event.path === jobFile)

        const write = `require("node:fs").writeFileSync(${JSON.stringify(path.join(dir, jobFile))}, "{}")`
        spawnSync(process.execPath, ["-e", write])

        const event = yield* Fiber.join(waiting)
        expect(Option.map(event, (e) => e.path)).toEqual(Option.some(jobFile))
      })
    ))

  it.live("sees the store's temp file too, as its own path", () =>
    inJobsFolder((dir) =>
      Effect.gen(function* () {
        const waiting = yield* watchFor(dir, (event) => event.path.startsWith(`${jobFile}.tmp-`))

        yield* JobStore.use((store) => store.save(job))

        const event = yield* Fiber.join(waiting)
        expect(Option.isSome(event)).toBe(true)
      })
    ))
})

const definitions: JobDefinitions<never> = {
  addRepo: { steps: [] },
  syncRepo: { steps: [] },
  reindexRepo: { steps: [] }
}

const elsewhere: Job = { ...job, owner: { pid: process.ppid, name: "cli" } }

const followingRunner = makeJobRunner(definitions, { concurrency: 1, followOthers: true }).pipe(
  Effect.tap(() => watcherStartup)
)

const runInOtherProcess = (script: string) => Effect.sync(() => spawnSync(process.execPath, ["-e", script]))

const saveFromOtherProcess = (dir: string, saved: Job) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const target = path.join(dir, `${saved.id}.json`)
    const temp = `${target}.tmp-0-other`
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(Job))(saved)
    yield* runInOtherProcess(
      `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(temp)}, ${JSON.stringify(json)}); fs.renameSync(${JSON.stringify(temp)}, ${JSON.stringify(target)})`
    )
  })

const removeFromOtherProcess = (dir: string, id: string) =>
  Path.Path.use((path) =>
    runInOtherProcess(`require("node:fs").unlinkSync(${JSON.stringify(path.join(dir, `${id}.json`))})`)
  )

const jobsOnceThey = (runner: JobRunner["Service"], match: (jobs: ReadonlyArray<Job>) => boolean) =>
  runner.changes.pipe(Stream.filter(match), Stream.runHead, Effect.timeout("5 seconds"))

const statuses = (jobs: Option.Option<ReadonlyArray<Job>>) => Option.map(jobs, (all) => all.map((j) => j.status))

describe("following other processes' jobs - our engine on the real file system", { concurrent: false }, () => {
  it.live("picks up a job another process saves", () =>
    inJobsFolder((dir) =>
      Effect.gen(function* () {
        const runner = yield* followingRunner

        yield* saveFromOtherProcess(dir, elsewhere)

        const jobs = yield* jobsOnceThey(runner, (all) => all.length > 0)
        expect(statuses(jobs)).toEqual(Option.some(["running"]))
      })
    ))

  it.live("picks up another process's update to a job", () =>
    inJobsFolder((dir) =>
      Effect.gen(function* () {
        const runner = yield* followingRunner
        yield* saveFromOtherProcess(dir, elsewhere)
        yield* jobsOnceThey(runner, (all) => all.length > 0)

        yield* saveFromOtherProcess(dir, { ...elsewhere, status: "completed", updatedAt: DateTime.makeUnsafe(1000) })

        const jobs = yield* jobsOnceThey(runner, (all) => all.some((j) => j.status === "completed"))
        expect(statuses(jobs)).toEqual(Option.some(["completed"]))
      })
    ))

  it.live("drops a job another process removes", () =>
    inJobsFolder((dir) =>
      Effect.gen(function* () {
        const runner = yield* followingRunner
        yield* saveFromOtherProcess(dir, elsewhere)
        yield* jobsOnceThey(runner, (all) => all.length > 0)

        yield* removeFromOtherProcess(dir, elsewhere.id)

        const jobs = yield* jobsOnceThey(runner, (all) => all.length === 0)
        expect(statuses(jobs)).toEqual(Option.some([]))
      })
    ))
})
