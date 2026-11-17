/** What production reads of its own tables, shaped for the transport layer. */

export interface VideoConfig {
  /** `WAVESPEED_MODEL_I2V`, used when the clip starts from the product image. */
  readonly modelI2v: string;
  /** `WAVESPEED_MODEL_T2V`, used when it does not. */
  readonly modelT2v: string;
  /** `OPENAI_TRANSCRIBE_MODEL`: the QC estimate is reserved with the clip (ARCHITECTURE §5.5). */
  readonly transcribeModel: string;
  readonly durationSeconds: number;
  readonly resolution: string;
  readonly aspectRatio: string;
  /** `VIDEO_JOB_DEADLINE_MIN`. */
  readonly deadlineMinutes: number;
  readonly idempotencyTtlHours: number;
}

export const VIDEO_CONFIG = Symbol('VIDEO_CONFIG');

export interface JobRecord {
  readonly id: string;
  readonly state: string;
  readonly causeClass: string | null;
  readonly causeMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deadlineAt: string;
}

export interface QcRecord extends JobRecord {
  readonly videoJobId: string;
  readonly qcState: string;
  readonly reason: string | null;
}

export interface VideoJobRecord extends JobRecord {
  readonly campaignId: string;
  readonly segmentId: string;
  readonly segmentPosition: number;
  readonly segmentRevision: number;
  /** The revision the segment has now; the clip is out of date when it is higher (SB-D11). */
  readonly currentRevision: number;
  readonly outputMediaId: string | null;
  readonly latestQc: QcRecord | null;
  readonly qcHistory: readonly QcRecord[];
}

export interface VideoJobOutcome {
  readonly job: VideoJobRecord;
  readonly reused: boolean;
}

export interface SegmentJobsEntry {
  readonly position: number;
  readonly segmentState: 'active' | 'retired';
  readonly segmentRevision: number;
  readonly latestJob: VideoJobRecord | null;
}

export type CancelCause = 'cancelled_campaign_deleted' | 'cancelled_account_suspended' | 'cancelled_account_removed';

/** `JobStats` over [windowStart, windowEnd): every counter is counted by its own event time inside the window. */
export interface JobStatsWindow extends JobStats {
  readonly windowEnd: string;
}

export interface JobStats {
  readonly windowStart: string;
  readonly videoCreated: number;
  readonly videoCompleted: number;
  readonly videoFailed: number;
  readonly videoCancelled: number;
  readonly qcCreated: number;
}
