import { describe, it, expect } from "@effect/vitest"
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { spawnSync } from "node:child_process"
import {
  CloneFailedError,
  IndexBatchFailedError,
  RemoteBranchMissingError,
  type StepError,
  UnexpectedStepError
} from "../src/jobs/errors.js"
import type { AddRepoJob, Job, ReindexRepoJob, Step, SyncRepoJob } from "../src/jobs/Job.js"
import {
  fanOut,
  type JobDefinitions,
  JobAlreadyRunningError,
  JobNotRetryableError,
  JobRunner,
  layer as JobRunnerLayer,
  make as makeJobRunner,
  step
} from "../src/jobs/JobRunner.js"
import { JobStore, layerMemory } from "../src/jobs/JobStore.js"
import { thisProcessStartedAt } from "../src/jobs/owner.js"
import { trackingMode } from "../src/utils.js"

// A scripted set of job definitions. Tests decide which steps fail, crash or
// block, and read back which steps ran and what they saw.
const makeScript = () => {
  const ran: Array<string> = []
  const failing = new Map<string, () => StepError>()
  const crashing = new Set<string>()
  const gates = new Map<string, Deferred.Deferred<void>>()
  const seen: { cloneCommit?: string } = {}
  let pinned = false

  const act = <A>(key: string, value: A): Effect.Effect<A, StepError> =>
    Effect.gen(function* () {
      ran.push(key)
      const gate = gates.get(key)
      if (gate) yield* Deferred.await(gate)
      if (crashing.has(key)) return yield* Effect.die(new Error(`${key} blew up`))
      const fail = failing.get(key)
      if (fail) return yield* Effect.fail(fail())
      return value
    })

  const checkAbsent = step<AddRepoJob, null, never>({
    name: "checkAbsent",
    runsOn: "main",
    output: Schema.Null,
    run: () => act("checkAbsent", null)
  })

  const clone = step<AddRepoJob, { commit: string }, never>({
    name: "clone",
    runsOn: "worker",
    output: Schema.Struct({ commit: Schema.String }),
    run: () => act("clone", { commit: "abc123" })
  })

  const saveConfig = step<AddRepoJob, null, never>({
    name: "saveConfig",
    runsOn: "main",
    output: Schema.Null,
    run: (ctx) =>
      Effect.gen(function* () {
        seen.cloneCommit = (yield* ctx.output(clone)).commit
        return yield* act("saveConfig", null)
      })
  })

  const indexBatch = fanOut<AddRepoJob, string, { indexed: number }, never>({
    name: "indexBatch",
    runsOn: "worker",
    output: Schema.Struct({ indexed: Schema.Number }),
    items: () => act("indexBatch", ["a", "b", "c"]),
    run: (item, { index }) => act(`indexBatch:${index}`, { indexed: item.length })
  })

  const finalize = step<AddRepoJob, null, never>({
    name: "finalize",
    runsOn: "worker",
    output: Schema.Null,
    run: (ctx) => ctx.indexLock.exclusive(act("finalize", null))
  })

  const loadRepo = step<SyncRepoJob, { pinned: boolean }, never>({
    name: "loadRepo",
    runsOn: "main",
    output: Schema.Struct({ pinned: Schema.Boolean }),
    run: () => act("loadRepo", { pinned }),
    finishJob: (output) => (output.pinned ? Option.some("skipped" as const) : Option.none())
  })

  const fetch = step<SyncRepoJob, null, never>({
    name: "fetch",
    runsOn: "worker",
    output: Schema.Null,
    run: () => act("fetch", null)
  })

  const reindex = step<ReindexRepoJob, null, never>({
    name: "reindex",
    runsOn: "worker",
    output: Schema.Null,
    run: () => act("reindex", null)
  })

  const definitions: JobDefinitions<never> = {
    addRepo: { steps: [checkAbsent, clone, saveConfig, indexBatch, finalize] },
    syncRepo: { steps: [loadRepo, fetch] },
    reindexRepo: { steps: [reindex] }
  }

  return {
    definitions,
    ran,
    failing,
    crashing,
    seen,
    setPinned: (value: boolean) => {
      pinned = value
    },
    block: (key: string) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        gates.set(key, gate)
        return {
          release: Effect.gen(function* () {
            gates.delete(key)
            yield* Deferred.succeed(gate, undefined)
          })
        }
      })
  }
}

