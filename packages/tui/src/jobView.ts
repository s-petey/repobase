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

export const jobCounts = (
  jobs: ReadonlyArray<Job>,
): { readonly running: number; readonly failed: number } => {
  let running = 0;
  let failed = 0;

  for (const job of jobs) {
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
};
