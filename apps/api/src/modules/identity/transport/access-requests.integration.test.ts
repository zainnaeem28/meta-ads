/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles; prettier reflow detached the per-line directives (AIU-256) */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiApp } from '../../../bootstrap/api.module.js';
import { installJobs } from '../../../platform/jobs/test-support.js';
import { createHttpLogging } from '../../../platform/logging/index.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../../platform/db/test-database.js';
import type { TestDatabase } from '../../../platform/db/test-database.js';
import { IDENTITY_PORT } from '../index.js';
import type { IdentityPort, LocalIdentity } from '../index.js';

// TASK-037 through the real api composition root (`createApiApp`, the one `main.api.ts` runs) on real PostgreSQL, with
// `fastify.inject`: API-002, API-115..117, API-120, API-121. TC-ACC-01..09.

const ORIGIN = 'http://localhost:3000';
const OWNER = 'owner@example.test';
const BASE_CONFIG = {
  WEB_ORIGIN: ORIGIN,
  APP_ENV: 'development',
  DATABASE_POOL_MAX: 8,
  DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
  RATE_LIMIT_IP_KEY: 'r'.repeat(40),
} as const;

type Api = Awaited<ReturnType<typeof createApiApp>>['app'];
let testDb: TestDatabase;
let app: Api;
let open: Api | undefined;
let local: LocalIdentity;
let pool: pg.Pool;
let seq = 0;

async function applyBeforeGrants(file: string, only?: RegExp): Promise<void> {
  const sql = readFileSync(join(REAL_MIGRATIONS, file), 'utf8').split('-- Grants')[0] ?? '';
  for (const statement of sql.split('--> statement-breakpoint')) {
    const text = statement.trim();
    if (text !== '' && (only === undefined || only.test(text))) await pool.query(text);
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase({ label: 'task037', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 4 });
  await applyBeforeGrants(
    '0001_task-025-platform.sql',
    /^(CREATE TABLE|CREATE INDEX) "(idempotency_records|rate_limit_buckets|idempotency_records_expiry_idx)/,
  );
  await applyBeforeGrants('0010_task-032-audit.sql');
  await applyBeforeGrants('0020_task-033-identity.sql');
  await installJobs(testDb.url);
  Object.assign(process.env, {
    OWNER_EMAIL: OWNER,
    INVITE_EMAIL_DOMAINS: 'example.test',
    CURSOR_SIGNING_KEY: 'c'.repeat(40),
    ACCESS_REQUEST_FORM_ENABLED: 'true',
    SIGNUP_OPEN_EMAIL_VERIFICATION: 'true',
    SIGNUP_OPEN_RATE_LIMIT: 'true',
    SIGNUP_OPEN_ABUSE_LIMITS: 'false',
    MFA_REQUIRED_FOR: 'all',
    RATE_LIMIT_IP_KEY: BASE_CONFIG.RATE_LIMIT_IP_KEY,
  });
  ({ app } = await createApiApp(
    { ...BASE_CONFIG, DATABASE_URL: testDb.url },
    createHttpLogging({ level: 'silent' }),
  ));
  local = app.get<IdentityPort>(IDENTITY_PORT, { strict: false }) as LocalIdentity;
});

beforeEach(async () => {
  await pool.query('delete from rate_limit_buckets');
});

afterAll(async () => {
  for (const key of [
    'OWNER_EMAIL',
    'INVITE_EMAIL_DOMAINS',
    'CURSOR_SIGNING_KEY',
    'ACCESS_REQUEST_FORM_ENABLED',
    'SIGNUP_OPEN_EMAIL_VERIFICATION',
    'SIGNUP_OPEN_RATE_LIMIT',
    'SIGNUP_OPEN_ABUSE_LIMITS',
    'MFA_REQUIRED_FOR',
    'RATE_LIMIT_IP_KEY',
  ]) {
    delete process.env[key];
  }
  await open?.close();
  await app?.close();
  await pool?.end();
  await testDb?.drop();
});

