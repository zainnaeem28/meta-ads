import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiApp } from '../../../bootstrap/api.module.js';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../../platform/db/test-database.js';
import type { TestDatabase } from '../../../platform/db/test-database.js';
import { installJobs } from '../../../platform/jobs/test-support.js';
import { createHttpLogging } from '../../../platform/logging/index.js';
import { AdminUsersService, IDENTITY_PORT, RevokeSessionsService } from '../index.js';
import type { IdentityPort, LocalIdentity } from '../index.js';

// TASK-035 on real PostgreSQL through the real api composition root (`createApiApp`, the one `main.api.ts` runs) with
// `fastify.inject`: API-100 and API-104, the admin invariant under its lock, the audit trail, the alert and the
// session-revoke job. TC-ACC-10, TC-ACC-19..24.

const ORIGIN = 'http://localhost:3000';
const KEY = 'c'.repeat(40);
const contractsDir = join(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'packages', 'contracts');

let testDb: TestDatabase;
let app: Awaited<ReturnType<typeof createApiApp>>['app'];
let local: LocalIdentity;
let pool: pg.Pool;
let seq = 0;

type Validate = ((value: unknown) => boolean) & { errors?: unknown };
function contractValidator(schema: string): Validate {
  const requireFromContracts = createRequire(join(contractsDir, 'package.json'));
  const Ajv2020 = (requireFromContracts('ajv/dist/2020') as { default: new (o: object) => any }).default; // eslint-disable-line @typescript-eslint/no-explicit-any
  const addFormats = (requireFromContracts('ajv-formats') as { default: (a: unknown) => void }).default;
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
  testDb = await createTestDatabase({ label: 'task035', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 3 });
  await applyBeforeGrants('0001_task-025-platform.sql', /^(CREATE TABLE|CREATE INDEX) "(idempotency_records|rate_limit_buckets|idempotency_records_expiry_idx)/);
  await applyBeforeGrants('0010_task-032-audit.sql');
  await applyBeforeGrants('0020_task-033-identity.sql');
  await installJobs(testDb.url);
  process.env['CURSOR_SIGNING_KEY'] = KEY;
  ({ app } = await createApiApp(
    {
      WEB_ORIGIN: ORIGIN,
      APP_ENV: 'development',
      DATABASE_URL: testDb.url,
      DATABASE_POOL_MAX: 8,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      RATE_LIMIT_IP_KEY: 'r'.repeat(40),
    },
    createHttpLogging({ level: 'silent' }),
  ));
  local = app.get<IdentityPort>(IDENTITY_PORT, { strict: false }) as LocalIdentity;
});

afterAll(async () => {
  delete process.env['CURSOR_SIGNING_KEY'];
  await app?.close();
  await pool?.end();
  await testDb?.drop();
});

beforeEach(async () => {
  await pool.query('delete from admin_alerts');
  await pool.query(`delete from pgboss.job where name = 'identity.revoke-sessions'`);
});

