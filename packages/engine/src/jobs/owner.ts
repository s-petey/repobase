import { Option, Predicate } from "effect"
import { spawnSync } from "node:child_process"
import type { Job, JobOwner } from "./Job.js"

// What process.kill throws for a process that exists but belongs to another user
const NOT_PERMITTED = "EPERM"

// Signal 0 checks that a process exists without sending it anything
const EXISTENCE_CHECK = 0

// ps gives elapsed time to the second, as [[dd-]hh:]mm:ss
const PS_ELAPSED_TIME = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/
const START_TIME_TOLERANCE_MS = 2000
const OWNER_CHECK_CACHE_MS = 5000

const nowMillis = () => performance.timeOrigin + performance.now()

export const thisProcessStartedAt = (): number => Math.round(performance.timeOrigin)

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, EXISTENCE_CHECK)
    return true
  } catch (error) {
    return Predicate.hasProperty(error, "code") && error.code === NOT_PERMITTED
  }
}

const processStartedAt = (pid: number): Option.Option<number> => {
  const ps = spawnSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" })
  const elapsed = ps.status === 0 ? PS_ELAPSED_TIME.exec(ps.stdout.trim()) : null
  if (!elapsed) return Option.none()
  const [, days, hours, minutes, seconds] = elapsed
  const elapsedSeconds = ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)
  return Option.some(nowMillis() - elapsedSeconds * 1000)
}

const checked = new Map<string, { readonly alive: boolean; readonly at: number }>()

const sameProcess = (pid: number, startedAt: number): boolean => {
  const key = `${pid}:${startedAt}`
  const cached = checked.get(key)
  if (cached && nowMillis() - cached.at < OWNER_CHECK_CACHE_MS) return cached.alive
  const alive = Option.match(processStartedAt(pid), {
    onNone: () => true,
    onSome: (actual) => Math.abs(actual - startedAt) <= START_TIME_TOLERANCE_MS
  })
  checked.set(key, { alive, at: nowMillis() })
  return alive
}

// An owner saved without a start time (before they were recorded) is judged by its pid alone
export const ownerAlive = (owner: JobOwner): boolean =>
  isProcessAlive(owner.pid) && (owner.startedAt === undefined || sameProcess(owner.pid, owner.startedAt))

export const runningElsewhere = (job: Job): boolean =>
  job.status === "running" && job.owner !== undefined && job.owner.pid !== process.pid && ownerAlive(job.owner)

export const runningHere = (job: Job): boolean => job.status === "running" && job.owner?.pid === process.pid

export const abandoned = (job: Job): boolean => job.status === "running" && !(job.owner && ownerAlive(job.owner))
