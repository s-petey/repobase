import { Predicate } from "effect"
import type { Job } from "./Job.js"

// What process.kill throws for a process that exists but belongs to another user
const NOT_PERMITTED = "EPERM"

// Signal 0 checks that a process exists without sending it anything
const EXISTENCE_CHECK = 0

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, EXISTENCE_CHECK)
    return true
  } catch (error) {
    return Predicate.hasProperty(error, "code") && error.code === NOT_PERMITTED
  }
}

export const runningElsewhere = (job: Job): boolean =>
  job.status === "running" &&
  job.owner !== undefined &&
  job.owner.pid !== process.pid &&
  isProcessAlive(job.owner.pid)

export const runningHere = (job: Job): boolean => job.status === "running" && job.owner?.pid === process.pid
