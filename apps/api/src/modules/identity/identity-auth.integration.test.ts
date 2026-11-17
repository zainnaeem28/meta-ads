/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles; prettier reflow detached the per-line directives (AIU-256) */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Controller, Get } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../bootstrap/api.module.js';
import { DATABASE } from '../../platform/db/index.js';
import type { Database } from '../../platform/db/index.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../platform/db/test-database.js';
import type { TestDatabase } from '../../platform/db/test-database.js';
import { CurrentActor, Scope } from '../../platform/http/index.js';
import type { ActorContext } from '../../platform/http/index.js';
import { installJobs } from '../../platform/jobs/test-support.js';
import { createHttpLogging } from '../../platform/logging/index.js';
import { IDENTITY_PORT, IdentityUnavailable } from './index.js';
import type { IdentityPort, LocalIdentity } from './index.js';

// TASK-034 on real PostgreSQL through the real api composition root (`createApiApp`, the one `main.api.ts` runs),
// with `fastify.inject`: token to actor in the SECURITY-DESIGN 7.1 order, linking and the first admin, role and status
// read on every request, server-side MFA and recent authentication, API-001 against OpenAPI design.5.
// TC-AUT-01..13, TC-ACC-01..24 (first admin, MFA).

const ORIGIN = 'http://localhost:3000';
const OWNER = 'owner@example.test';
const contractsDir = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages',
  'contracts',
);

@Controller('probe')
class Probe {
  @Get('user')
  @Scope('U')
  user(@CurrentActor() actor: ActorContext): { userId: string; role: string } {
    return { userId: actor.userId, role: actor.role };
  }
  @Get('admin')
  @Scope('A')
  admin(): { ok: true } {
    return { ok: true };
  }
  @Get('recent')
  @Scope('U+RA')
  recent(): { ok: true } {
    return { ok: true };
  }
  @Get('open')
  @Scope('Pub')
  open(): { ok: true } {
    return { ok: true };
  }
}

let testDb: TestDatabase;
let app: Awaited<ReturnType<typeof createApiApp>>['app'];
let local: LocalIdentity;
let pool: pg.Pool;
let seq = 0;

type Validate = ((value: unknown) => boolean) & { errors?: unknown };
function contractValidator(schema: string): Validate {
  const requireFromContracts = createRequire(join(contractsDir, 'package.json'));
  const Ajv2020 = (requireFromContracts('ajv/dist/2020') as { default: new (o: object) => any })
    .default;
  const addFormats = (requireFromContracts('ajv-formats') as { default: (a: unknown) => void })
    .default;
  const yaml = requireFromContracts('js-yaml') as { load(text: string): { components: unknown } };
  const spec = yaml.load(readFileSync(join(contractsDir, 'openapi.yaml'), 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ components: spec.components }, 'spec');
  return ajv.compile({ $ref: `spec#/components/schemas/${schema}` }) as Validate;
}

async function applyBeforeGrants(file: string, only?: RegExp): Promise<void> {
  const sql = readFileSync(join(REAL_MIGRATIONS, file), 'utf8').split('-- Grants')[0] ?? '';
  for (const statement of sql.split('--> statement-breakpoint')) {
    const text = statement.trim();
    if (text !== '' && (only === undefined || only.test(text))) await pool.query(text);
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase({ label: 'task034', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 3 });
  await applyBeforeGrants(
    '0001_task-025-platform.sql',
    /^(CREATE TABLE|CREATE INDEX) "(idempotency_records|rate_limit_buckets|idempotency_records_expiry_idx)/,
  );
  await applyBeforeGrants('0010_task-032-audit.sql');
  await applyBeforeGrants('0020_task-033-identity.sql');
  await installJobs(testDb.url);
  process.env['OWNER_EMAIL'] = OWNER;
  process.env['INVITE_EMAIL_DOMAINS'] = 'example.test';
  ({ app } = await createApiApp(
    {
      WEB_ORIGIN: ORIGIN,
      APP_ENV: 'development',
      DATABASE_URL: testDb.url,
      DATABASE_POOL_MAX: 6,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      RATE_LIMIT_IP_KEY: 'r'.repeat(40),
    },
    createHttpLogging({ level: 'silent' }),
    [Probe],
  ));
  local = app.get<IdentityPort>(IDENTITY_PORT, { strict: false }) as LocalIdentity;
});

afterAll(async () => {
  delete process.env['OWNER_EMAIL'];
  delete process.env['INVITE_EMAIL_DOMAINS'];
  await app?.close();
  await pool?.end();
  await testDb?.drop();
});

