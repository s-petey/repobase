import { describe, expect, it } from "@effect/vitest"
import { DateTime } from "effect"
import { spawnSync } from "node:child_process"
import type { Job } from "../src/jobs/Job.js"
import { abandoned, ownerAlive, thisProcessStartedAt, runningElsewhere } from "../src/jobs/owner.js"

const HOUR_MS = 60 * 60 * 1000

const thisProcess = { pid: process.pid, name: "tui", startedAt: thisProcessStartedAt() }
const parent = { pid: process.ppid, name: "cli" }

const running = (owner: Job["owner"]): Job => ({
  id: "syncRepo-acme-widgets-1",
  kind: "syncRepo",
  repoId: "acme-widgets",
  payload: {},
  status: "running",
  createdAt: DateTime.makeUnsafe(0),
  updatedAt: DateTime.makeUnsafe(0),
  owner,
  steps: []
})

describe("ownerAlive", () => {
  it("is true for a live process started when the owner says", () => {
    expect(ownerAlive(thisProcess)).toBe(true)
  })

  it("is false for a live pid that another process started earlier took over", () => {
    expect(ownerAlive({ ...thisProcess, startedAt: thisProcess.startedAt - HOUR_MS })).toBe(false)
  })

  it("is false for a pid no process has", () => {
    expect(ownerAlive({ pid: spawnSync("true").pid, name: "cli", startedAt: thisProcessStartedAt() })).toBe(false)
  })

  it("trusts the pid alone for an owner saved before start times were recorded", () => {
    expect(ownerAlive(parent)).toBe(true)
  })
})

describe("a job whose owner's pid was reused", () => {
  const reused = running({ ...parent, startedAt: thisProcessStartedAt() + HOUR_MS })

  it("is abandoned, not running elsewhere", () => {
    expect(abandoned(reused)).toBe(true)
    expect(runningElsewhere(reused)).toBe(false)
  })
})
