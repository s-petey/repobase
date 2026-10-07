import {
  formatStepError,
  isRetryable,
  type Job,
  type Step,
  type StepErrorDisplay,
  type StepStatus,
} from "@repobase/engine";
import { DateTime, Duration } from "effect";

export interface StepLine {
  readonly key: string;
  readonly label: string;
  readonly status: StepStatus;
  readonly error?: StepErrorDisplay;
}

export const stepIcon: Record<StepStatus, string> = {
  done: "✓",
  failed: "✗",
  running: "◌",
  pending: "·",
  interrupted: "!",
  skipped: "-",
};

const isFanOutItem = (step: Step) => step.key !== step.name;

// One status for a group of batch steps: the most urgent one wins
const groupStatus = (steps: ReadonlyArray<Step>): StepStatus => {
  const has = (status: StepStatus) => steps.some((s) => s.status === status);
  if (has("failed")) return "failed";
  if (has("interrupted")) return "interrupted";
  if (has("running")) return "running";
  if (steps.every((s) => s.status === "done")) return "done";
  if (steps.every((s) => s.status === "skipped")) return "skipped";
  return "pending";
};

const errorOf = (step: Step | undefined) =>
  step?.error ? formatStepError(step.error) : undefined;

/**
 * A job's steps as checklist lines, with fan-out steps (one per batch)
 * collapsed into a single "indexBatch 12/40 (2 failed)" line
 */
export const stepLines = (job: Job): ReadonlyArray<StepLine> =>
  job.steps.flatMap((step): ReadonlyArray<StepLine> => {
    if (isFanOutItem(step)) return [];

    const items = job.steps.filter(
      (s) => s.name === step.name && isFanOutItem(s),
    );
    if (items.length === 0) {
      return [
        {
          key: step.key,
          label: step.name,
          status: step.status,
          error: errorOf(step),
        },
      ];
    }

    const done = items.filter((s) => s.status === "done").length;
    const failed = items.filter((s) => s.status === "failed");
    const label = `${step.name} ${done}/${items.length}${failed.length > 0 ? ` (${failed.length} failed)` : ""}`;
    return [
      {
        key: step.key,
        label,
        status: groupStatus(items),
        error: errorOf(failed[0]),
      },
    ];
  });

/**
 * Whether `r` can retry the job, and if not, what to tell the user instead
 */
export const retryState = (
  job: Job,
): { readonly canRetry: boolean; readonly reason?: string } => {
  if (job.status !== "failed" && job.status !== "interrupted") {
    return {
      canRetry: false,
      reason: `Only failed or interrupted tasks can be retried (this one is ${job.status})`,
    };
  }

  const permanent = job.steps.find(
    (s) => s.status === "failed" && s.error && !isRetryable(s.error),
  );

  if (permanent?.error) {
    return {
      canRetry: false,
      reason:
        formatStepError(permanent.error).hint ??
        "Retrying can't fix this; discard it",
    };
  }
  return { canRetry: true };
};

const relativeTime = new Intl.RelativeTimeFormat("en", {
  style: "narrow",
  numeric: "auto",
});

export const formatAge = (from: DateTime.Utc, now: DateTime.Utc): string => {
  const elapsed = DateTime.distance(from, now);
  if (Duration.isLessThan(elapsed, Duration.minutes(1))) {
    return relativeTime.format(0, "second");
  }

  if (Duration.isLessThan(elapsed, Duration.hours(1))) {
    return relativeTime.format(
      -Math.floor(Duration.toMinutes(elapsed)),
      "minute",
    );
  }

  if (Duration.isLessThan(elapsed, Duration.days(1))) {
    return relativeTime.format(-Math.floor(Duration.toHours(elapsed)), "hour");
  }

  return relativeTime.format(-Math.floor(Duration.toDays(elapsed)), "day");
};

/**
 * The newest job for each repo, of either kind: a later add or sync supersedes
 * an earlier job for the same repo that failed
 */
