import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, FileSystem, Layer } from "effect"
import { TestClock } from "effect/testing"
import { spawn } from "node:child_process"
import { once } from "node:events"
import type { SyncRepoJob } from "../src/jobs/Job.js"
import { type JobDefinitions, make as makeJobRunner } from "../src/jobs/JobRunner.js"
import { JobStore, layerWith } from "../src/jobs/JobStore.js"
import { makeMemoryFs } from "./fixtures/memoryFs.js"

const dir = "/jobs"

const definitions: JobDefinitions<never> = {
  addRepo: { steps: [] },
  syncRepo: { steps: [] },
  reindexRepo: { steps: [] }
}

const elsewhere: SyncRepoJob = {
  id: "syncRepo-acme-widgets-cli",
  kind: "syncRepo",
  repoId: "acme-widgets",
  payload: {},
  status: "running",
  createdAt: DateTime.makeUnsafe(0),
  updatedAt: DateTime.makeUnsafe(0),
  owner: { pid: process.ppid, name: "cli" },
  steps: [{ key: "loadRepo", name: "loadRepo", runsOn: "main", status: "running", attempts: 1 }]
}

const followingRunner = Effect.gen(function* () {
  const fs = yield* makeMemoryFs
  const storeLayer = layerWith({ dir }).pipe(Layer.provide(fs.layer))
  const other = yield* JobStore.pipe(Effect.provide(storeLayer))
  const runner = yield* makeJobRunner(definitions, { concurrency: 1, followOthers: true }).pipe(
    Effect.provide(storeLayer)
  )
  const files = yield* FileSystem.FileSystem.pipe(Effect.provide(fs.layer))
  return { other, runner, files }
})

describe("following other processes' jobs", () => {
  it.effect("picks up a job another process saves", () =>
    Effect.gen(function* () {
      const { other, runner } = yield* followingRunner

      yield* other.save(elsewhere)
      yield* TestClock.adjust("500 millis")

      expect((yield* runner.jobs).map((job) => job.id)).toEqual([elsewhere.id])
    }).pipe(Effect.scoped))

  it.effect("picks up another process's update to a job", () =>
    Effect.gen(function* () {
      const { other, runner } = yield* followingRunner
      yield* other.save(elsewhere)

      yield* other.save({ ...elsewhere, status: "completed", updatedAt: DateTime.makeUnsafe(1000) })
      yield* TestClock.adjust("500 millis")

      expect((yield* runner.jobs).map((job) => job.status)).toEqual(["completed"])
    }).pipe(Effect.scoped))

  it.effect("drops a job another process removes", () =>
    Effect.gen(function* () {
      const { other, runner } = yield* followingRunner
      yield* other.save(elsewhere)

      yield* other.remove(elsewhere.id)
      yield* TestClock.adjust("500 millis")

      expect(yield* runner.jobs).toEqual([])
    }).pipe(Effect.scoped))

  it.effect("marks a job interrupted once the process running it has died", () =>
    Effect.gen(function* () {
      const { other, runner } = yield* followingRunner
      const child = spawn("sleep", ["60"])
      yield* other.save({ ...elsewhere, owner: { pid: child.pid ?? 0, name: "cli" } })
      yield* TestClock.adjust("500 millis")
      expect((yield* runner.jobs).map((job) => job.status)).toEqual(["running"])

      child.kill()
      yield* Effect.promise(() => once(child, "exit"))
      yield* TestClock.adjust("15 seconds")

      expect((yield* runner.jobs).map((job) => job.status)).toEqual(["interrupted"])
    }).pipe(Effect.scoped))

  it.effect("ignores a temp file another process left behind", () =>
    Effect.gen(function* () {
      const { files, runner } = yield* followingRunner

      yield* files.writeFileString(`${dir}/${elsewhere.id}.json.tmp-123-abc`, "{")
      yield* TestClock.adjust("500 millis")

      expect(yield* runner.jobs).toEqual([])
    }).pipe(Effect.scoped))
})
