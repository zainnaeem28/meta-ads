import type { AdminUser, DeletionRun } from '@shroomap/contracts';

/** Contract-shaped fixtures (OpenAPI AdminUser, DeletionRun) for the component tests and the e2e script. */
const DAY = 86_400_000;
const at = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

export const ME_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const accountFixtures = (): AdminUser[] => [
  {
    id: ME_ID,
    email: 'dana.whitfield@shroomap.example',
    role: 'admin',
    status: 'active',
    version: 1,
    createdAt: at(-120),
    updatedAt: at(-1),
    erasure: null,
  },
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    email: 'marcus.oyelaran@shroomap.example',
    role: 'user',
    status: 'active',
    version: 3,
    createdAt: at(-90),
    updatedAt: at(-2),
    erasure: null,
  },
  {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    email: 'priya.raman@shroomap.example',
    role: 'user',
    status: 'active',
    version: 2,
    createdAt: at(-30),
    updatedAt: at(-1),
    erasure: null,
  },
  {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    email: 'tom.lindqvist@shroomap.example',
    role: 'user',
    status: 'suspended',
    version: 4,
    createdAt: at(-9),
    updatedAt: at(-3),
    erasure: null,
  },
  {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    email: 'amelia.novak@shroomap.example',
    role: 'user',
    status: 'removed',
    version: 5,
    createdAt: at(-60),
    updatedAt: at(-1),
    erasure: { deletionRunId: '99999999-9999-4999-8999-999999999999', step: 3, state: 'running' },
  },
];

export const erasureFixtures = (): DeletionRun[] => [
  {
    id: '99999999-9999-4999-8999-999999999999',
    kind: 'account',
    subjectId: '8f3a1111-1111-4111-8111-11111111c21d',
    step: 3,
    state: 'running',
    attempts: 1,
    remainingObjects: 42,
    updatedAt: at(-0.1),
  },
  {
    id: '88888888-8888-4888-8888-888888888888',
    kind: 'account',
    subjectId: '41b92222-2222-4222-8222-2222222207ae',
    step: 5,
    state: 'completed',
    attempts: 1,
    remainingObjects: 0,
    updatedAt: at(-2),
  },
  {
    id: '77777777-7777-4777-8777-777777777777',
    kind: 'account',
    subjectId: 'c07e3333-3333-4333-8333-333333339b30',
    step: 3,
    state: 'stuck',
    attempts: 4,
    remainingObjects: 7,
    updatedAt: at(-3),
  },
];

export const meta = { requestId: 'req-fixture', timestamp: new Date().toISOString() };
export const metaPage = (count: number, next: string | null = null) => ({
  ...meta,
  pagination: {
    type: 'cursor',
    limit: 50,
    returnedCount: count,
    hasNextPage: next !== null,
    nextCursor: next,
  },
});

/** API-002 `/me`: the signed-in administrator. */
export const meFixture = () => ({
  linkState: 'linked',
  id: ME_ID,
  role: 'admin',
  status: 'active',
  mfa: { required: true, satisfied: true },
  recentAuth: { satisfied: true, maxAgeSeconds: 900 },
  keyNotices: [],
});