export const latestJobs = (jobs: ReadonlyArray<Job>): ReadonlyArray<Job> => {
  const latest = new Map<string, Job>();

  for (const job of jobs) {
    const current = latest.get(job.repoId);
    if (!current || DateTime.toEpochMillis(job.createdAt) > DateTime.toEpochMillis(current.createdAt)) {
      latest.set(job.repoId, job);
    }
  }

  return [...latest.values()];
};

/**
 * Counts for the status bar, over each repo's latest job, so a failure that a
 * newer run fixed isn't counted. Interrupted jobs count as failed since both
 * need a retry.
 */
export const jobCounts = (
  jobs: ReadonlyArray<Job>,
): { readonly running: number; readonly failed: number } => {
  let running = 0;
  let failed = 0;

  for (const job of latestJobs(jobs)) {
    switch (job.status) {
      case "running":
        running++;
        continue;
      case "failed":
      case "interrupted":
        failed++;
        continue;
    }
  }

  return {
    running,
    failed,
  };
};

export const kindLabel: Record<Job["kind"], string> = {
  addRepo: "add",
  syncRepo: "sync",
  reindexRepo: "re-index",
};

const RESUMABLE_FAILED_STEPS: ReadonlySet<string> = new Set([
  "deleteRemoved",
  "indexBatch",
  "finalizeIndex",
  "updateStore",
  "stampIndexFormat",
  "recordSynced",
]);

export const resumableJob = (
  jobs: ReadonlyArray<Job>,
  repoId: string,
  kind: Job["kind"] = "syncRepo",
): Job | undefined => {
  let latest: Job | undefined;
  for (const job of jobs) {
    if (job.kind !== kind || job.repoId !== repoId) continue;
    if (!latest || DateTime.toEpochMillis(job.createdAt) > DateTime.toEpochMillis(latest.createdAt)) {
      latest = job;
    }
  }
  if (!latest) return undefined;

  if (latest.status === "interrupted") return latest;
  if (latest.status !== "failed" || !retryState(latest).canRetry) return undefined;

  const failed = latest.steps.find((s) => s.status === "failed");
  return failed && RESUMABLE_FAILED_STEPS.has(failed.name) ? latest : undefined;
};

/**
 * An add or re-index of the repo that stopped partway and can pick up where it
 * stopped. A sync has to finish it first: the repo can look synced while some
 * files were never indexed, so the sync would find nothing new and skip them.
 */
export const unfinishedIndexing = (jobs: ReadonlyArray<Job>, repoId: string): Job | undefined =>
  resumableJob(jobs, repoId, "addRepo") ?? resumableJob(jobs, repoId, "reindexRepo");

export const resumePoint = (job: Job): string | undefined => {
  const batches = job.steps.filter((s) => s.name === "indexBatch" && s.key !== "indexBatch");
  const done = batches.filter((s) => s.status === "done").length;
  if (batches.length > 0 && done > 0 && done < batches.length) {
    return `batch ${done + 1}/${batches.length}`;
  }
  return job.steps.find((s) => s.status !== "done" && s.status !== "skipped")?.name;
};

export type SyncActivity =
  | { readonly kind: "one"; readonly repoId: string }
  | { readonly kind: "all"; readonly since: DateTime.Utc; readonly total: number };

export const syncActivityText = (
  activity: SyncActivity,
  jobs: ReadonlyArray<Job>,
  workerLimit?: number,
): string => {
  const workers =
    workerLimit === undefined ? "" : ` · up to ${workerLimit} worker${workerLimit === 1 ? "" : "s"}`;

  if (activity.kind === "one") {
    return `Syncing ${activity.repoId}${workers}`;
  }

  const since = DateTime.toEpochMillis(activity.since);
  const finished = jobs.filter(
    (job) =>
      job.kind === "syncRepo" &&
      job.status !== "running" &&
      DateTime.toEpochMillis(job.createdAt) >= since,
  ).length;

  return `Syncing ${Math.min(finished, activity.total)}/${activity.total} repos${workers}`;
};
