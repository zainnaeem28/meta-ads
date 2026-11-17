import type { JobOutcome, JobRow } from './submit-jobs.js';

/** `2026-11-15 23:53:22.123456+00` to `2026-11-15T23:53:22.123456Z` (microseconds kept). */
export function instant(text: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)\+00(?::00)?$/.exec(text);
  return match === null ? new Date(text).toISOString() : `${match[1] ?? ''}T${match[2] ?? ''}Z`;
}

/** The user-facing label of a job state (ARCHITECTURE §5.3 mapping, SB §3.5). */
const LABELS: Readonly<Record<string, string>> = {
  pending: 'pending',
  submitting: 'queued',
  submitted: 'created',
  processing: 'processing',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'failed',
};

/** `JobSummary`: `reused` is true when a job-creating call returned an existing job, false on reads. */
export const jobSummary = (job: JobRow, reused: boolean) => ({
  id: job.id,
  state: job.state,
  label: LABELS[job.state] ?? 'pending',
  causeClass: job.causeClass,
  causeMessage: job.causeMessage,
  createdAt: instant(job.createdAt),
  updatedAt: instant(job.updatedAt),
  deadlineAt: instant(job.deadlineAt),
  reused,
});

export const outcomeSummary = (outcome: JobOutcome) => jobSummary(outcome.job, outcome.reused);
