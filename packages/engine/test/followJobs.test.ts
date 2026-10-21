import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
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
  return { other, runner }
})

describe("following other processes' jobs", () => {
  it.effect("picks up a job another process saves", () =>
    Effect.gen(function* () {
      const { other, runner } = yield* followingRunner

      yield* other.save(elsewhere)
      yield* TestClock.adjust("500 millis")

      expect((yield* runner.jobs).map((job) => job.id)).toEqual([elsewhere.id])
    }).pipe(Effect.scoped))
})
