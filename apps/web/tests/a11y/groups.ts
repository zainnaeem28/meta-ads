import {
  CAMPAIGN_ID,
  briefFixture,
  campaignFixture,
  meta as fixtureMeta,
  mixedList,
} from '../../src/features/fe-screen-008/fixtures';
import { CAMPAIGN_ID as FINAL_CAMPAIGN, campaignFixture as finalCampaign, passedList } from '../../src/features/fe-screen-009a/fixtures';
import { ok, type Script } from './support';

/**
 * The screen groups the UI-UX §12 captures (reflow, zoom, text spacing, keyboard, motion) are taken on: one real page
 * per group, in a state that shows its full content. `screens` ties each group to the inventory
 * (design/mockups/frames.json) and is checked by scripts/ci/screen-coverage.mjs.
 */
export interface Group {
  id: string;
  screens: string[];
  path: string;
  session: boolean;
  /** Text that proves the page rendered its content before it is captured. */
  ready: string;
  script: Script;
  /** The control that opens a dialog, for the focus-return check (keyboard: Enter opens, Escape returns focus). */
  dialog?: { trigger: string; dialog: string };
  /** Text shown only in the wide layout (not expected at 320 px, 200 % zoom or phone widths). */
  wideOnly?: string[];
}

const id = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const linked = ok({
  linkState: 'linked',
  id: id('a', 1),
  role: 'user',
  status: 'active',
  mfa: { required: true, satisfied: true },
  recentAuth: { satisfied: true, maxAgeSeconds: 600 },
  keyNotices: [],
});
const key = (provider: string) => ({
  provider,
  configured: true,
  status: 'active',
  last4: '7Q2d',
  fingerprint: '4f9a1c07b21e',
  version: 1,
  createdAt: '2026-11-03T09:14:00.000Z',
  updatedAt: '2026-11-03T09:14:00.000Z',
  lastValidatedAt: '2026-11-12T09:41:00.000Z',
  inFlightJobCount: 0,
});
const keys = ok([key('openai'), key('wavespeed')]);
const page = (rows: unknown[]) => ({
  ...fixtureMeta,
  pagination: { type: 'cursor', limit: 10, returnedCount: rows.length, hasNextPage: false, nextCursor: null },
});
const camp = (n: number, over: Record<string, unknown> = {}) => ({
  id: id('c', n),
  productName: `Product ${n}`,
  productDescriptionExcerpt: 'Description',
  progress: 'processing',
  briefState: 'accepted',
  segmentCount: 3,
  finalAvailable: false,
  createdAt: '2026-11-15T12:00:00.000Z',
  updatedAt: '2026-11-16T11:48:00.000Z',
  ...over,
});
const ROWS = [
  camp(1, { productName: 'Morning Focus Blend' }),
  camp(2, { productName: 'Evening Calm Gummies', progress: 'completed', finalAvailable: true, segmentCount: 4 }),
  camp(3, { productName: 'Cordyceps Trail Mix, spring launch with the long working title the team keeps', progress: 'failed', segmentCount: 2 }),
  camp(4, { productName: 'Reishi Night Tincture', progress: 'in_progress', briefState: 'draft' }),
  camp(5, { productName: 'Daily Greens + Chaga', progress: 'completed', finalAvailable: true, segmentCount: 1 }),
];
const shell = (method: string, path: string) => {
  if (method === 'GET' && path === '/me') return linked;
  if (method === 'GET' && path === '/me/provider-keys') return keys;
};

const DRAFT = '8f3a0000-0000-4000-8000-00000000d001';
const draft = (over: Record<string, unknown> = {}) => ({
  id: DRAFT,
  version: 1,
  step: 4,
  adStyle: 'ugc',
  intakeMode: 'description',
  productName: 'Morning Focus Blend',
  productDescription: "Lion's Mane and Cordyceps capsules for a steady start to the day. 60 capsules, vegan, third-party tested.",
  audience: { ageMin: 35, ageMax: 52, gender: 'all', interests: ['morning routines', 'nootropics', 'trail running'] },
  direction: { goal: 'conversion', tone: 'Calm and grounded', segmentCount: 3 },
  concept: 'A calm morning routine: she takes the capsules with breakfast, then heads out for a trail run.',
  script: null,
  productMediaId: null,
  campaignId: null,
  durationSeconds: 45,
  createdAt: '2026-11-16T08:00:00.000Z',
  updatedAt: '2026-11-16T08:00:00.000Z',
  ...over,
});
const draftAnswer = (over: Record<string, unknown> = {}) => {
  const data = draft(over);
  return { status: 200, headers: { etag: `"${String(data.version)}"` }, body: { success: true, data, metaData: fixtureMeta } };
};

