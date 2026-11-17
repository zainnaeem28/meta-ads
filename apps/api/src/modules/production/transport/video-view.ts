import { isOutOfDate, labelOf } from '../domain/video-job.js';
import type { JobRecord, QcRecord, VideoJobRecord } from '../application/video-ports.js';

/** `2026-11-15 23:53:22.123456+00` to `2026-11-15T23:53:22.123456Z` (microseconds kept). */
export function instant(text: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)\+00(?::00)?$/.exec(text);
  return match === null ? new Date(text).toISOString() : `${match[1] ?? ''}T${match[2] ?? ''}Z`;
}

/** `JobSummary`: `reused` is true when a job-creating call returned an existing job, false on reads. */
const summary = (job: JobRecord, reused: boolean) => ({
  id: job.id,
  state: job.state,
  label: labelOf(job.state),
  causeClass: job.causeClass,
  causeMessage: job.causeMessage,
  createdAt: instant(job.createdAt),
  updatedAt: instant(job.updatedAt),
  deadlineAt: instant(job.deadlineAt),
  reused,
});

export const qcView = (run: QcRecord) => ({
  ...summary(run, false),
  videoJobId: run.videoJobId,
  qcState: run.qcState,
  reason: run.reason,
});

/** `VideoJob`; `outOfDate` is derived here from the revisions read in the same query (SB-D11). */
export const videoJobView = (job: VideoJobRecord, reused: boolean) => ({
  ...summary(job, reused),
  campaignId: job.campaignId,
  segmentPosition: job.segmentPosition,
  segmentRevision: job.segmentRevision,
  outOfDate: isOutOfDate(job.segmentRevision, job.currentRevision),
  outputMediaId: job.outputMediaId,
  latestQc: job.latestQc === null ? null : qcView(job.latestQc),
  qcHistory: job.qcHistory.map(qcView),
});
