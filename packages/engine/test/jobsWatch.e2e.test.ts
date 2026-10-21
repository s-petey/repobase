import { describe, expect, it } from "@effect/vitest"
import { BunServices } from "@effect/platform-bun"
import { DateTime, Effect, Fiber, FileSystem, Option, Path, Stream } from "effect"
import { spawnSync } from "node:child_process"
import type { Job } from "../src/jobs/Job.js"
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

const watchFor = (dir: string, matches: (event: FileSystem.WatchEvent) => boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const waiting = yield* fs.watch(dir).pipe(
      Stream.filter(matches),
      Stream.runHead,
      Effect.timeout("5 seconds"),
      Effect.forkChild
    )
    // Give the OS watcher time to start before the change happens
    yield* Effect.sleep("100 millis")
    return waiting
  })

const inJobsFolder = <A, E>(test: (dir: string) => Effect.Effect<A, E, JobStore | FileSystem.FileSystem | Path.Path>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "repobase-watch-" })
    return yield* test(dir).pipe(Effect.provide(layerWith({ dir })))
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer))

describe("OS file watching - verification of behavior", () => {
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
        expect(event).toEqual(Option.some({ _tag: "Create", path: jobFile }))
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
