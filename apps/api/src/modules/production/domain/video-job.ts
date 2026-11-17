import { createHash } from 'node:crypto';

/** Domain rules of the video jobs (ARCHITECTURE §5.5, SB-D11, SB §3.5). Framework-free. */

export const SEGMENT_POSITIONS = [1, 2, 3, 4] as const;

export interface VideoOptions {
  readonly durationSeconds: number;
  readonly resolution: string;
  readonly aspectRatio: string;
}

/** SHA-256 hex of what makes two clips the same work: segment, its text, the reference image and the options (SB-D11). */
export function videoReuseHash(input: {
  readonly segmentId: string;
  readonly prompt: string;
  readonly dialogue: string;
  readonly referenceMediaId: string | null;
  readonly options: VideoOptions;
}): string {
  const { durationSeconds, resolution, aspectRatio } = input.options;
  const parts = [
    'video',
    input.segmentId,
    input.prompt,
    input.dialogue,
    input.referenceMediaId ?? '',
    String(durationSeconds),
    resolution,
    aspectRatio,
  ];
  // JSON keeps the fields apart, so no text can shift into its neighbour.
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** A job built from segment revision `n` is out of date once the segment's revision is above `n` (derived, never stored). */
export function isOutOfDate(jobSegmentRevision: number, segmentRevision: number): boolean {
  return jobSegmentRevision < segmentRevision;
}

export const NON_TERMINAL = ['pending', 'submitting', 'submitted', 'processing'] as const;
export const RETRYABLE = ['failed', 'cancelled'] as const;

export const isRetryable = (state: string): boolean => (RETRYABLE as readonly string[]).includes(state);
export const isNonTerminal = (state: string): boolean => (NON_TERMINAL as readonly string[]).includes(state);

/** The user-facing label of a job state (SB §3.5): the screen shows `pending` as "queued" when the running limit holds it. */
const LABELS: Readonly<Record<string, string>> = {
  pending: 'pending',
  submitting: 'created',
  submitted: 'created',
  processing: 'processing',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'failed',
};
export const labelOf = (state: string): string => LABELS[state] ?? 'pending';

export type CampaignProgress = 'in_progress' | 'processing' | 'completed' | 'failed';

export interface ProgressFacts {
  /** Any brief, video job, QC run (or later assembly, thumbstopper) of the campaign that is not finished. */
  readonly anyNonTerminal: boolean;
  readonly briefFailed: boolean;
  /** States of the latest video job of each active segment. */
  readonly latestVideoStates: readonly string[];
  /** A `done` assembly exists (production slice 4). */
  readonly assemblyDone: boolean;
  readonly latestAssemblyFailed: boolean;
}

/** ARCHITECTURE §3.2 / TD-D12: `processing`, else `failed`, else `completed`, else `in_progress`. */
export function deriveProgress(facts: ProgressFacts): CampaignProgress {
  if (facts.anyNonTerminal) return 'processing';
  if (facts.briefFailed || facts.latestAssemblyFailed || facts.latestVideoStates.some(isRetryable)) return 'failed';
  if (facts.assemblyDone) return 'completed';
  return 'in_progress';
}
