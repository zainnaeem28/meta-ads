import type { Campaign, QcRun, VideoJob } from '@shroomap/contracts';

/** Contract-shaped fixtures (OpenAPI VideoJob, QcRun, SegmentJobsResponse item, Campaign) for the tests and the e2e script. */
export const CAMPAIGN_ID = '7c1d4a52-0b53-4f6e-9a4e-3f2d1c0b9a88';
export const meta = { requestId: 'req-fixture-8', timestamp: '2026-11-16T09:00:00Z' };
const T = '2026-11-16T09:00:00Z';

export const jobId = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
export const mediaId = (n: number) => `00000000-0000-4000-9000-00000000000${n}`;

export const qcRun = (n: number, over: Partial<QcRun> = {}): QcRun => ({
  id: `00000000-0000-4000-a000-00000000000${n}`,
  state: 'completed',
  label: 'completed',
  causeClass: null,
  causeMessage: null,
  createdAt: T,
  updatedAt: T,
  reused: false,
  videoJobId: jobId(n),
  qcState: 'passed',
  reason: null,
  ...over,
});

export const videoJob = (n: number, over: Partial<VideoJob> = {}): VideoJob => ({
  id: jobId(n),
  state: 'completed',
  label: 'completed',
  causeClass: null,
  causeMessage: null,
  createdAt: T,
  updatedAt: T,
  reused: false,
  campaignId: CAMPAIGN_ID,
  segmentPosition: n,
  segmentRevision: 1,
  outOfDate: false,
  outputMediaId: mediaId(n),
  latestQc: qcRun(n),
  qcHistory: [],
  ...over,
});

export const item = (
  position: number,
  latestJob: VideoJob | null,
  segmentState: 'active' | 'retired' = 'active',
) => ({ position, segmentState, segmentRevision: 1, latestJob });

/** Four-segment-free default: three segments, none generated yet. */
export const emptyList = () => [item(1, null), item(2, null), item(3, null)];

/** One of each: completed and passed, processing, failed (temporary), failed (outcome unknown). */
export const mixedList = () => [
  item(1, videoJob(1)),
  item(
    2,
    videoJob(2, {
      state: 'processing',
      label: 'processing',
      outputMediaId: null,
      latestQc: null,
    }),
  ),
  item(
    3,
    videoJob(3, {
      state: 'failed',
      label: 'failed',
      causeClass: 'temporary',
      causeMessage: 'The provider was busy. Nothing was charged.',
      outputMediaId: null,
      latestQc: null,
    }),
  ),
];

export const unknownOutcomeList = () => [
  item(
    1,
    videoJob(1, {
      state: 'failed',
      label: 'failed',
      causeClass: 'outcome_unknown',
      causeMessage: 'We could not confirm the result. Check your provider account before retrying.',
      outputMediaId: null,
      latestQc: null,
    }),
  ),
  item(2, null),
  item(3, null),
];

export const qcList = () => [
  item(
    1,
    videoJob(1, {
      latestQc: qcRun(1, {
        qcState: 'failed',
        reason: 'Spoken words differ from the script in the second sentence.',
      }),
    }),
  ),
  item(
    2,
    videoJob(2, {
      latestQc: qcRun(2, {
        qcState: 'skipped',
        reason: 'The transcription service was unavailable.',
      }),
    }),
  ),
  item(3, videoJob(3)),
];

export const outOfDateList = () => [
  item(1, videoJob(1, { outOfDate: true, segmentRevision: 1 })),
  item(2, videoJob(2)),
  item(3, videoJob(3)),
];

export const campaignFixture = (over: Partial<Campaign> = {}): Campaign => ({
  id: CAMPAIGN_ID,
  productName: 'Morning Focus Blend',
  productDescriptionExcerpt: 'A daily focus blend.',
  progress: 'in_progress',
  briefState: 'accepted',
  segmentCount: 3,
  finalAvailable: false,
  createdAt: T,
  updatedAt: T,
  productDescription: 'A daily focus blend for calm, steady mornings.',
  productMediaId: null,
  draftId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  jobCounts: {},
  latestAssemblyId: null,
  thumbstopperJobId: null,
  ...over,
});