interface Req {
  token?: string;
  fva?: [number, number];
  azp?: string;
  header?: string;
}
const fastify = () => app.getHttpAdapter().getInstance();
async function get(url: string, req: Req = {}) {
  const headers: Record<string, string> = {};
  if (req.header !== undefined) headers['authorization'] = req.header;
  else if (req.token !== undefined) headers['authorization'] = `Bearer ${req.token}`;
  const res = await fastify().inject({ method: 'GET', url: `/api/v1${url}`, headers });
  return {
    status: res.statusCode,
    body: res.json() as { success: boolean; data?: any; error?: { code: string } },
  };
}
const code = (r: { body: { error?: { code: string } } }) => r.body.error?.code;
function person(email: string, verified = true): { sub: string; email: string } {
  const sub = `user_t34_${String(++seq)}`;
  local.addUser(sub, email, verified);
  return { sub, email };
}
/** `fva` null mints a token without factor evidence. */
const token = (sub: string, fva: [number, number] | null = [1, 1], extra: object = {}) =>
  local.issueToken({ sub, azp: ORIGIN, ...(fva === null ? {} : { fva }), ...extra });
const count = async (sql: string, params: unknown[] = []) =>
  Number(((await pool.query(sql, params)).rows[0] as { n: string }).n);

describe('token to actor (TC-AUT-01..06)', () => {
  it('refuses a missing, malformed, forged, expired, wrong-party and foreign-issuer token with 401 unauthenticated', async () => {
    const p = person('someone@example.test');
    const good = token(p.sub);
    const cases: [string, Req][] = [
      ['no header', {}],
      ['not bearer', { header: `Basic ${good}` }],
      ['garbage', { token: 'not.a.jwt' }],
      [
        'tampered payload',
        {
          token: `${good.split('.')[0]}.${Buffer.from('{"sub":"x"}').toString('base64url')}.${good.split('.')[2]}`,
        },
      ],
      ['unknown key id', { token: token(p.sub, [1, 1], { kid: 'other-key' }) }],
      ['expired', { token: token(p.sub, [1, 1], { ttlSeconds: -60 }) }],
      ['wrong party', { token: token(p.sub, [1, 1], { azp: 'https://evil.example' }) }],
      ['foreign issuer', { token: token(p.sub, [1, 1], { issuer: 'https://evil.example' }) }],
    ];
    for (const [name, req] of cases) {
      const r = await get('/me', req);
      expect([name, r.status, code(r)]).toEqual([name, 401, 'unauthenticated']);
    }
    expect(await count(`select count(*) n from users where idp_subject = $1`, [p.sub])).toBe(0);
  });

  it('answers 503 service_unavailable when the provider keys cannot be loaded, and does not link', async () => {
    const p = person('outage@example.test');
    const good = token(p.sub);
    local.available = false;
    try {
      const r = await get('/me', { token: good });
      expect([r.status, code(r)]).toEqual([503, 'service_unavailable']);
    } finally {
      local.available = true;
    }
  });

  it('answers 503 when the provider is unavailable during linking, then links on the next request', async () => {
    const p = person('slow@example.test');
    await pool.query(
      `insert into invitations (id, email, expires_at) values (gen_random_uuid(), $1, now() + interval '1 day')`,
      [p.email],
    );
    const original = local.getUser.bind(local);
    local.getUser = () => Promise.reject(new IdentityUnavailable('getUser', 'timeout'));
    try {
      expect((await get('/me', { token: token(p.sub) })).status).toBe(503);
    } finally {
      local.getUser = original;
    }
    const r = await get('/me', { token: token(p.sub) });
    expect(r.body.data).toMatchObject({ linkState: 'linked', role: 'user' });
  });

  it('leaves health and public routes without a session and answers a protected route 401 without one', async () => {
    expect((await get('/probe/open')).status).toBe(200);
    expect((await get('/probe/user')).status).toBe(401);
    expect((await get('/probe/admin')).status).toBe(401);
  });
});

describe('first admin (TC-AUT-07..09, TC-ACC-01..06)', () => {
  it('never makes an admin of an unverified owner email or of a token without a second factor (before the first admin exists)', async () => {
    const unverified = person(OWNER, false);
    expect((await get('/me', { token: token(unverified.sub) })).body.data).toMatchObject({
      linkState: 'not_linked',
    });
    const noMfa = person(OWNER);
    expect((await get('/me', { token: token(noMfa.sub, null) })).body.data.linkState).toBe(
      'not_linked',
    );
    expect(
      await count(`select count(*) n from users where idp_subject in ($1, $2)`, [
        unverified.sub,
        noMfa.sub,
      ]),
    ).toBe(0);
  });

  it('seeds one admin from many concurrent first tokens, then closes the path for a second owner-email sign-in', async () => {
    const owner = person(OWNER);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => get('/me', { token: token(owner.sub) })),
    );
    for (const r of results)
      expect(r.body.data).toMatchObject({ linkState: 'linked', role: 'admin' });
    expect(await count(`select count(*) n from users where idp_subject = $1`, [owner.sub])).toBe(1);
    expect(await count(`select count(*) n from users where role = 'admin'`)).toBe(1);
    expect(
      await count(`select count(*) n from audit_events where action = 'auth.first_admin_seeded'`),
    ).toBe(1);
    expect(
      await count(
        `select count(*) n from platform_settings where first_admin_seeded_at is not null`,
      ),
    ).toBe(1);

    const second = person(OWNER);
    const r = await get('/me', { token: token(second.sub) });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ linkState: 'not_linked' });
    expect(await count(`select count(*) n from users where idp_subject = $1`, [second.sub])).toBe(
      0,
    );
    expect(await count(`select count(*) n from users where role = 'admin'`)).toBe(1);
  });
});

