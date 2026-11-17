import type { Brief, Campaign, ClaimIssue, Segment } from '@shroomap/contracts';

/** Contract-shaped fixtures (OpenAPI Brief, Segment, ClaimIssue, Campaign) for the component tests and the e2e script. */
export const CAMPAIGN_ID = '7c1d4a52-0b53-4f6e-9a4e-3f2d1c0b9a88';
export const meta = { requestId: 'req-fixture-1', timestamp: '2026-11-16T09:00:00Z' };
const T = '2026-11-16T09:00:00Z';

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i + 1}`).join(' ');

export const segment = (position: number, over: Partial<Segment> = {}): Segment => ({
  position,
  state: 'active',
  revision: 1,
  dialogue:
    position === 3
      ? "Everyone's mornings look different. If you are curious what fits yours, there is a short way to find out. Take the free 2-minute quiz today."
      : `I am not a morning person, so I keep my routine simple with coffee, quiet light, and two capsules of Morning Focus Blend on the counter, nothing fancy just a steady habit before the run ${position}.`,
  prompt: `Handheld vertical shot ${position}, soft window light in a small kitchen. The runner holds the bottle toward the camera.`,
  wordCount: 32,
  ...over,
});

export const highRisk: ClaimIssue = {
  id: '11111111-1111-4111-8111-111111111111',
  segmentPosition: 2,
  field: 'dialogue',
  ruleId: 'BR-06-cure-claim',
  class: 'high_risk',
  resolution: 'open',
  message:
    'This wording implies a treatment claim. Edit the text until this check no longer finds it.',
  span: { start: 40, end: 70 },
  clearReason: null,
};
export const otherIssue: ClaimIssue = {
  id: '22222222-2222-4222-8222-222222222222',
  segmentPosition: 1,
  field: 'dialogue',
  ruleId: 'BR-11-em-dash',
  class: 'other',
  resolution: 'open',
  message: 'Public copy must not contain em dashes. Edit the text.',
  span: null,
  clearReason: null,
};

export const briefFixture = (over: Partial<Brief> = {}): Brief => ({
  id: '9d2f8c10-5a3b-4e7c-8f61-0a1b2c3d4e5f',
  campaignId: CAMPAIGN_ID,
  state: 'draft',
  version: 3,
  acceptedAt: null,
  generationJob: null,
  segments: [segment(1), segment(2), segment(3)],
  issues: [highRisk, otherIssue],
  updatedAt: T,
  ...over,
});

export const acceptedBrief = (): Brief =>
  briefFixture({ state: 'accepted', acceptedAt: T, issues: [], version: 4 });

export const generatingBrief = (): Brief =>
  briefFixture({
    state: 'generating',
    segments: [],
    issues: [],
    generationJob: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      state: 'processing',
      label: 'processing',
      causeClass: null,
      causeMessage: null,
      createdAt: T,
      updatedAt: T,
      reused: false,
    },
  });

export const failedBrief = (): Brief =>
  briefFixture({
    state: 'failed',
    segments: [],
    issues: [],
    generationJob: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      state: 'failed',
      label: 'failed',
      causeClass: 'credit',
      causeMessage:
        'Your OpenAI account reported that it is out of credit. Nothing was charged. Add credit at OpenAI, then try again. Your answers are saved.',
      createdAt: T,
      updatedAt: T,
      reused: false,
    },
  });

export const campaignFixture = (over: Partial<Campaign> = {}): Campaign => ({
  id: CAMPAIGN_ID,
  productName: 'Morning Focus Blend',
  productDescriptionExcerpt: 'A daily focus blend.',
  progress: 'in_progress',
  briefState: 'draft',
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

export { words };