interface Person {
  id: string;
  sub: string;
  email: string;
}
type Body = { success: boolean; data?: any; error?: { code: string; details?: unknown[] }; metaData: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const fastify = () => app.getHttpAdapter().getInstance();
const token = (p: Person, fva: [number, number] | null = [1, 1]) =>
  local.issueToken({ sub: p.sub, azp: ORIGIN, ...(fva === null ? {} : { fva }) });
async function call(method: 'GET' | 'PUT', url: string, as: Person, init: { body?: unknown; ifMatch?: string; fva?: [number, number] | null } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token(as, init.fva)}` };
  if (init.ifMatch !== undefined) headers['if-match'] = init.ifMatch;
  const res = await fastify().inject({
    method,
    url: `/api/v1${url}`,
    headers,
    ...(init.body === undefined ? {} : { payload: init.body as object }),
  });
  return { status: res.statusCode, headers: res.headers, body: res.json() as Body };
}
async function account(role: 'user' | 'admin', status = 'active', createdAt?: string): Promise<Person> {
  const n = ++seq;
  const sub = `user_t35_${String(n)}`;
  const email = `t35-${String(n)}@example.test`;
  local.addUser(sub, email, true);
  const rows = await pool.query<{ id: string }>(
    `insert into users (id, idp_subject, email, role, status, linked_via, created_at)
     values (gen_random_uuid(), $1, $2, $3, $4, 'invitation', coalesce($5::timestamptz, now())) returning id`,
    [sub, email, role, status, createdAt ?? null],
  );
  return { id: rows.rows[0]?.id ?? '', sub, email };
}
const count = async (sql: string, params: unknown[] = []) => Number(((await pool.query(sql, params)).rows[0] as { n: string }).n);
const errorCode = (r: { body: Body }) => r.body.error?.code;
const setAdmins = async (keep: string[]) => {
  await pool.query(`update users set role = 'user' where role = 'admin' and id <> all($1::uuid[])`, [keep]);
  await pool.query(`update users set role = 'admin', status = 'active' where id = any($1::uuid[])`, [keep]);
};

describe('GET /admin/users (API-100)', () => {
  it('lists accounts with email, newest first, with a status filter and cursor paging that matches the contract', async () => {
    const admin = await account('admin');
    const stamps = ['2020-01-01T00:00:00.000001Z', '2020-01-01T00:00:00.000002Z', '2020-01-01T00:00:00.000002Z'];
    const made: Person[] = [];
    for (const s of stamps) made.push(await account('user', 'suspended', s));
    const first = await call('GET', '/admin/users?limit=2&status=suspended', admin);
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.data[0]).toMatchObject({ role: 'user', status: 'suspended', version: 1, erasure: null });
    expect(first.body.data[0].email).toMatch(/@example\.test$/);
    expect(first.body.metaData.pagination).toMatchObject({ type: 'cursor', limit: 2, hasNextPage: true });
    const second = await call('GET', `/admin/users?limit=2&status=suspended&cursor=${encodeURIComponent(first.body.metaData.pagination.nextCursor)}`, admin);
    const all = [...first.body.data, ...second.body.data].map((u: { id: string }) => u.id);
    expect(new Set(all).size).toBe(3);
    expect(second.body.metaData.pagination.hasNextPage).toBe(false);
    // Microsecond ties are broken by id, descending; the oldest stamp comes last.
    expect(all[2]).toBe(made[0]?.id);
    expect(contractValidator('AdminUserPage')({ success: true, data: first.body.data, metaData: first.body.metaData })).toBe(true);
    const other = await call('GET', `/admin/users?status=active&cursor=${encodeURIComponent(first.body.metaData.pagination.nextCursor)}`, admin);
    expect([other.status, errorCode(other)]).toEqual([400, 'validation_failed']);
    expect((await call('GET', '/admin/users?limit=51', admin)).status).toBe(400);
  });

  it('refuses a user (403 forbidden_role) and an admin without a second factor (403 mfa_required), writing an audit event each', async () => {
    const admin = await account('admin');
    const user = await account('user');
    const before = await count(`select count(*) n from audit_events where action = 'auth.denied' and outcome = 'denied'`);
    const r = await call('GET', '/admin/users', user);
    expect([r.status, errorCode(r)]).toEqual([403, 'forbidden_role']);
    const mfa = await call('GET', '/admin/users', admin, { fva: null });
    expect([mfa.status, errorCode(mfa)]).toEqual([403, 'mfa_required']);
    const put = await call('PUT', `/admin/users/${admin.id}/role`, user, { body: { role: 'user' }, ifMatch: '"1"' });
    expect([put.status, errorCode(put)]).toEqual([403, 'forbidden_role']);
    expect(await count(`select count(*) n from audit_events where action = 'auth.denied' and outcome = 'denied'`)).toBe(before + 3);
  });
});

describe('PUT /admin/users/{userId}/role (API-104)', () => {
  it('A removes B: B is demoted with audit, alert, ETag and a session-revoke job, and an admin remains (TC-ACC-19)', async () => {
    const a = await account('admin');
    const b = await account('admin');
    await setAdmins([a.id, b.id]);
    const r = await call('PUT', `/admin/users/${b.id}/role`, a, { body: { role: 'user' }, ifMatch: '"1"' });
    expect(r.status).toBe(200);
    expect(r.headers['etag']).toBe('"2"');
    expect(r.body.data).toMatchObject({ id: b.id, role: 'user', version: 2, email: b.email });
    expect(contractValidator('AdminUserResponse')(r.body)).toBe(true);
    expect(await count(`select count(*) n from users where role = 'admin' and status = 'active'`)).toBeGreaterThanOrEqual(1);
    expect(await count(`select count(*) n from audit_events where action = 'role.revoked' and actor_id = $1 and object_id = $2 and outcome = 'allowed'`, [a.id, b.id])).toBe(1);
    expect(await count(`select count(*) n from admin_alerts where kind = 'admin_role_changed' and subject_user_id = $1 and acknowledged_at is null`, [b.id])).toBe(1);
    const job = await pool.query(`select data from pgboss.job where name = 'identity.revoke-sessions'`);
    expect(job.rows).toEqual([{ data: { userId: b.id } }]);
    // The worker's handler ends the provider sessions of that account.
    await app.get(RevokeSessionsService, { strict: false }).handle(job.rows[0].data);
    expect(local.sessionRevocations).toContain(b.sub);
    // Grant again with the new version; a stale one is a 409 with no change.
    const stale = await call('PUT', `/admin/users/${b.id}/role`, a, { body: { role: 'admin' }, ifMatch: '"1"' });
    expect([stale.status, errorCode(stale)]).toEqual([409, 'version_conflict']);
    const granted = await call('PUT', `/admin/users/${b.id}/role`, a, { body: { role: 'admin' }, ifMatch: '"2"' });
    expect(granted.body.data).toMatchObject({ role: 'admin', version: 3 });
    expect(await count(`select count(*) n from audit_events where action = 'role.granted' and object_id = $1`, [b.id])).toBe(1);
  });

  it('answers 200 unchanged with no event for the role the account already has', async () => {
    const a = await account('admin');
    const u = await account('user');
    const events = await count(`select count(*) n from audit_events where action in ('role.granted', 'role.revoked')`);
    const r = await call('PUT', `/admin/users/${u.id}/role`, a, { body: { role: 'user' }, ifMatch: '"1"' });
    expect([r.status, r.body.data.version]).toEqual([200, 1]);
    expect(await count(`select count(*) n from audit_events where action in ('role.granted', 'role.revoked')`)).toBe(events);
    expect(await count(`select count(*) n from pgboss.job where name = 'identity.revoke-sessions'`)).toBe(0);
  });

  it('refuses a self action with 422 self_action and an audit event, and changes nothing (TC-ACC-20)', async () => {
    const a = await account('admin');
    await account('admin');
    const r = await call('PUT', `/admin/users/${a.id}/role`, a, { body: { role: 'user' }, ifMatch: '"1"' });
    expect([r.status, errorCode(r)]).toEqual([422, 'self_action']);
    expect(await count(`select count(*) n from audit_events where action = 'admin_invariant.refused' and object_id = $1 and outcome = 'denied'`, [a.id])).toBe(1);
    expect(await count(`select count(*) n from users where id = $1 and role = 'admin' and version = 1`, [a.id])).toBe(1);
  });

  it('refuses the last admin with 422 last_admin (service path) and keeps one admin (TC-ACC-21)', async () => {
    const a = await account('admin');
    const b = await account('admin');
    await setAdmins([b.id]);
    const service = app.get(AdminUsersService, { strict: false });
    const database = app.get<Database>(DATABASE, { strict: false });
    for (const status of ['suspended', 'removed'] as const) {
      await expect(database.uow.run((tx) => service.setStatus(tx, { actorId: null, userId: b.id, status, expectedVersion: 1 }))).rejects.toMatchObject({ code: 'last_admin' });
    }
    const asA = await call('PUT', `/admin/users/${b.id}/role`, a, { body: { role: 'user' }, ifMatch: '"1"' });
    expect(asA.status).toBe(403); // a is now a plain user: role is read on every request
    expect(await count(`select count(*) n from users where role = 'admin' and status = 'active'`)).toBe(1);
    expect(await count(`select count(*) n from audit_events where action = 'admin_invariant.refused' and object_id = $1`, [b.id])).toBe(2);
    // Another admin makes removal possible: suspend works, version moves, the revoke job is queued.
    const c = await account('admin');
    await database.uow.run((tx) => service.setStatus(tx, { actorId: c.id, userId: b.id, status: 'suspended', expectedVersion: 1 }));
    expect(await count(`select count(*) n from users where id = $1 and status = 'suspended' and version = 2`, [b.id])).toBe(1);
  });

  it('keeps at least one admin when two admins demote each other at once (TC-ACC-22)', async () => {
    for (let round = 0; round < 6; round += 1) {
      const a = await account('admin');
      const b = await account('admin');
      await setAdmins([a.id, b.id]);
      const [x, y] = await Promise.all([
        call('PUT', `/admin/users/${b.id}/role`, a, { body: { role: 'user' }, ifMatch: '"1"' }),
        call('PUT', `/admin/users/${a.id}/role`, b, { body: { role: 'user' }, ifMatch: '"1"' }),
      ]);
      expect([x.status, y.status].filter((s) => s === 200)).toHaveLength(1);
      expect(await count(`select count(*) n from users where role = 'admin' and status = 'active'`)).toBe(1);
      await pool.query(`update users set version = 1`);
    }
  });

  it('validates the request and maps unknown and inactive accounts (400, 404, 409)', async () => {
    const a = await account('admin');
    const suspended = await account('user', 'suspended');
    const u = await account('user');
    const put = (id: string, body: unknown, ifMatch: string | undefined) => call('PUT', `/admin/users/${id}/role`, a, { body, ...(ifMatch === undefined ? {} : { ifMatch }) });
    const cases: [string, Awaited<ReturnType<typeof put>>, number, string][] = [
      ['no If-Match', await put(u.id, { role: 'admin' }, undefined), 400, 'validation_failed'],
      ['bad If-Match', await put(u.id, { role: 'admin' }, '1'), 400, 'validation_failed'],
      ['bad role', await put(u.id, { role: 'root' }, '"1"'), 400, 'validation_failed'],
      ['extra field', await put(u.id, { role: 'admin', x: 1 }, '"1"'), 400, 'validation_failed'],
      ['bad id', await put('not-a-uuid', { role: 'admin' }, '"1"'), 400, 'validation_failed'],
      ['unknown', await put('00000000-0000-4000-8000-000000000999', { role: 'admin' }, '"1"'), 404, 'not_found'],
      ['suspended', await put(suspended.id, { role: 'admin' }, '"1"'), 409, 'state_conflict'],
    ];
    for (const [name, r, status, code] of cases) expect([name, r.status, errorCode(r)]).toEqual([name, status, code]);
    expect(await count(`select count(*) n from users where id = $1 and role = 'user' and version = 1`, [u.id])).toBe(1);
  });
});
