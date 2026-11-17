import type { Assembly, Campaign, QcRun, VideoJob } from '@shroomap/contracts';

/** Contract-shaped fixtures (OpenAPI VideoJob, QcRun, SegmentJobsResponse item, Assembly, Campaign) for the tests and the e2e script. */
export const CAMPAIGN_ID = '7c1d4a52-0b53-4f6e-9a4e-3f2d1c0b9a88';
export const ASSEMBLY_ID = '5b0e7d36-2f0f-4b57-8a7e-0d9f3d2b1c11';
export const meta = { requestId: 'req-fixture-9', timestamp: '2026-11-17T09:00:00Z' };
const T = '2026-11-17T09:00:00Z';

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

const failedQc = (n: number) =>
  qcRun(n, { qcState: 'failed', reason: 'speech did not match the script' });
const skippedQc = (n: number) =>
  qcRun(n, { qcState: 'skipped', reason: 'The audio service did not answer.' });

/** Three completed clips that all passed. */
export const passedList = () => [1, 2, 3].map((n) => item(n, videoJob(n)));

/** Segment 2 failed its check, segment 3 was skipped (the frame's `selecting`). */
export const exceptionList = () => [
  item(1, videoJob(1)),
  item(2, videoJob(2, { latestQc: failedQc(2) })),
  item(3, videoJob(3, { latestQc: skippedQc(3) })),
];

/** One completed clip, one still processing, one never generated. */
export const partialList = () => [
  item(1, videoJob(1)),
  item(
    2,
    videoJob(2, { state: 'processing', label: 'processing', outputMediaId: null, latestQc: null }),
  ),
  item(3, null),
];

export const noClipsList = () => [item(1, null), item(2, null)];

export const campaignFixture = (over: Partial<Campaign> = {}): Campaign => ({
  id: CAMPAIGN_ID,
  productName: 'Evening Calm Gummies',
  productDescriptionExcerpt: 'A calming evening gummy.',
  progress: 'in_progress',
  briefState: 'accepted',
  segmentCount: 3,
  finalAvailable: false,
  createdAt: T,
  updatedAt: T,
  productDescription: 'A calming evening gummy for winding down.',
  productMediaId: null,
  draftId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  jobCounts: {},
  latestAssemblyId: null,
  thumbstopperJobId: null,
  ...over,
});

export const assemblyFixture = (
  state: Assembly['state'],
  over: Partial<Assembly> = {},
): Assembly => ({
  id: ASSEMBLY_ID,
  campaignId: CAMPAIGN_ID,
  state,
  clips: [1, 2, 3].map((n) => ({
    position: n,
    videoJobId: jobId(n),
    outOfDate: false,
    qcOverrideConfirmed: false,
  })),
  thumbstopperJobId: null,
  outOfDate: false,
  outputMediaId: state === 'done' ? mediaId(9) : null,
  causeClass: state === 'failed' ? 'input_unavailable' : null,
  causeMessage:
    state === 'failed' ? 'One selected clip could not be fetched from storage (segment 3).' : null,
  createdAt: T,
  updatedAt: T,
  reused: false,
  ...over,
});
