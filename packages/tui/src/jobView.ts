import { superseded, type Job } from "@repobase/engine";
import { DateTime, Duration } from "effect";

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
 * need a retry; superseded ones don't, since they can't be retried.
 */
export const jobCounts = (
  jobs: ReadonlyArray<Job>,
): { readonly running: number; readonly failed: number } => {
  let running = 0;
  let failed = 0;

  for (const job of latestJobs(jobs)) {
    if (superseded(job)) continue;
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

export type SyncActivity =
  | { readonly kind: "one"; readonly repoId: string }
  | { readonly kind: "all"; readonly since: DateTime.Utc; readonly total: number };

export const workersText = (workerLimit: number): string =>
  `up to ${workerLimit} worker${workerLimit === 1 ? "" : "s"}`;

export const syncActivityText = (
  activity: SyncActivity,
  jobs: ReadonlyArray<Job>,
): string => {
  if (activity.kind === "one") {
    return `Syncing ${activity.repoId}`;
  }

  const since = DateTime.toEpochMillis(activity.since);
  const finished = jobs.filter(
    (job) =>
      job.kind === "syncRepo" &&
      job.status !== "running" &&
      DateTime.toEpochMillis(job.createdAt) >= since,
  ).length;

  return `Syncing ${Math.min(finished, activity.total)}/${activity.total} repos`;
};
