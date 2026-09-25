import { formatStepError, type AddRepoProgress, type FileProgress, type Job } from "@repobase/engine"

// How the add-repo ProgressModal presents a running job

/**
 * Title of the step error that stopped a job, for the modal and status bar
 */
export const jobFailureMessage = (job: Job): string => {
  const failed = job.steps.find((s) => s.status === "failed" && s.error)
  if (failed?.error) return formatStepError(failed.error).title
  return job.status === "interrupted" ? "Stopped before it finished" : `Job ${job.status}`
}

// The step to describe: the one running, or else the next one to run
const currentStep = (job: Job) =>
  job.steps.find((s) => s.status === "running") ?? job.steps.find((s) => s.status === "pending")

/**
 * Map an addRepo job, plus live per-file progress while indexing, to what the
 * progress modal shows. Cloning fills 0-40%, planning 50%, indexing 50-95%.
 */
export const addRepoProgress = (job: Job, files?: FileProgress): AddRepoProgress => {
  const counts = files ? { filesIndexed: files.filesStarted, totalFiles: files.totalFiles } : {}

  if (job.status === "completed") {
    return { stage: "complete", progress: 100, message: `Added ${job.repoId}`, ...counts }
  }
  if (job.status !== "running") {
    return { stage: "error", progress: 0, message: jobFailureMessage(job) }
  }

  switch (currentStep(job)?.name) {
    case "checkAbsent":
    case "clone":
      return {
        stage: "cloning",
        progress: 10,
        message: `Cloning ${job.kind === "addRepo" ? job.payload.url : job.repoId}...`
      }
    case "resolveHead":
    case "saveConfig":
      return { stage: "cloning", progress: 40, message: "Clone complete, preparing..." }
    case "planFullIndex":
    case "deleteRemoved":
      return { stage: "indexing", progress: 50, message: "Scanning files..." }
    case "indexBatch": {
      const ratio = files && files.totalFiles > 0 ? files.filesStarted / files.totalFiles : 0
      return {
        stage: "indexing",
        progress: Math.min(95, Math.round(50 + ratio * 45)),
        message: `Indexing: ${files?.currentFile ?? "..."}`,
        currentFile: files?.currentFile,
        ...counts
      }
    }
    case "finalizeIndex":
      return { stage: "indexing", progress: 95, message: "Finalizing index...", ...counts }
    default:
      return { stage: "cloning", progress: 0, message: "Starting..." }
  }
}