type Body = {
  success: boolean;
  data?: any;
  error?: { code: string; details?: any[] };
  metaData?: any;
};
async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  token?: string,
  payload?: unknown,
  target: Api = app,
  ip = '10.0.0.1',
) {
  const res = await target
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        'x-forwarded-for': ip,
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  return { status: res.statusCode, body: res.json() as Body };
}
const code = (r: { body: Body }) => r.body.error?.code;
function person(email: string | null, verified = true): { sub: string; email: string | null } {
  const sub = `user_t37_${String(++seq)}`;
  local.addUser(sub, email, verified);
  return { sub, email };
}
const token = (sub: string) => local.issueToken({ sub, azp: ORIGIN, fva: [1, 1] });
const count = async (sql: string, params: unknown[] = []) =>
  Number(((await pool.query(sql, params)).rows[0] as { n: string }).n);

let adminToken: string;
let adminId: string;
let memberToken: string;

describe('setup', () => {
  it('links the owner as admin and creates a plain member', async () => {
    const owner = person(OWNER);
    adminToken = token(owner.sub);
    expect((await call('GET', '/me', adminToken)).body.data).toMatchObject({
      linkState: 'linked',
      role: 'admin',
    });
    adminId = (await pool.query('select id from users where idp_subject = $1', [owner.sub])).rows[0]
      .id as string;
    const member = (
      await pool.query(
        `insert into users (id, idp_subject, email, linked_via) values (gen_random_uuid(), 'user_t37_member', 'member@example.test', 'invitation') returning id`,
      )
    ).rows[0].id as string;
    expect(member).toBeTruthy();
    local.addUser('user_t37_member', 'member@example.test', true);
    memberToken = token('user_t37_member');
  });
});

describe('API-002: request access (TC-ACC-01..04)', () => {
  it('creates one pending request for an unknown address; a repeat is neutral and creates nothing more', async () => {
    const p = person('Newcomer@Example.test');
    const t = token(p.sub);
    expect((await call('GET', '/me', t)).body.data).toMatchObject({
      linkState: 'not_linked',
      accessRequest: { formEnabled: true, state: 'none' },
    });
    const first = await call('POST', '/access-requests', t, { note: 'please let me in' });
    expect(first.status).toBe(202);
    expect(first.body.data).toEqual({ state: 'received' });
    const again = await call('POST', '/access-requests', t);
    expect([again.status, again.body.data]).toEqual([202, { state: 'received' }]);
    expect(
      await count(`select count(*) n from access_requests where idp_subject = $1`, [p.sub]),
    ).toBe(1);
    expect(
      (
        await pool.query('select email, state, note from access_requests where idp_subject = $1', [
          p.sub,
        ])
      ).rows[0],
    ).toEqual({
      email: 'newcomer@example.test',
      state: 'pending',
      note: 'please let me in',
    });
    expect(await count(`select count(*) n from users where idp_subject = $1`, [p.sub])).toBe(0);
    expect(
      await count(`select count(*) n from audit_events where action = 'access_request.created'`),
    ).toBe(1);
    expect((await call('GET', '/me', t)).body.data.accessRequest.state).toBe('pending');
  });

  it('answers the same whether the address already has an account, is unverified, or the subject is unknown', async () => {
    const dup = person('member@example.test');
    const known = await call('POST', '/access-requests', token(dup.sub));
    const unverified = await call(
      'POST',
      '/access-requests',
      token(person('unverified@example.test', false).sub),
    );
    const noEmail = await call('POST', '/access-requests', token(person(null).sub));
    for (const r of [known, unverified, noEmail])
      expect([r.status, r.body.data]).toEqual([202, { state: 'received' }]);
    expect(
      await count(
        `select count(*) n from access_requests where lower(email) in ('unverified@example.test')`,
      ),
    ).toBe(0);
    expect(
      await count(`select count(*) n from access_requests where idp_subject = $1`, [dup.sub]),
    ).toBe(0);
    // A linked member gets the same answer and no row either.
    const linked = await call('POST', '/access-requests', memberToken);
    expect([linked.status, linked.body.data]).toEqual([202, { state: 'received' }]);
  });

  it('validates the body and requires a verified token', async () => {
    expect((await call('POST', '/access-requests')).status).toBe(401);
    const t = token(person('v@example.test').sub);
    expect(code(await call('POST', '/access-requests', t, { note: 'x'.repeat(501) }))).toBe(
      'validation_failed',
    );
    expect(code(await call('POST', '/access-requests', t, { extra: 1 }))).toBe('validation_failed');
  });

  it('limits 3 per hour per subject and 20 per hour per client IP (TC-ACC-03)', async () => {
    const t = token(person('limited@example.test').sub);
    for (let i = 0; i < 3; i += 1)
      expect((await call('POST', '/access-requests', t, undefined, app, '10.1.1.1')).status).toBe(
        202,
      );
    const fourth = await call('POST', '/access-requests', t, undefined, app, '10.1.1.1');
    expect([fourth.status, code(fourth)]).toEqual([429, 'rate_limited']);

    await pool.query('delete from rate_limit_buckets');
    let blocked = 0;
    for (let i = 0; i < 22; i += 1) {
      const r = await call(
        'POST',
        '/access-requests',
        token(person(`ip${String(i)}@example.test`).sub),
        undefined,
        app,
        '10.2.2.2',
      );
      if (r.status === 429) blocked += 1;
    }
    expect(blocked).toBe(2);
  });
});