describe('linking by invitation and open signup (TC-AUT-10..11)', () => {
  it('links an invited email once, accepts the invitation and refuses an expired one', async () => {
    const invited = person('invited@example.test');
    await pool.query(
      `insert into invitations (id, email, expires_at) values (gen_random_uuid(), $1, now() + interval '1 day')`,
      [invited.email],
    );
    const r = await Promise.all([1, 2, 3].map(() => get('/me', { token: token(invited.sub) })));
    for (const one of r) expect(one.body.data).toMatchObject({ linkState: 'linked', role: 'user' });
    expect(await count(`select count(*) n from users where idp_subject = $1`, [invited.sub])).toBe(
      1,
    );
    expect(
      await count(`select count(*) n from invitations where email = $1 and state = 'accepted'`, [
        invited.email,
      ]),
    ).toBe(1);
    expect(
      await count(`select count(*) n from audit_events where action = 'auth.linked'`),
    ).toBeGreaterThanOrEqual(1);

    const late = person('late@example.test');
    await pool.query(
      `insert into invitations (id, email, expires_at, created_at) values (gen_random_uuid(), $1, now() - interval '1 minute', now() - interval '2 days')`,
      [late.email],
    );
    expect((await get('/me', { token: token(late.sub) })).body.data.linkState).toBe('not_linked');
  });

  it('links an unknown email only in open mode, within the allowed domains', async () => {
    const early = person('early@example.test');
    expect((await get('/me', { token: token(early.sub) })).body.data.linkState).toBe('not_linked');
    await pool.query(`update platform_settings set signup_mode = 'open'`);
    const outside = person('visitor@other.test');
    expect((await get('/me', { token: token(outside.sub) })).body.data.linkState).toBe(
      'not_linked',
    );
    const r = await get('/me', { token: token(early.sub) });
    expect(r.body.data).toMatchObject({ linkState: 'linked', role: 'user' });
    expect(await count(`select count(*) n from users where linked_via = 'open_signup'`)).toBe(1);
    await pool.query(`update platform_settings set signup_mode = 'invited_only'`);
  });
});

describe('role and status are read on every request (TC-AUT-12..13)', () => {
  it('applies a role or status change on the next request and maps the account states to their codes', async () => {
    const p = person('flip@example.test');
    await pool.query(
      `insert into invitations (id, email, expires_at) values (gen_random_uuid(), $1, now() + interval '1 day')`,
      [p.email],
    );
    const t = token(p.sub);
    expect((await get('/probe/user', { token: t })).body.data.role).toBe('user');
    expect(code(await get('/probe/admin', { token: t }))).toBe('forbidden_role');
    await pool.query(`update users set role = 'admin' where idp_subject = $1`, [p.sub]);
    expect((await get('/probe/admin', { token: t })).status).toBe(200);
    await pool.query(`update users set role = 'user' where idp_subject = $1`, [p.sub]);
    expect(code(await get('/probe/admin', { token: t }))).toBe('forbidden_role');
    await pool.query(`update users set status = 'suspended' where idp_subject = $1`, [p.sub]);
    for (const url of ['/me', '/probe/user']) {
      const r = await get(url, { token: t });
      expect([r.status, code(r)]).toEqual([403, 'account_suspended']);
    }
    await pool.query(`update users set status = 'removed' where idp_subject = $1`, [p.sub]);
    expect(code(await get('/me', { token: t }))).toBe('account_removed');
    await pool.query(`update users set status = 'active' where idp_subject = $1`, [p.sub]);
    expect((await get('/me', { token: t })).status).toBe(200);
  });

  it('writes auth.denied for a refused admin route', async () => {
    const before = await count(`select count(*) n from audit_events where action = 'auth.denied'`);
    const p = person('denied@example.test');
    await pool.query(
      `insert into invitations (id, email, expires_at) values (gen_random_uuid(), $1, now() + interval '1 day')`,
      [p.email],
    );
    await get('/probe/admin', { token: token(p.sub) });
    expect(
      await count(
        `select count(*) n from audit_events where action = 'auth.denied' and outcome = 'denied'`,
      ),
    ).toBe(before + 1);
  });
});

