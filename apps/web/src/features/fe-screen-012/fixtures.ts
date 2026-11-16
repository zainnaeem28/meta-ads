import type { AccessRequest, Invitation } from '@shroomap/contracts';

/** Contract-shaped fixtures (OpenAPI Invitation, AccessRequest, Settings) for the component tests and the e2e script. */
const DAY = 86_400_000;
const at = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

export const invitationFixtures = (): Invitation[] => [
  {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'sam.okafor@shroomap.example',
    state: 'invited',
    sendState: 'sent',
    expiresAt: at(6.5),
    invitedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    createdAt: at(-0.5),
    updatedAt: at(-0.5),
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'lena.brandt@shroomap.example',
    state: 'expired',
    sendState: 'sent',
    expiresAt: at(-9.5),
    invitedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    createdAt: at(-16),
    updatedAt: at(-9.5),
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    email: 'omar.haddad@shroomap.example',
    state: 'invited',
    sendState: 'send_failed',
    expiresAt: at(5.5),
    invitedBy: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    createdAt: at(-1.5),
    updatedAt: at(-1.5),
  },
];

export const requestFixtures = (): AccessRequest[] => [
  {
    id: '44444444-4444-4444-8444-444444444444',
    email: 'nina.castellano@shroomap.example',
    state: 'pending',
    note: 'Social team, spring launch',
    createdAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
  },
  {
    id: '55555555-5555-4555-8555-555555555555',
    email: 'j.mbeki@shroomap.example',
    state: 'pending',
    note: null,
    createdAt: at(-1),
    decidedAt: null,
    decidedBy: null,
  },
];

export const settingsFixture = (over: { signupMode?: 'invited_only' | 'open'; accessRequestFormEnabled?: boolean } = {}) => ({
  signupMode: 'invited_only',
  accessRequestFormEnabled: true,
  mfaRequiredFor: 'all',
  inviteEmailDomains: ['shroomap.example'],
  openModePrerequisites: {
    emailVerificationRequired: true,
    signupRateLimitEnabled: true,
    abuseLimitsEnabled: true,
    verificationRecordId: null,
  },
  ...over,
});

export const metaPage = (count: number) => ({
  requestId: 'req-fixture',
  timestamp: new Date().toISOString(),
  pagination: { type: 'cursor', limit: 50, returnedCount: count, hasNextPage: false, nextCursor: null },
});
export const meta = { requestId: 'req-fixture', timestamp: new Date().toISOString() };
