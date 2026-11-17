import { labelOf } from '../domain/video-job.js';
import type { ThumbRecord } from '../application/thumb.service.js';
import { instant } from './video-view.js';

/** `Thumbstopper` (`JobSummary` and the call-out); `reused` is true when API-075 returned an existing job, false on reads. */
export const thumbView = (job: ThumbRecord, reused: boolean) => ({
  id: job.id,
  state: job.state,
  label: labelOf(job.state),
  causeClass: job.causeClass,
  causeMessage: job.causeMessage,
  createdAt: instant(job.createdAt),
  updatedAt: instant(job.updatedAt),
  deadlineAt: instant(job.deadlineAt),
  reused,
  campaignId: job.campaignId,
  calloutText: job.calloutText,
  outputMediaId: job.outputMediaId,
});
