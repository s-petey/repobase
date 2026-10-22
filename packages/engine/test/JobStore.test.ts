import { describe, it, expect } from "@effect/vitest"
import { BunServices } from "@effect/platform-bun"
import { DateTime, Effect, FileSystem, Layer, Option, Path } from "effect"
import { TestClock } from "effect/testing"
import { spawnSync } from "node:child_process"
import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { StoreError } from "../src/errors.js"
import { CloneFailedError } from "../src/jobs/errors.js"
import { type Job, makeJobId } from "../src/jobs/Job.js"
import { heldBy, JobStore, layerMemory, layerWith } from "../src/jobs/JobStore.js"
import { thisProcessStartedAt } from "../src/jobs/owner.js"
import { trackingMode } from "../src/utils.js"

const tempDir = () => nodeFs.mkdtempSync(path.join(os.tmpdir(), "repobase-jobs-"))

const at = (iso: string) => DateTime.makeUnsafe(iso)

const makeJob = (overrides: Partial<Job> = {}): Job =>
  ({
    id: "addRepo-acme-widgets-1",
    kind: "addRepo",
    repoId: "acme-widgets",
    payload: { url: "https://github.com/acme/widgets", mode: trackingMode("main") },
    status: "failed",
    createdAt: at("2026-09-25T10:00:00Z"),
    updatedAt: at("2026-09-25T10:01:00Z"),
    steps: [
      {
        key: "checkAbsent",
        name: "checkAbsent",
        runsOn: "main",
        status: "done",
        attempts: 1,
        startedAt: at("2026-09-25T10:00:00Z"),
        finishedAt: at("2026-09-25T10:00:00Z")
      },
      {
        key: "clone",
        name: "clone",
        runsOn: "worker",
        status: "failed",
        attempts: 2,
        error: new CloneFailedError({
          repoId: "acme-widgets",
          url: "https://github.com/acme/widgets",
          reason: "network",
          message: "Could not resolve host: github.com"
        }),
        startedAt: at("2026-09-25T10:00:01Z"),
        finishedAt: at("2026-09-25T10:01:00Z")
      },
      { key: "resolveHead", name: "resolveHead", runsOn: "worker", status: "pending", attempts: 0 }
    ],
    ...overrides
  }) as Job

const syncJob = (overrides: Partial<Job> = {}): Job =>
  ({
    id: "syncRepo-acme-widgets-2",
    kind: "syncRepo",
    repoId: "acme-widgets",
    payload: {},
    status: "running",
    createdAt: at("2026-09-25T11:00:00Z"),
    updatedAt: at("2026-09-25T11:00:05Z"),
    steps: [
      {
        key: "fetch",
        name: "fetch",
        runsOn: "worker",
        status: "done",
        attempts: 1,
        output: null
      },
      {
        key: "indexBatch:0",
        name: "indexBatch",
        runsOn: "worker",
        status: "running",
        attempts: 1,
        startedAt: at("2026-09-25T11:00:04Z")
      }
    ],
    ...overrides
  }) as Job

const plan = { toIndex: [{ path: "src/a.ts", hash: "aaa" }], toDelete: ["old.ts"], skipped: 2 }

const deadPid = () => spawnSync("true").pid

const tui = { pid: process.pid, name: "tui" }

// A file store with its locks directory already made
const lockedStore = () =>
  Effect.gen(function* () {
    const dir = tempDir()
    const locks = path.join(dir, "locks")
    nodeFs.mkdirSync(locks)
    const store = yield* JobStore.pipe(Effect.provide(layerWith({ dir }).pipe(Layer.provide(BunServices.layer))))
    return { locks, store }
  })

const fileLayer = () => layerWith({ dir: tempDir() }).pipe(Layer.provide(BunServices.layer))