describe('API-115..117: list, approve, decline (TC-ACC-05..07)', () => {
  let pendingId: string;
  let applicant: { sub: string; email: string | null };

  it('refuses members and anonymous callers on every admin route', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    for (const [method, url] of [
      ['GET', '/admin/access-requests'],
      ['POST', `/admin/access-requests/${id}/approve`],
      ['POST', `/admin/access-requests/${id}/decline`],
      ['GET', '/admin/settings'],
      ['PUT', '/admin/settings/signup-mode'],
    ] as const) {
      expect((await call(method, url)).status).toBe(401);
      const r = await call(
        method,
        url,
        memberToken,
        method === 'PUT' ? { mode: 'invited_only' } : undefined,
      );
      expect([url, r.status, code(r)]).toEqual([url, 403, 'forbidden_role']);
    }
  });

  it('lists pending requests newest first with keyset paging, and validates the query', async () => {
    applicant = person('applicant@example.test');
    await call('POST', '/access-requests', token(applicant.sub), { note: 'hello' });
    await call('POST', '/access-requests', token(person('second@example.test').sub));
    await call('POST', '/access-requests', token(person('third@example.test').sub));
    const page1 = await call('GET', '/admin/access-requests?limit=2', adminToken);
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.data[0]).toEqual({
      id: expect.any(String),
      email: 'third@example.test',
      state: 'pending',
      note: null,
      createdAt: expect.any(String),
      decidedAt: null,
      decidedBy: null,
      userId: null,
    });
    const cursor = page1.body.metaData.pagination.nextCursor as string;
    expect(cursor).toBeTruthy();
    const page2 = await call(
      'GET',
      `/admin/access-requests?limit=2&cursor=${encodeURIComponent(cursor)}`,
      adminToken,
    );
    expect(page2.body.data.map((r: { email: string }) => r.email)).toContain(
      'applicant@example.test',
    );
    const all = [...page1.body.data, ...page2.body.data];
    expect(new Set(all.map((r: { id: string }) => r.id)).size).toBe(all.length);
    pendingId = all.find((r: { email: string }) => r.email === 'applicant@example.test')
      .id as string;
    expect(code(await call('GET', '/admin/access-requests?state=bogus', adminToken))).toBe(
      'validation_failed',
    );
    expect(code(await call('GET', '/admin/access-requests?limit=0', adminToken))).toBe(
      'validation_failed',
    );
    expect(code(await call('GET', '/admin/access-requests?cursor=garbage', adminToken))).toBe(
      'validation_failed',
    );
    expect(
      code(
        await call(
          'GET',
          `/admin/access-requests?state=declined&cursor=${encodeURIComponent(cursor)}`,
          adminToken,
        ),
      ),
    ).toBe('validation_failed');
  });

  it('approves: a users row with role user is created, sign-in links it, approving again changes nothing', async () => {
    expect(code(await call('POST', '/admin/access-requests/not-a-uuid/approve', adminToken))).toBe(
      'validation_failed',
    );
    expect(
      code(
        await call(
          'POST',
          '/admin/access-requests/00000000-0000-4000-8000-0000000000aa/approve',
          adminToken,
        ),
      ),
    ).toBe('not_found');
    const r = await call('POST', `/admin/access-requests/${pendingId}/approve`, adminToken);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      id: pendingId,
      state: 'approved',
      decidedBy: adminId,
      userId: expect.any(String),
    });
    const user = (await pool.query('select * from users where idp_subject = $1', [applicant.sub]))
      .rows[0];
    expect(user).toMatchObject({
      role: 'user',
      status: 'active',
      linked_via: 'access_request',
      email: 'applicant@example.test',
    });
    expect(r.body.data.userId).toBe(user.id);
    expect((await call('GET', '/me', token(applicant.sub))).body.data).toMatchObject({
      linkState: 'linked',
      role: 'user',
    });
    const again = await call('POST', `/admin/access-requests/${pendingId}/approve`, adminToken);
    expect([again.status, again.body.data]).toEqual([200, r.body.data]);
    expect(
      await count(`select count(*) n from users where idp_subject = $1`, [applicant.sub]),
    ).toBe(1);
    expect(
      await count(`select count(*) n from audit_events where action = 'access_request.approved'`),
    ).toBe(1);
    expect(
      code(await call('POST', `/admin/access-requests/${pendingId}/decline`, adminToken)),
    ).toBe('state_conflict');
  });

  it('declines: no account, repeat is unchanged, approve is a state conflict, /me shows declined', async () => {
    const p = person('decline-me@example.test');
    await call('POST', '/access-requests', token(p.sub));
    const id = (await pool.query('select id from access_requests where idp_subject = $1', [p.sub]))
      .rows[0].id as string;
    const r = await call('POST', `/admin/access-requests/${id}/decline`, adminToken);
    expect(r.body.data).toMatchObject({ state: 'declined', decidedBy: adminId, userId: null });
    expect(
      (await call('POST', `/admin/access-requests/${id}/decline`, adminToken)).body.data,
    ).toEqual(r.body.data);
    expect(code(await call('POST', `/admin/access-requests/${id}/approve`, adminToken))).toBe(
      'state_conflict',
    );
    expect(await count(`select count(*) n from users where idp_subject = $1`, [p.sub])).toBe(0);
    expect((await call('GET', '/me', token(p.sub))).body.data.accessRequest.state).toBe('declined');
    expect(
      await count(`select count(*) n from audit_events where action = 'access_request.declined'`),
    ).toBe(1);
    const declined = await call('GET', '/admin/access-requests?state=declined', adminToken);
    expect(declined.body.data.map((x: { id: string }) => x.id)).toEqual([id]);
  });

  it('refuses an approve outside INVITE_EMAIL_DOMAINS with 422 and keeps the request pending', async () => {
    const p = person('someone@elsewhere.test');
    await call('POST', '/access-requests', token(p.sub));
    const id = (await pool.query('select id from access_requests where idp_subject = $1', [p.sub]))
      .rows[0].id as string;
    const r = await call('POST', `/admin/access-requests/${id}/approve`, adminToken);
    expect([r.status, code(r)]).toEqual([422, 'invite_domain_not_allowed']);
    expect(
      (await pool.query('select state from access_requests where id = $1', [id])).rows[0].state,
    ).toBe('pending');
    expect(await count(`select count(*) n from users where idp_subject = $1`, [p.sub])).toBe(0);
  });

  it('refuses an approve when another subject already holds the address', async () => {
    const p = person('clash@example.test');
    await call('POST', '/access-requests', token(p.sub));
    await pool.query(
      `insert into users (id, idp_subject, email, linked_via) values (gen_random_uuid(), 'user_other', 'clash@example.test', 'invitation')`,
    );
    const id = (await pool.query('select id from access_requests where idp_subject = $1', [p.sub]))
      .rows[0].id as string;
    expect(code(await call('POST', `/admin/access-requests/${id}/approve`, adminToken))).toBe(
      'state_conflict',
    );
  });

  it('two concurrent approves end with one account and one approval event', async () => {
    const p = person('race@example.test');
    await call('POST', '/access-requests', token(p.sub));
    const id = (await pool.query('select id from access_requests where idp_subject = $1', [p.sub]))
      .rows[0].id as string;
    const results = await Promise.all([
      call('POST', `/admin/access-requests/${id}/approve`, adminToken),
      call('POST', `/admin/access-requests/${id}/approve`, adminToken),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await count(`select count(*) n from users where idp_subject = $1`, [p.sub])).toBe(1);
    expect(
      await count(
        `select count(*) n from audit_events where action = 'access_request.approved' and object_id = $1`,
        [id],
      ),
    ).toBe(1);
  });
});