const cloneFailure = () =>
  new CloneFailedError({ repoId: "acme-widgets", url: "u", reason: "network", message: "offline" })

const addRepo = (repoId = "acme-widgets") =>
  ({
    kind: "addRepo",
    repoId,
    payload: { url: `https://github.com/acme/${repoId}`, mode: trackingMode("main") }
  }) as const

const syncRepo = (repoId = "acme-widgets") => ({ kind: "syncRepo", repoId, payload: {} }) as const

const runnerLayer = (definitions: JobDefinitions<never>) =>
  JobRunnerLayer(definitions, { concurrency: 2 }).pipe(Layer.provideMerge(layerMemory))

const statuses = (job: Job) => Object.fromEntries(job.steps.map((s) => [s.key, s.status]))
const stepOf = (job: Job, key: string): Step => job.steps.find((s) => s.key === key)!

describe("JobRunner", () => {
  it.effect("runs every step, expands the fan-out and saves the job", () => {
    const script = makeScript()
    return Effect.gen(function* () {
      const runner = yield* JobRunner
      const started = yield* runner.start(addRepo())
      const job = yield* runner.await(started.id)

      expect(job.status).toBe("completed")
      expect(statuses(job)).toEqual({
        checkAbsent: "done",
        clone: "done",
        saveConfig: "done",
        indexBatch: "done",
        "indexBatch:0": "done",
        "indexBatch:1": "done",
        "indexBatch:2": "done",
        finalize: "done"
      })
      expect(stepOf(job, "indexBatch").output).toEqual({ count: 3 })
      expect(stepOf(job, "indexBatch:1").output).toEqual({ indexed: 1 })
      // saveConfig read clone's output from the checkpoint
      expect(script.seen.cloneCommit).toBe("abc123")
      // What the runner holds is what was persisted
      const stored = yield* JobStore.use((store) => store.get(job.id))
      expect(Option.getOrThrow(stored)).toEqual(job)
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })

  it.effect("stops at a failed step and records its error", () => {
    const script = makeScript()
    script.failing.set("clone", cloneFailure)
    return Effect.gen(function* () {
      const runner = yield* JobRunner
      const job = yield* runner.await((yield* runner.start(addRepo())).id)

      expect(job.status).toBe("failed")
      expect(statuses(job)).toMatchObject({ checkAbsent: "done", clone: "failed", saveConfig: "pending" })
      expect(stepOf(job, "clone").error).toBeInstanceOf(CloneFailedError)
      expect(script.ran).toEqual(["checkAbsent", "clone"])
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })

  it.effect("retries from the failed step, skipping steps that are done", () => {
    const script = makeScript()
    script.failing.set("clone", cloneFailure)
    return Effect.gen(function* () {
      const runner = yield* JobRunner
      const first = yield* runner.await((yield* runner.start(addRepo())).id)

      script.failing.delete("clone")
      script.ran.length = 0
      yield* runner.retry(first.id)
      const job = yield* runner.await(first.id)

      expect(job.status).toBe("completed")
      expect(script.ran[0]).toBe("clone")
      expect(script.ran).not.toContain("checkAbsent")
      expect(stepOf(job, "checkAbsent").attempts).toBe(1)
      expect(stepOf(job, "clone").attempts).toBe(2)
      expect(stepOf(job, "clone").error).toBeUndefined()
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })

  it.effect("lists a retried job as the newest, above jobs started since it stopped", () => {
    const script = makeScript()
    script.failing.set("clone", cloneFailure)
    return Effect.gen(function* () {
      const runner = yield* JobRunner
      const failed = yield* runner.await((yield* runner.start(addRepo())).id)
      yield* TestClock.adjust("1 minute")
      const other = yield* runner.await((yield* runner.start(syncRepo("other-repo"))).id)

      script.failing.delete("clone")
      yield* TestClock.adjust("1 minute")
      const retried = yield* runner.retry(failed.id)

      expect(DateTime.isGreaterThan(retried.createdAt, other.createdAt)).toBe(true)
      expect((yield* runner.jobs).map((j) => j.id)).toEqual([failed.id, other.id])
      const stored = Option.getOrThrow(yield* JobStore.use((store) => store.get(failed.id)))
      expect(stored.createdAt).toEqual(retried.createdAt)
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })

  it.effect("resumes a job saved before its definition gained steps", () => {
    const script = makeScript()
    const resolve = step<SyncRepoJob, { commit: string }, never>({
      name: "resolve",
      runsOn: "worker",
      output: Schema.Struct({ commit: Schema.String }),
      run: () => Effect.succeed({ commit: "def456" })
    })
    const record = step<SyncRepoJob, string, never>({
      name: "record",
      runsOn: "main",
      output: Schema.String,
      run: (ctx) => ctx.output(resolve).pipe(Effect.map((r) => r.commit))
    })
    const definitions: JobDefinitions<never> = {
      ...script.definitions,
      syncRepo: { steps: [...script.definitions.syncRepo.steps, resolve, record] }
    }
    const at = DateTime.makeUnsafe(0)
    const saved: SyncRepoJob = {
      id: "syncRepo-acme-widgets-old",
      kind: "syncRepo",
      repoId: "acme-widgets",
      payload: {},
      status: "interrupted",
      createdAt: at,
      updatedAt: at,
      steps: [
        { key: "loadRepo", name: "loadRepo", runsOn: "main", status: "done", attempts: 1, output: { pinned: false } },
        { key: "fetch", name: "fetch", runsOn: "worker", status: "interrupted", attempts: 1 }
      ]
    }
    return Effect.gen(function* () {
      yield* JobStore.use((store) => store.save(saved))
      const runner = yield* makeJobRunner(definitions, { concurrency: 2 })

      yield* runner.retry(saved.id)
      const job = yield* runner.await(saved.id)

      expect(job.status).toBe("completed")
      expect(job.steps.map((s) => s.key)).toEqual(["loadRepo", "fetch", "resolve", "record"])
      expect(stepOf(job, "record").output).toBe("def456")
    }).pipe(Effect.scoped, Effect.provide(layerMemory))
  })

  it.effect("follows a job another process runs, and leaves discarding it to that process", () => {
    const script = makeScript()
    const at = DateTime.makeUnsafe(0)
    const elsewhere: SyncRepoJob = {
      id: "syncRepo-acme-gadgets-cli",
      kind: "syncRepo",
      repoId: "acme-gadgets",
      payload: {},
      status: "running",
      createdAt: at,
      updatedAt: at,
      owner: { pid: process.ppid, name: "cli" },
      steps: [
        { key: "loadRepo", name: "loadRepo", runsOn: "main", status: "running", attempts: 1 },
        { key: "fetch", name: "fetch", runsOn: "worker", status: "pending", attempts: 0 }
      ]
    }
    return Effect.gen(function* () {
      const store = yield* JobStore
      const runner = yield* makeJobRunner(script.definitions, { concurrency: 2, followOthers: true })
      const own = yield* runner.await((yield* runner.start(addRepo())).id)
      expect(own.owner).toEqual({ pid: process.pid, name: "repobase", startedAt: thisProcessStartedAt() })

      yield* store.save(elsewhere)
      yield* TestClock.adjust("1 second")
      expect((yield* runner.jobs).map((j) => j.id)).toEqual([own.id, elsewhere.id])
      expect(yield* Effect.flip(runner.discard(elsewhere.id))).toBeInstanceOf(JobAlreadyRunningError)

      // The other process finishes it
      yield* store.save({ ...elsewhere, status: "completed", updatedAt: DateTime.makeUnsafe(1000) })
      yield* TestClock.adjust("1 second")
      expect((yield* runner.jobs).find((j) => j.id === elsewhere.id)?.status).toBe("completed")
    }).pipe(Effect.scoped, Effect.provide(layerMemory))
  })

  it.effect("marks a job whose process died as interrupted, so it can be retried here", () => {
    const script = makeScript()
    const at = DateTime.makeUnsafe(0)
    const orphan: SyncRepoJob = {
      id: "syncRepo-acme-widgets-cli",
      kind: "syncRepo",
      repoId: "acme-widgets",
      payload: {},
      status: "running",
      createdAt: at,
      updatedAt: at,
      owner: { pid: spawnSync("true").pid, name: "cli" },
      steps: [
        { key: "loadRepo", name: "loadRepo", runsOn: "main", status: "done", attempts: 1, output: { pinned: false } },
        { key: "fetch", name: "fetch", runsOn: "worker", status: "running", attempts: 1 }
      ]
    }
    return Effect.gen(function* () {
      const store = yield* JobStore
      const runner = yield* makeJobRunner(script.definitions, { concurrency: 2, followOthers: true })

      yield* store.save(orphan)
      yield* TestClock.adjust("15 seconds")
      expect((yield* runner.jobs).find((j) => j.id === orphan.id)?.status).toBe("interrupted")

      yield* runner.retry(orphan.id)
      const job = yield* runner.await(orphan.id)
      expect(job.status).toBe("completed")
      expect(job.owner?.pid).toBe(process.pid)
    }).pipe(Effect.scoped, Effect.provide(layerMemory))
  })

  it.effect("lets the other batches finish when one fails, then retries only that one", () => {
    const script = makeScript()
    script.failing.set(
      "indexBatch:1",
      () => new IndexBatchFailedError({ repoId: "acme-widgets", message: "OOM", batch: 1, total: 3, phase: "embed" })
    )
    return Effect.gen(function* () {
      const runner = yield* JobRunner
      const first = yield* runner.await((yield* runner.start(addRepo())).id)

      expect(first.status).toBe("failed")
      expect(statuses(first)).toMatchObject({
        "indexBatch:0": "done",
        "indexBatch:1": "failed",
        "indexBatch:2": "done",
        finalize: "pending"
      })

      script.failing.delete("indexBatch:1")
      script.ran.length = 0
      yield* runner.retry(first.id)
      const job = yield* runner.await(first.id)

      expect(job.status).toBe("completed")
      // The fan-out lists its items again, then only the failed batch re-runs
      expect(script.ran).toEqual(["indexBatch", "indexBatch:1", "finalize"])
      expect(job.steps.filter((s) => s.name === "indexBatch")).toHaveLength(4)
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })

  it.effect("refuses to retry a step that can't succeed", () => {
    const script = makeScript()
    script.failing.set(
      "clone",
      () => new RemoteBranchMissingError({ repoId: "acme-widgets", branch: "gone", message: "unknown revision" })
    )
    return Effect.gen(function* () {
      const runner = yield* JobRunner
      const job = yield* runner.await((yield* runner.start(addRepo())).id)

      const error = yield* Effect.flip(runner.retry(job.id))

      expect(error).toBeInstanceOf(JobNotRetryableError)
      expect(error.message).toContain("clone")
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })

  it.effect("records an unexpected crash as a retryable step error", () => {
    const script = makeScript()
    script.crashing.add("saveConfig")
    return Effect.gen(function* () {
      const runner = yield* JobRunner
      const job = yield* runner.await((yield* runner.start(addRepo())).id)

      expect(job.status).toBe("failed")
      const error = stepOf(job, "saveConfig").error
      expect(error).toBeInstanceOf(UnexpectedStepError)
      expect(error?.message).toContain("saveConfig blew up")

      script.crashing.delete("saveConfig")
      yield* runner.retry(job.id)
      expect((yield* runner.await(job.id)).status).toBe("completed")
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })

  it.effect("ends a job early and skips the rest", () => {
    const script = makeScript()
    script.setPinned(true)
    return Effect.gen(function* () {
      const runner = yield* JobRunner
      const job = yield* runner.await((yield* runner.start(syncRepo())).id)

      expect(job.status).toBe("skipped")
      expect(statuses(job)).toEqual({ loadRepo: "done", fetch: "skipped" })
      expect(script.ran).toEqual(["loadRepo"])
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })

  it.effect("allows one job per repo at a time", () => {
    const script = makeScript()
    return Effect.gen(function* () {
      const runner = yield* JobRunner
      const gate = yield* script.block("clone")
      const first = yield* runner.start(addRepo())

      const refused = yield* Effect.flip(runner.start(syncRepo()))
      expect(refused).toBeInstanceOf(JobAlreadyRunningError)

      // A different repo is fine
      const other = yield* runner.start(syncRepo("other-repo"))
      expect((yield* runner.await(other.id)).status).toBe("completed")

      yield* gate.release
      expect((yield* runner.await(first.id)).status).toBe("completed")
      // Once it's done, the repo is free again
      expect((yield* runner.await((yield* runner.start(syncRepo())).id)).status).toBe("completed")
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })

  it.effect("frees the repo when a start is interrupted before its job launches", () => {
    const script = makeScript()
    return Effect.gen(function* () {
      const runner = yield* JobRunner
      const neverDone = yield* Deferred.make<void>()
      const starting = yield* Effect.forkChild(runner.start(syncRepo(), { prepare: Deferred.await(neverDone) }))
      yield* Effect.yieldNow

      yield* Fiber.interrupt(starting)

      expect((yield* runner.jobs).length).toBe(0)
      expect((yield* runner.await((yield* runner.start(syncRepo())).id)).status).toBe("completed")
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })

  it.effect("frees the repo when a start's prepare fails or dies", () => {
    const script = makeScript()
    return Effect.gen(function* () {
      const runner = yield* JobRunner

      const failed = yield* Effect.flip(runner.start(syncRepo(), { prepare: Effect.fail(cloneFailure()) }))
      expect(failed).toBeInstanceOf(CloneFailedError)
      const died = yield* Effect.exit(runner.start(syncRepo(), { prepare: Effect.die(new Error("boom")) }))
      expect(Exit.isFailure(died)).toBe(true)

      expect((yield* runner.await((yield* runner.start(syncRepo())).id)).status).toBe("completed")
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })

  it.effect("holds the repo for the whole of whileClaimed, refusing jobs meanwhile", () => {
    const script = makeScript()
    return Effect.gen(function* () {
      const runner = yield* JobRunner
      const gate = yield* script.block("fetch")
      const sync = yield* runner.start(syncRepo())
      expect(yield* Effect.flip(runner.whileClaimed("acme-widgets", Effect.void))).toBeInstanceOf(JobAlreadyRunningError)
      yield* gate.release
      yield* runner.await(sync.id)

      const holding = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const claimed = yield* Effect.forkChild(
        runner.whileClaimed("acme-widgets", Deferred.succeed(holding, undefined).pipe(Effect.andThen(Deferred.await(release))))
      )
      yield* Deferred.await(holding)
      expect(yield* Effect.flip(runner.start(syncRepo()))).toBeInstanceOf(JobAlreadyRunningError)

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(claimed)
      expect((yield* runner.await((yield* runner.start(syncRepo())).id)).status).toBe("completed")
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })

  it.effect("discards a running job: stops it, deletes it and frees the repo", () => {
    const script = makeScript()
    return Effect.gen(function* () {
      const runner = yield* JobRunner
      yield* script.block("clone")
      const job = yield* runner.start(addRepo())
      yield* Effect.yieldNow

      yield* runner.discard(job.id)

      expect(yield* runner.jobs).toEqual([])
      expect(Option.isNone(yield* JobStore.use((store) => store.get(job.id)))).toBe(true)
      expect(script.ran).not.toContain("saveConfig")
      const next = yield* runner.start(syncRepo())
      expect((yield* runner.await(next.id)).status).toBe("completed")
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })

  it.effect("marks jobs a previous process left running as interrupted, and resumes them", () => {
    const script = makeScript()
    const now = DateTime.makeUnsafe("2026-09-25T10:00:00Z")
    const leftRunning: Job = {
      id: "addRepo-acme-widgets-old",
      kind: "addRepo",
      repoId: "acme-widgets",
      payload: { url: "https://github.com/acme/widgets", mode: trackingMode("main") },
      status: "running",
      createdAt: now,
      updatedAt: now,
      steps: [
        { key: "checkAbsent", name: "checkAbsent", runsOn: "main", status: "done", attempts: 1, output: null },
        { key: "clone", name: "clone", runsOn: "worker", status: "running", attempts: 1, startedAt: now },
        { key: "saveConfig", name: "saveConfig", runsOn: "main", status: "pending", attempts: 0 },
        { key: "indexBatch", name: "indexBatch", runsOn: "worker", status: "pending", attempts: 0 },
        { key: "finalize", name: "finalize", runsOn: "worker", status: "pending", attempts: 0 }
      ]
    }
    return Effect.gen(function* () {
      yield* JobStore.use((store) => store.save(leftRunning))

      // Starting the runner is what a fresh TUI process does
      const runner = yield* makeJobRunner(script.definitions, { concurrency: 2 })
      const [loaded] = yield* runner.jobs
      expect(loaded.status).toBe("interrupted")
      expect(stepOf(loaded, "clone").status).toBe("interrupted")

      yield* runner.retry(loaded.id)
      const job = yield* runner.await(loaded.id)

      expect(job.status).toBe("completed")
      expect(script.ran[0]).toBe("clone")
      expect(script.ran).not.toContain("checkAbsent")
    }).pipe(Effect.scoped, Effect.provide(layerMemory))
  })

  it.effect("makes a fan-out's item steps afresh when its items changed since the job stopped", () => {
    const script = makeScript()
    const now = DateTime.makeUnsafe("2026-09-25T10:00:00Z")
    // Stopped with 2 batches; the fan-out now lists 3 (as if the batch size changed)
    const stopped: Job = {
      id: "addRepo-acme-widgets-old",
      kind: "addRepo",
      repoId: "acme-widgets",
      payload: { url: "https://github.com/acme/widgets", mode: trackingMode("main") },
      status: "interrupted",
      createdAt: now,
      updatedAt: now,
      steps: [
        { key: "checkAbsent", name: "checkAbsent", runsOn: "main", status: "done", attempts: 1, output: null },
        { key: "clone", name: "clone", runsOn: "worker", status: "done", attempts: 1, output: { commit: "abc123" } },
        { key: "saveConfig", name: "saveConfig", runsOn: "main", status: "done", attempts: 1, output: null },
        { key: "indexBatch", name: "indexBatch", runsOn: "worker", status: "done", attempts: 1, output: { count: 2 } },
        { key: "indexBatch:0", name: "indexBatch", runsOn: "worker", status: "done", attempts: 1, output: { indexed: 1 } },
        { key: "indexBatch:1", name: "indexBatch", runsOn: "worker", status: "interrupted", attempts: 1 },
        { key: "finalize", name: "finalize", runsOn: "worker", status: "pending", attempts: 0 }
      ]
    }
    return Effect.gen(function* () {
      yield* JobStore.use((store) => store.save(stopped))
      const runner = yield* makeJobRunner(script.definitions, { concurrency: 2 })

      yield* runner.retry(stopped.id)
      const job = yield* runner.await(stopped.id)

      expect(job.status).toBe("completed")
      expect(job.steps.map((s) => s.key)).toEqual([
        "checkAbsent",
        "clone",
        "saveConfig",
        "indexBatch",
        "indexBatch:0",
        "indexBatch:1",
        "indexBatch:2",
        "finalize"
      ])
      expect([...script.ran].sort()).toEqual(["finalize", "indexBatch", "indexBatch:0", "indexBatch:1", "indexBatch:2"])
    }).pipe(Effect.scoped, Effect.provide(layerMemory))
  })

  it.effect("ends a resumed job at a step that finished before the interrupt and ends the job", () => {
    const script = makeScript()
    const now = DateTime.makeUnsafe("2026-09-25T10:00:00Z")
    // Interrupted after loadRepo saved `pinned`, before the job was marked skipped
    const interrupted: Job = {
      id: "syncRepo-acme-widgets-old",
      kind: "syncRepo",
      repoId: "acme-widgets",
      payload: {},
      status: "interrupted",
      createdAt: now,
      updatedAt: now,
      steps: [
        { key: "loadRepo", name: "loadRepo", runsOn: "main", status: "done", attempts: 1, output: { pinned: true } },
        { key: "fetch", name: "fetch", runsOn: "worker", status: "pending", attempts: 0 }
      ]
    }
    return Effect.gen(function* () {
      yield* JobStore.use((store) => store.save(interrupted))
      const runner = yield* makeJobRunner(script.definitions, { concurrency: 2 })

      yield* runner.retry(interrupted.id)
      const job = yield* runner.await(interrupted.id)

      expect(job.status).toBe("skipped")
      expect(script.ran).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(layerMemory))
  })

  it.effect("keeps each repo's latest job and any failed ones, and deletes older finished jobs", () => {
    const script = makeScript()
    return Effect.gen(function* () {
      const runner = yield* JobRunner
      script.failing.set("fetch", cloneFailure)
      const failed = yield* runner.await((yield* runner.start(syncRepo())).id)
      script.failing.delete("fetch")
      const first = yield* runner.await((yield* runner.start(syncRepo())).id)
      const second = yield* runner.await((yield* runner.start(syncRepo())).id)
      const other = yield* runner.await((yield* runner.start(syncRepo("other-repo"))).id)

      const kept = (yield* runner.jobs).map((j) => `${j.id} ${j.status}`).sort()
      expect(kept).toEqual(
        [`${failed.id} failed`, `${second.id} completed`, `${other.id} completed`].sort()
      )
      expect(yield* JobStore.use((store) => store.get(first.id))).toEqual(Option.none())
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })

  it.effect("supersedes an unfinished job: it can't be retried and goes once the newer job finishes", () => {
    const script = makeScript()
    return Effect.gen(function* () {
      const runner = yield* JobRunner
      script.failing.set("fetch", cloneFailure)
      const failed = yield* runner.await((yield* runner.start(syncRepo())).id)
      script.failing.delete("fetch")

      yield* script.block("fetch")
      const next = yield* runner.start(syncRepo())
      const marked = yield* runner.supersede(failed.id, next.id)
      expect(marked.supersededBy).toBe(next.id)
      expect(marked.status).toBe("failed")
      const stored = Option.getOrThrow(yield* JobStore.use((store) => store.get(failed.id)))
      expect(stored.supersededBy).toBe(next.id)

      const refused = yield* Effect.flip(runner.retry(failed.id))
      expect(refused).toBeInstanceOf(JobNotRetryableError)
      expect(refused.message).toContain(next.id)
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })

  it.effect("prunes a superseded job once the job that replaced it finishes", () => {
    const script = makeScript()
    return Effect.gen(function* () {
      const runner = yield* JobRunner
      script.failing.set("fetch", cloneFailure)
      const failed = yield* runner.await((yield* runner.start(syncRepo())).id)
      script.failing.delete("fetch")

      const gate = yield* script.block("fetch")
      const next = yield* runner.start(syncRepo())
      yield* runner.supersede(failed.id, next.id)
      yield* gate.release
      yield* runner.await(next.id)
      yield* runner.changes.pipe(
        Stream.filter((jobs) => jobs.length === 1),
        Stream.runHead
      )

      expect((yield* runner.jobs).map((j) => j.id)).toEqual([next.id])
      expect(yield* JobStore.use((store) => store.get(failed.id))).toEqual(Option.none())
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })

  it.effect("only supersedes a failed or interrupted job", () => {
    const script = makeScript()
    return Effect.gen(function* () {
      const runner = yield* JobRunner
      const done = yield* runner.await((yield* runner.start(syncRepo())).id)

      const refused = yield* Effect.flip(runner.supersede(done.id, "syncRepo-acme-widgets-newer"))

      expect(refused).toBeInstanceOf(JobNotRetryableError)
      expect((yield* runner.jobs)[0].supersededBy).toBeUndefined()
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })

  it.effect("a resumed job finishing late doesn't free the repo for the next job's claim", () => {
    const script = makeScript()
    return Effect.gen(function* () {
      const runner = yield* JobRunner
      script.failing.set("fetch", cloneFailure)
      const failed = yield* runner.await((yield* runner.start(syncRepo())).id)
      script.failing.delete("fetch")

      // Retry, await, then start the next job at once, like the TUI's sync
      yield* runner.retry(failed.id)
      yield* runner.await(failed.id)
      yield* script.block("fetch")
      yield* runner.start(syncRepo())
      yield* Effect.yieldNow

      // The retried job's fiber has ended, and the new job still holds the repo
      const refused = yield* Effect.flip(runner.start(syncRepo()))
      expect(refused).toBeInstanceOf(JobAlreadyRunningError)
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })

  it.effect("interruptAll stops every running job and saves each as interrupted", () => {
    const script = makeScript()
    return Effect.gen(function* () {
      const runner = yield* JobRunner
      const clone = yield* script.block("clone")
      yield* script.block("fetch")
      const add = yield* runner.start(addRepo())
      const sync = yield* runner.start(syncRepo("other-repo"))
      yield* Effect.yieldNow

      yield* runner.interruptAll

      for (const id of [add.id, sync.id]) {
        const stored = Option.getOrThrow(yield* JobStore.use((store) => store.get(id)))
        expect(stored.status).toBe("interrupted")
      }
      const stored = Option.getOrThrow(yield* JobStore.use((store) => store.get(add.id)))
      expect(statuses(stored)).toMatchObject({ checkAbsent: "done", clone: "interrupted", saveConfig: "pending" })
      // The repos are free again, and the job resumes where it stopped
      yield* clone.release
      yield* runner.retry(add.id)
      expect((yield* runner.await(add.id)).status).toBe("completed")
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })

  it.effect("keeps a job completed when interruptAll arrives while it is saving that status", () => {
    const script = makeScript()
    return Effect.gen(function* () {
      const saving = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      // Saving the completed status waits, so the interrupt lands in the middle of it
      const gatedStore = Layer.effect(
        JobStore,
        Effect.gen(function* () {
          const store = yield* JobStore
          return JobStore.of({
            ...store,
            save: (job) =>
              job.status === "completed"
                ? Deferred.succeed(saving, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(store.save(job))
                  )
                : store.save(job)
          })
        })
      ).pipe(Layer.provide(layerMemory))

      yield* Effect.gen(function* () {
        const runner = yield* JobRunner
        const job = yield* runner.start(syncRepo())
        yield* Deferred.await(saving)

        const interrupting = yield* Effect.forkChild(runner.interruptAll)
        yield* Effect.yieldNow
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interrupting)

        const stored = Option.getOrThrow(yield* JobStore.use((store) => store.get(job.id)))
        expect(stored.status).toBe("completed")
        expect(statuses(stored)).toEqual({ loadRepo: "done", fetch: "done" })
      }).pipe(
        Effect.provide(JobRunnerLayer(script.definitions, { concurrency: 2 }).pipe(Layer.provideMerge(gatedStore)))
      )
    })
  })

  it.effect("saves a step that finished as done, even when interruptAll arrives while that's being saved", () => {
    const script = makeScript()
    return Effect.gen(function* () {
      const saving = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let gated = false
      // Saving loadRepo as done waits once, so the interrupt lands in the middle of it
      const gatedStore = Layer.effect(
        JobStore,
        Effect.gen(function* () {
          const store = yield* JobStore
          return JobStore.of({
            ...store,
            save: (job) => {
              if (gated || !job.steps.some((s) => s.key === "loadRepo" && s.status === "done")) return store.save(job)
              gated = true
              return Deferred.succeed(saving, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(store.save(job))
              )
            }
          })
        })
      ).pipe(Layer.provide(layerMemory))

      yield* Effect.gen(function* () {
        const runner = yield* JobRunner
        const job = yield* runner.start(syncRepo())
        yield* Deferred.await(saving)

        const interrupting = yield* Effect.forkChild(runner.interruptAll)
        yield* Effect.yieldNow
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interrupting)

        const stored = Option.getOrThrow(yield* JobStore.use((store) => store.get(job.id)))
        expect(stored.status).toBe("interrupted")
        expect(statuses(stored)).toEqual({ loadRepo: "done", fetch: "pending" })

        script.ran.length = 0
        yield* runner.retry(job.id)
        expect((yield* runner.await(job.id)).status).toBe("completed")
        expect(script.ran).toEqual(["fetch"])
      }).pipe(
        Effect.provide(JobRunnerLayer(script.definitions, { concurrency: 2 }).pipe(Layer.provideMerge(gatedStore)))
      )
    })
  })

  it.effect("publishes job updates as they happen", () => {
    const script = makeScript()
    return Effect.gen(function* () {
      const runner = yield* JobRunner
      const updates = yield* runner.changes.pipe(
        Stream.map((jobs) => jobs[0]?.steps.filter((s) => s.status === "done").length ?? 0),
        Stream.changes,
        Stream.takeUntil((done) => done === 8),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Effect.yieldNow
      yield* runner.start(addRepo())

      const counts = yield* Fiber.join(updates)
      expect(counts[0]).toBe(0)
      expect(counts.at(-1)).toBe(8)
      // Progress arrives step by step, not only at the end
      expect(counts.length).toBeGreaterThan(3)
    }).pipe(Effect.provide(runnerLayer(script.definitions)))
  })
})