describe.each([
  ["file", fileLayer],
  ["memory", () => layerMemory]
] as const)("JobStore (%s)", (_, makeLayer) => {
  it.effect("round-trips a job, including its step error", () =>
    Effect.gen(function* () {
      const store = yield* JobStore
      const job = makeJob()
      yield* store.save(job)

      const loaded = yield* store.get(job.id)

      expect(Option.getOrThrow(loaded)).toEqual(job)
      const error = Option.getOrThrow(loaded).steps[1].error
      expect(error).toBeInstanceOf(CloneFailedError)
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("returns None for an unknown job", () =>
    Effect.gen(function* () {
      const store = yield* JobStore
      expect(Option.isNone(yield* store.get("nope"))).toBe(true)
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("lists jobs newest first", () =>
    Effect.gen(function* () {
      const store = yield* JobStore
      const older = makeJob()
      const newer = syncJob()
      yield* store.save(older)
      yield* store.save(newer)

      const jobs = yield* store.list()

      expect(jobs.map((j) => j.id)).toEqual([newer.id, older.id])
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("replaces a job on save", () =>
    Effect.gen(function* () {
      const store = yield* JobStore
      const job = makeJob()
      yield* store.save(job)
      yield* store.save({ ...job, status: "completed" })

      expect((yield* store.list()).map((j) => j.status)).toEqual(["completed"])
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("marks only running jobs, and their running steps, as interrupted", () =>
    Effect.gen(function* () {
      const store = yield* JobStore
      const failed = makeJob()
      const running = syncJob()
      yield* store.save(failed)
      yield* store.save(running)

      yield* TestClock.setTime(DateTime.toEpochMillis(at("2026-09-25T12:00:00Z")))
      const changed = yield* store.markInterrupted()

      expect(changed.map((j) => j.id)).toEqual([running.id])
      const reloaded = Option.getOrThrow(yield* store.get(running.id))
      expect(reloaded.status).toBe("interrupted")
      expect(reloaded.steps.map((s) => s.status)).toEqual(["done", "interrupted"])
      expect(reloaded.updatedAt).toEqual(at("2026-09-25T12:00:00Z"))
      expect(reloaded.steps[1].finishedAt).toEqual(at("2026-09-25T12:00:00Z"))
      expect(Option.getOrThrow(yield* store.get(failed.id))).toEqual(failed)
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("leaves a running job alone while the process that owns it is alive", () =>
    Effect.gen(function* () {
      const store = yield* JobStore
      const live = syncJob({ owner: { pid: process.ppid, name: "cli" } })
      const dead = syncJob({ id: "syncRepo-acme-gadgets-3", repoId: "acme-gadgets", owner: { pid: deadPid(), name: "cli" } })
      yield* store.save(live)
      yield* store.save(dead)

      const changed = yield* store.markInterrupted()

      expect(changed.map((j) => j.id)).toEqual([dead.id])
      expect(Option.getOrThrow(yield* store.get(live.id)).status).toBe("running")
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("claims a repo once until the claim is released, and says who holds it", () =>
    Effect.gen(function* () {
      const store = yield* JobStore
      expect(yield* store.claimRepo("acme/widgets", tui)).toEqual(Option.none())
      expect(yield* store.claimRepo("acme/widgets", tui)).toEqual(Option.some({ holder: Option.some(tui) }))
      expect(yield* store.claimRepo("acme/gadgets", tui)).toEqual(Option.none())

      yield* store.releaseRepo("acme/widgets")

      expect(yield* store.claimRepo("acme/widgets", tui)).toEqual(Option.none())
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("lists the claims other processes hold, leaving out this one's", () =>
    Effect.gen(function* () {
      const store = yield* JobStore
      const cli = { pid: process.ppid, name: "cli" }
      expect(yield* store.heldElsewhere()).toEqual([])

      yield* store.claimRepo("acme/widgets", tui)
      yield* store.claimRepo("acme/gadgets", cli)

      expect(yield* store.heldElsewhere()).toEqual([{ holder: Option.some(cli) }])
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("stores plans apart from jobs and removes both", () =>
    Effect.gen(function* () {
      const store = yield* JobStore
      const job = makeJob()
      yield* store.save(job)
      yield* store.writePlan(job.id, plan)

      expect(Option.getOrThrow(yield* store.readPlan(job.id))).toEqual(plan)

      yield* store.remove(job.id)
      expect(Option.isNone(yield* store.get(job.id))).toBe(true)
      expect(Option.isNone(yield* store.readPlan(job.id))).toBe(true)
      expect(yield* store.list()).toEqual([])
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("removing an unknown job is a no-op", () =>
    Effect.gen(function* () {
      const store = yield* JobStore
      yield* store.remove("nope")
    }).pipe(Effect.provide(makeLayer()))
  )
})

describe("JobStore (file) on disk", () => {
  it.effect("lists nothing when the directory doesn't exist yet", () =>
    Effect.gen(function* () {
      const store = yield* JobStore
      expect(yield* store.list()).toEqual([])
    }).pipe(
      Effect.provide(
        layerWith({ dir: path.join(tempDir(), "not-created") }).pipe(Layer.provide(BunServices.layer))
      )
    )
  )

  it.effect("skips a corrupt job file instead of failing the list", () =>
    Effect.gen(function* () {
      const dir = tempDir()
      nodeFs.writeFileSync(path.join(dir, "broken.json"), "{ not json")
      nodeFs.writeFileSync(path.join(dir, "wrong-shape.json"), JSON.stringify({ id: 1 }))
      const store = yield* JobStore.pipe(
        Effect.provide(layerWith({ dir }).pipe(Layer.provide(BunServices.layer)))
      )
      const job = makeJob()
      yield* store.save(job)

      expect((yield* store.list()).map((j) => j.id)).toEqual([job.id])
    })
  )

  it.effect("keeps the previous version when a write fails before the rename", () =>
    Effect.gen(function* () {
      const dir = tempDir()
      const job = makeJob()

      // First save works
      yield* JobStore.use((store) => store.save(job)).pipe(
        Effect.provide(layerWith({ dir }).pipe(Layer.provide(BunServices.layer)))
      )

      // Then the rename step fails, as if the process died after writing the temp file
      const failingRename = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          return FileSystem.FileSystem.of({
            ...fs,
            rename: () => Effect.die(new Error("simulated crash before rename"))
          })
        })
      ).pipe(Layer.provide(BunServices.layer))
      const result = yield* JobStore.use((store) => store.save({ ...job, status: "completed" })).pipe(
        Effect.provide(layerWith({ dir }).pipe(Layer.provide(Layer.merge(failingRename, Path.layer)))),
        Effect.exit
      )
      expect(result._tag).toBe("Failure")

      // The stored job is still the first version and was never truncated
      const loaded = yield* JobStore.use((store) => store.get(job.id)).pipe(
        Effect.provide(layerWith({ dir }).pipe(Layer.provide(BunServices.layer)))
      )
      expect(Option.getOrThrow(loaded).status).toBe("failed")

      // The crash left a temp file behind; listing ignores it
      expect(nodeFs.readdirSync(dir).some((f) => f.includes(".tmp-"))).toBe(true)
      const listed = yield* JobStore.use((store) => store.list()).pipe(
        Effect.provide(layerWith({ dir }).pipe(Layer.provide(BunServices.layer)))
      )
      expect(listed.map((j) => j.status)).toEqual(["failed"])
    })
  )

  it.effect("refuses a repo another live process claimed, and takes over a dead one's claim", () =>
    Effect.gen(function* () {
      const { locks, store } = yield* lockedStore()
      const cli = { pid: process.ppid, name: "cli" }
      nodeFs.writeFileSync(path.join(locks, "acme__widgets.lock"), JSON.stringify(cli))
      nodeFs.writeFileSync(path.join(locks, "acme__gadgets.lock"), JSON.stringify({ pid: deadPid(), name: "cli" }))

      expect(yield* store.claimRepo("acme/widgets", tui)).toEqual(Option.some({ holder: Option.some(cli) }))
      expect(yield* store.claimRepo("acme/gadgets", tui)).toEqual(Option.none())
      expect(JSON.parse(nodeFs.readFileSync(path.join(locks, "acme__gadgets.lock"), "utf8"))).toEqual(tui)

      // Only this process's own claim is released
      yield* store.releaseRepo("acme/widgets")
      expect(nodeFs.existsSync(path.join(locks, "acme__widgets.lock"))).toBe(true)
      yield* store.releaseRepo("acme/gadgets")
      expect(nodeFs.existsSync(path.join(locks, "acme__gadgets.lock"))).toBe(false)
    })
  )

  it.effect("takes over a claim whose pid now belongs to a different process", () =>
    Effect.gen(function* () {
      const { locks, store } = yield* lockedStore()
      const later = 60 * 60 * 1000
      const reused = { pid: process.ppid, name: "cli", startedAt: thisProcessStartedAt() + later }
      nodeFs.writeFileSync(path.join(locks, "acme__widgets.lock"), JSON.stringify(reused))

      expect(yield* store.claimRepo("acme/widgets", tui)).toEqual(Option.none())
      expect(yield* store.heldElsewhere()).toEqual([])
    })
  )

  it.effect("treats a lock still being written as held, and one left empty as free", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now())
      const { locks, store } = yield* lockedStore()
      nodeFs.writeFileSync(path.join(locks, "acme__widgets.lock"), "")
      const stale = path.join(locks, "acme__gadgets.lock")
      nodeFs.writeFileSync(stale, "")
      const aMinuteAgo = Date.now() / 1000 - 60
      nodeFs.utimesSync(stale, aMinuteAgo, aMinuteAgo)

      expect(yield* store.claimRepo("acme/widgets", tui)).toEqual(Option.some({ holder: Option.none() }))
      expect(yield* store.claimRepo("acme/gadgets", tui)).toEqual(Option.none())
    })
  )

  it.effect("leaves dead processes' claims out of the claims held elsewhere, but not one still being written", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now())
      const { locks, store } = yield* lockedStore()
      nodeFs.writeFileSync(path.join(locks, "acme__widgets.lock"), JSON.stringify({ pid: deadPid(), name: "cli" }))
      nodeFs.writeFileSync(path.join(locks, "acme__gadgets.lock"), "")

      expect(yield* store.heldElsewhere()).toEqual([{ holder: Option.none() }])
    })
  )

  it.effect("fails rather than reporting the repo held when the lock can't be written", () =>
    Effect.gen(function* () {
      const { locks, store } = yield* lockedStore()
      nodeFs.chmodSync(locks, 0o500)

      const error = yield* Effect.flip(store.claimRepo("acme/widgets", tui))

      expect(error).toBeInstanceOf(StoreError)
      nodeFs.chmodSync(locks, 0o700)
    })
  )

  it.effect("deletes temp files only of processes that are gone", () =>
    Effect.gen(function* () {
      const dir = tempDir()
      const live = `a.json.tmp-${process.ppid}-x`
      const gone = `b.json.tmp-${deadPid()}-x`
      nodeFs.writeFileSync(path.join(dir, live), "{}")
      nodeFs.writeFileSync(path.join(dir, gone), "{}")

      yield* JobStore.use((store) => store.markInterrupted()).pipe(
        Effect.provide(layerWith({ dir }).pipe(Layer.provide(BunServices.layer)))
      )

      expect(nodeFs.readdirSync(dir)).toEqual([live])
    })
  )

  it.effect("writes readable JSON with dates as millis", () =>
    Effect.gen(function* () {
      const dir = tempDir()
      const job = makeJob()
      yield* JobStore.use((store) => store.save(job)).pipe(
        Effect.provide(layerWith({ dir }).pipe(Layer.provide(BunServices.layer)))
      )

      const raw = JSON.parse(nodeFs.readFileSync(path.join(dir, `${job.id}.json`), "utf8"))

      expect(raw.createdAt).toBe(DateTime.toEpochMillis(job.createdAt))
      expect(raw.steps[1].error).toMatchObject({ _tag: "CloneFailedError", reason: "network" })
      expect(nodeFs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([])
    })
  )
})

describe("heldBy", () => {
  it("names the process holding a claim, or says it's unknown", () => {
    expect(heldBy({ holder: Option.some({ pid: 4242, name: "tui" }) })).toBe("repobase tui (pid 4242)")
    expect(heldBy({ holder: Option.none() })).toBe("another repobase process")
  })
})

describe("makeJobId", () => {
  it.effect("starts with kind and repo and differs within the same millisecond", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(at("2026-09-25T10:00:00Z")))
      const a = yield* makeJobId("syncRepo", "acme-widgets")
      const b = yield* makeJobId("syncRepo", "acme-widgets")
      expect(a).toMatch(/^syncRepo-acme-widgets-[0-9a-z]+$/)
      expect(a).not.toBe(b)
    })
  )

  it.effect("keeps the \"/\" of an owner/name repo id out, since the id names the job's files", () =>
    Effect.gen(function* () {
      const id = yield* makeJobId("syncRepo", "acme/widgets")
      expect(id).toMatch(/^syncRepo-acme__widgets-[0-9a-z]+$/)
    })
  )

  it.effect("names a job for an owner/name repo so the file store lists and reads it back", () => {
    const dir = tempDir()
    return Effect.gen(function* () {
      const store = yield* JobStore
      const id = yield* makeJobId("syncRepo", "acme/widgets")
      yield* store.save(syncJob({ id, repoId: "acme/widgets" }))
      yield* store.writePlan(id, plan)

      expect((yield* store.list()).map((j) => j.repoId)).toEqual(["acme/widgets"])
      expect(Option.isSome(yield* store.readPlan(id))).toBe(true)
      // One file and one plan folder, directly in the jobs directory
      expect(nodeFs.readdirSync(dir).sort()).toEqual([id, `${id}.json`])
    }).pipe(Effect.provide(layerWith({ dir }).pipe(Layer.provide(BunServices.layer))))
  })

  it.effect("sorts by creation time", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(at("2026-09-25T10:00:00Z")))
      const earlier = yield* makeJobId("syncRepo", "acme-widgets")
      yield* TestClock.adjust("1 second")
      const later = yield* makeJobId("syncRepo", "acme-widgets")
      expect(earlier < later).toBe(true)
    })
  )
})