describe('API-120, API-121: settings and signup mode (TC-ACC-08, 09)', () => {
  it('shows the signup mode and the read-only configuration', async () => {
    const r = await call('GET', '/admin/settings', adminToken);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      signupMode: 'invited_only',
      accessRequestFormEnabled: true,
      mfaRequiredFor: 'all',
      inviteEmailDomains: ['example.test'],
      openModePrerequisites: {
        emailVerificationRequired: true,
        signupRateLimitEnabled: true,
        abuseLimitsEnabled: false,
        verificationRecordId: null,
      },
    });
  });

  it('refuses the flip to open naming the missing prerequisites; the mode and accounts stay as they are', async () => {
    const before = await count('select count(*) n from users');
    const r = await call('PUT', '/admin/settings/signup-mode', adminToken, { mode: 'open' });
    expect([r.status, code(r)]).toEqual([422, 'signup_open_prerequisites']);
    expect(r.body.error?.details?.map((d: { field: string }) => d.field)).toEqual([
      'abuseLimitsEnabled',
      'verificationRecordId',
    ]);
    expect((await call('GET', '/admin/settings', adminToken)).body.data.signupMode).toBe(
      'invited_only',
    );
    expect(await count('select count(*) n from users')).toBe(before);
    expect(
      await count(`select count(*) n from audit_events where action = 'signup_mode.changed'`),
    ).toBe(0);
    for (const payload of [{}, { mode: 'closed' }, { mode: 'open', x: 1 }]) {
      expect(code(await call('PUT', '/admin/settings/signup-mode', adminToken, payload))).toBe(
        'validation_failed',
      );
    }
  });

  it('flips to open once the prerequisites hold, audited once; the same mode again is unchanged with no event', async () => {
    await pool.query(
      `update platform_settings set open_mode_verification_id = 'G4-2026-11-16' where id = 1`,
    );
    process.env['SIGNUP_OPEN_ABUSE_LIMITS'] = 'true';
    ({ app: open } = await createApiApp(
      { ...BASE_CONFIG, DATABASE_URL: testDb.url },
      createHttpLogging({ level: 'silent' }),
    ));
    // The second composition root has its own local identity provider: the same admin signs in there.
    const openIdentity = open.get<IdentityPort>(IDENTITY_PORT, { strict: false }) as LocalIdentity;
    const ownerSub = (await pool.query('select idp_subject from users where id = $1', [adminId]))
      .rows[0].idp_subject as string;
    openIdentity.addUser(ownerSub, OWNER, true);
    const openToken = openIdentity.issueToken({ sub: ownerSub, azp: ORIGIN, fva: [1, 1] });
    const before = await count('select count(*) n from users');
    const flip = await call(
      'PUT',
      '/admin/settings/signup-mode',
      openToken,
      { mode: 'open' },
      open,
    );
    expect(flip.status).toBe(200);
    expect(flip.body.data).toMatchObject({
      signupMode: 'open',
      openModePrerequisites: { abuseLimitsEnabled: true, verificationRecordId: 'G4-2026-11-16' },
    });
    expect(await count('select count(*) n from users')).toBe(before);
    expect(
      await count(`select count(*) n from audit_events where action = 'signup_mode.changed'`),
    ).toBe(1);
    const same = await call(
      'PUT',
      '/admin/settings/signup-mode',
      openToken,
      { mode: 'open' },
      open,
    );
    expect([same.status, same.body.data]).toEqual([200, flip.body.data]);
    expect(
      await count(`select count(*) n from audit_events where action = 'signup_mode.changed'`),
    ).toBe(1);
    const back = await call(
      'PUT',
      '/admin/settings/signup-mode',
      openToken,
      { mode: 'invited_only' },
      open,
    );
    expect(back.body.data.signupMode).toBe('invited_only');
    expect(
      await count(`select count(*) n from audit_events where action = 'signup_mode.changed'`),
    ).toBe(2);
  });
});