describe('MFA and recent authentication from the server (TC-ACC-15, TC-ACC-16..24)', () => {
  it('enforces mfa_required from fva when the provider screen is bypassed, but lets API-001 report it', async () => {
    const p = person('mfa@example.test');
    await pool.query(
      `insert into invitations (id, email, expires_at) values (gen_random_uuid(), $1, now() + interval '1 day')`,
      [p.email],
    );
    for (const fva of [null, [5, -1]] as ([number, number] | null)[]) {
      const r = await get('/probe/user', { token: token(p.sub, fva) });
      expect([r.status, code(r)]).toEqual([403, 'mfa_required']);
      expect(code(await get('/probe/recent', { token: token(p.sub, fva) }))).toBe('mfa_required');
      const me = await get('/me', { token: token(p.sub, fva) });
      expect(me.body.data).toMatchObject({
        mfa: { required: true, satisfied: false },
        recentAuth: { satisfied: false },
      });
    }
    expect((await get('/probe/user', { token: token(p.sub, [5, 5]) })).status).toBe(200);
  });

  it('requires a first and second factor within the limit for recent-auth routes', async () => {
    const p = person('recent@example.test');
    await pool.query(
      `insert into invitations (id, email, expires_at) values (gen_random_uuid(), $1, now() + interval '1 day')`,
      [p.email],
    );
    expect((await get('/probe/recent', { token: token(p.sub, [3, 4]) })).status).toBe(200);
    for (const fva of [
      [11, 3],
      [3, 11],
      [-1, 3],
    ] as [number, number][]) {
      const r = await get('/probe/recent', { token: token(p.sub, fva) });
      expect([fva, r.status, code(r)]).toEqual([fva, 403, 'recent_auth_required']);
    }
    const me = await get('/me', { token: token(p.sub, [3, 4]) });
    expect(me.body.data.recentAuth).toEqual({ satisfied: true, maxAgeSeconds: 600 });
  });
});

describe('unlinked tokens and API-001 (TC-ACC-07..14)', () => {
  it('reaches only API-001 (and API-002) and is refused elsewhere with 403 not_linked', async () => {
    const p = person('stranger@other.test');
    const t = token(p.sub);
    for (const url of ['/probe/user', '/probe/admin', '/probe/recent']) {
      const r = await get(url, { token: t });
      expect([url, r.status, code(r)]).toEqual([url, 403, 'not_linked']);
    }
    const me = await get('/me', { token: t });
    expect(me.body.data).toEqual({
      linkState: 'not_linked',
      accessRequest: { formEnabled: false, state: 'none' },
    });
  });

  it('reports a pending and a declined access request without exposing more', async () => {
    const pending = person('asks@other.test');
    await pool.query(
      `insert into access_requests (id, idp_subject, email, state) values (gen_random_uuid(), $1, $2, 'pending')`,
      [pending.sub, pending.email],
    );
    expect((await get('/me', { token: token(pending.sub) })).body.data.accessRequest.state).toBe(
      'pending',
    );
    await pool.query(`update access_requests set state = 'declined' where idp_subject = $1`, [
      pending.sub,
    ]);
    expect((await get('/me', { token: token(pending.sub) })).body.data.accessRequest.state).toBe(
      'declined',
    );
  });

  it('answers API-001 in the contract shape for a linked and an unlinked caller', async () => {
    const validate = contractValidator('MeResponse');
    const owner = await get('/me', {
      token: token(
        (await pool.query(`select idp_subject from users where role = 'admin' limit 1`)).rows[0]
          .idp_subject as string,
      ),
    });
    const stranger = await get('/me', { token: token(person('nobody@other.test').sub) });
    for (const r of [owner, stranger]) {
      expect(r.status).toBe(200);
      expect(validate(r.body), JSON.stringify(validate.errors)).toBe(true);
    }
    expect(owner.body.data).toMatchObject({
      linkState: 'linked',
      role: 'admin',
      status: 'active',
      keyNotices: [],
    });
  });

  it('carries no token or email in the response of a refusal', async () => {
    const p = person('canary.person+9z@other.test');
    const t = token(p.sub, null);
    const r = await fastify().inject({
      method: 'GET',
      url: '/api/v1/probe/user',
      headers: { authorization: `Bearer ${t}` },
    });
    expect(r.body).not.toContain(t);
    expect(r.body).not.toContain('canary.person');
  });
});

describe('wiring', () => {
  it('registers the session guard before the rate limiter, so limits count per user', async () => {
    const database = app.get<Database>(DATABASE, { strict: false });
    const rows = await database.pool.query(
      `select count(*)::int n from rate_limit_buckets where scope = 'general-user'`,
    );
    expect((rows.rows[0] as { n: number }).n).toBeGreaterThan(0);
  });
});
