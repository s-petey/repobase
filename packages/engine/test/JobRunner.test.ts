import { describe, it, expect } from "@effect/vitest"
import { DateTime, Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import {
  CloneFailedError,
  IndexBatchFailedError,
  RemoteBranchMissingError,
  type StepError,
  UnexpectedStepError
} from "../src/jobs/errors.js"
import type { AddRepoJob, Job, Step, SyncRepoJob } from "../src/jobs/Job.js"
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

  const definitions: JobDefinitions<never> = {
    addRepo: { steps: [checkAbsent, clone, saveConfig, indexBatch, finalize] },
    syncRepo: { steps: [loadRepo, fetch] }
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