const stage: Script = (method, path) => {
  const base = shell(method, path);
  if (base) return base;
  if (method === 'GET' && /^\/media\/[0-9a-f-]{36}\/url$/.test(path)) return ok({ url: 'about:blank' });
  if (!path.startsWith('/campaigns/')) return;
  if (method === 'GET' && path === `/campaigns/${CAMPAIGN_ID}`) return ok(campaignFixture());
  if (method === 'GET' && path === `/campaigns/${CAMPAIGN_ID}/brief`) return ok(briefFixture());
  if (method === 'GET' && path === `/campaigns/${CAMPAIGN_ID}/video-jobs`) return ok(mixedList());
};

export const GROUPS: Group[] = [
  { id: 'auth-sign-in', screens: ['SCREEN-001'], path: '/sign-in', session: false, ready: 'Email address', script: () => undefined },
  { id: 'auth-mfa', screens: ['SCREEN-003'], path: '/mfa?step=enrol', session: true, ready: 'Set up two-step verification', script: () => undefined },
  {
    id: 'access',
    screens: ['SCREEN-002'],
    path: '/access',
    session: true,
    ready: 'This account has no access yet',
    script: (method, path) => {
      if (method === 'GET' && path === '/me') return ok({ linkState: 'not_linked', accessRequest: { formEnabled: true, state: 'none' } });
    },
  },
  { id: 'not-found', screens: ['SCREEN-004'], path: '/no/such/page', session: true, ready: 'Page not found', script: () => undefined },
  {
    id: 'campaigns',
    screens: ['SCREEN-005'],
    path: '/campaigns',
    session: true,
    ready: 'Morning Focus Blend',
    script: (method, path) => {
      const base = shell(method, path);
      if (base) return base;
      if (method === 'GET' && path === '/campaigns') return { status: 200, body: { success: true, data: ROWS, metaData: page(ROWS) } };
      if (method === 'GET' && path === '/drafts') return { status: 200, body: { success: true, data: [], metaData: page([]) } };
    },
    dialog: { trigger: 'Delete Cordyceps Trail Mix, spring launch with the long working title the team keeps', dialog: 'dialog' },
  },
  {
    id: 'wizard',
    screens: ['SCREEN-006'],
    path: `/campaigns/new?draft=${DRAFT}`,
    session: true,
    ready: 'Concept and script',
    script: (method, path) => {
      const base = shell(method, path);
      if (base) return base;
      if (method === 'GET' && path === `/drafts/${DRAFT}`) return draftAnswer();
      if (method === 'PATCH' && path === `/drafts/${DRAFT}`) return draftAnswer({ version: 2 });
    },
  },
  {
    id: 'brief',
    screens: ['SCREEN-007'],
    path: `/campaigns/${CAMPAIGN_ID}/brief`,
    session: true,
    ready: 'Script line for segment 1.',
    script: stage,
  },
  { id: 'clips', screens: ['SCREEN-008'], path: `/campaigns/${CAMPAIGN_ID}/clips`, session: true, ready: 'Script line for segment 1.', script: stage },
  {
    id: 'final',
    screens: ['SCREEN-009'],
    path: `/campaigns/${FINAL_CAMPAIGN}/final`,
    session: true,
    ready: 'Choose and order clips',
    script: (method, path) => {
      const base = shell(method, path);
      if (base) return base;
      if (method === 'GET' && path === `/campaigns/${FINAL_CAMPAIGN}`) return ok(finalCampaign());
      if (method === 'GET' && path === `/campaigns/${FINAL_CAMPAIGN}/video-jobs`) return ok(passedList());
      if (method === 'GET' && path === `/campaigns/${FINAL_CAMPAIGN}/brief`) return ok(briefFixture());
    },
  },
  {
    id: 'provider-keys',
    screens: ['SCREEN-010'],
    path: '/settings/provider-keys',
    session: true,
    ready: '7Q2d',
    script: (method, path) => {
      const base = shell(method, path);
      if (base) return base;
      if (method === 'GET' && path === '/me/key-events') return { status: 200, body: { success: true, data: [], metaData: page([]) } };
    },
  },
  {
    id: 'admin-settings',
    screens: ['SCREEN-013', 'SCREEN-011', 'SCREEN-012', 'SCREEN-014', 'SCREEN-015'],
    path: '/admin/settings',
    session: true,
    ready: 'Sign-up mode',
    script: (method, path) => {
      if (method === 'GET' && path === '/admin/settings') {
        return ok({
          signupMode: 'invited_only',
          accessRequestFormEnabled: false,
          mfaRequiredFor: 'all',
          inviteEmailDomains: [],
          openModePrerequisites: { emailVerificationRequired: false, signupRateLimitEnabled: false, abuseLimitsEnabled: false, verificationRecordId: null },
        });
      }
    },
  },
];
