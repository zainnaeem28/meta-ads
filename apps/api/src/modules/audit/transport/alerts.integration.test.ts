import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../../bootstrap/api.module.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../../platform/db/test-database.js';
import type { TestDatabase } from '../../../platform/db/test-database.js';
import { installJobs } from '../../../platform/jobs/test-support.js';
import { createHttpLogging } from '../../../platform/logging/index.js';
import { IDENTITY_PORT } from '../../identity/index.js';
import type { IdentityPort, LocalIdentity } from '../../identity/index.js';

// TASK-038 through the real api composition root (`createApiApp`, the one `main.api.ts` runs) with `fastify.inject`
// on real PostgreSQL: API-125 and API-126, admin only with recent authentication, audit on denial, first
// acknowledgement wins, order and pagination on (acknowledged_at nulls first, raised_at desc, id desc).
// TC-ALR-*, TC-AUD-*.

const ORIGIN = 'http://localhost:3000';
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
  testDb = await createTestDatabase({ label: 'task038', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 3 });
  await applyBeforeGrants('0001_task-025-platform.sql', /^(CREATE TABLE|CREATE INDEX) "(idempotency_records|rate_limit_buckets|idempotency_records_expiry_idx)/);
  await applyBeforeGrants('0010_task-032-audit.sql');
  await applyBeforeGrants('0020_task-033-identity.sql');
  await installJobs(testDb.url);
  process.env['OWNER_EMAIL'] = 'owner38@example.test';
  process.env['INVITE_EMAIL_DOMAINS'] = 'example.test';
  process.env['CURSOR_SIGNING_KEY'] = 'k'.repeat(40);
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
  ));
  local = app.get<IdentityPort>(IDENTITY_PORT, { strict: false }) as LocalIdentity;
});

afterAll(async () => {
  delete process.env['OWNER_EMAIL'];
  delete process.env['INVITE_EMAIL_DOMAINS'];
  delete process.env['CURSOR_SIGNING_KEY'];
  await app?.close();
  await pool?.end();
  await testDb?.drop();
});

const fastify = () => app.getHttpAdapter().getInstance();
interface Body { success: boolean; data?: any; error?: { code: string }; metaData: any } // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(method: 'GET' | 'POST', url: string, tok?: string) {
  const headers: Record<string, string> = {};
  if (tok !== undefined) headers['authorization'] = `Bearer ${tok}`;
  const res = await fastify().inject({ method, url: `/api/v1${url}`, headers });
  return { status: res.statusCode, body: res.json() as Body };
}

/** Links an account through an invitation; `admin` promotes it. Returns its user ID and a fresh token. */
async function account(admin: boolean, fva: [number, number] = [1, 1]) {
  const sub = `user_t38_${String(++seq)}`;
  const email = `p${String(seq)}@example.test`;
  local.addUser(sub, email, true);
  await pool.query(
    `insert into invitations (id, email, expires_at) values (gen_random_uuid(), $1, now() + interval '1 day')`,
    [email],
  );
  const tok = (f: [number, number] = fva) => local.issueToken({ sub, azp: ORIGIN, fva: f });
  expect((await call('GET', '/me', tok())).status).toBe(200);
  if (admin) await pool.query(`update users set role = 'admin' where idp_subject = $1`, [sub]);
  const id = (await pool.query(`select id from users where idp_subject = $1`, [sub])).rows[0].id as string;
  return { id, token: tok(), stale: tok([30, 30]) };
}

async function seedAlert(kind: string, raised: string, ack?: { at: string; by: string }) {
  const id = (await pool.query(`select gen_random_uuid() id`)).rows[0].id as string;
  await pool.query(
    `insert into admin_alerts (id, kind, subject_user_id, counts, dedupe_key, raised_at, acknowledged_at, acknowledged_by)
     values ($1, $2, null, '{"jobs": 3}', $3, $4, $5, $6)`,
    [id, kind, `${kind}:${id}`, raised, ack?.at ?? null, ack?.by ?? null],
  );
  return id;
}
const denied = async () =>
  Number((await pool.query(`select count(*) n from audit_events where action = 'auth.denied'`)).rows[0].n);

describe('API-125 and API-126 through the api composition root', () => {
  it('refuses a non-admin with 403 forbidden_role and audits the denial, and 401 without a token', async () => {
    const user = await account(false);
    const before = await denied();
    const r = await call('GET', '/admin/alerts', user.token);
    expect([r.status, r.body.error?.code]).toEqual([403, 'forbidden_role']);
    const p = await call('POST', `/admin/alerts/${'0'.repeat(8)}-0000-4000-8000-000000000000/acknowledge`, user.token);
    expect([p.status, p.body.error?.code]).toEqual([403, 'forbidden_role']);
    expect(await denied()).toBe(before + 2);
    expect((await call('GET', '/admin/alerts')).status).toBe(401);
  });

  it('refuses an admin without recent authentication with 403 recent_auth_required and audits it', async () => {
    const admin = await account(true);
    const before = await denied();
    const r = await call('GET', '/admin/alerts', admin.stale);
    expect([r.status, r.body.error?.code]).toEqual([403, 'recent_auth_required']);
    const id = await seedAlert('job_burst', '2026-01-01T00:00:00Z');
    const p = await call('POST', `/admin/alerts/${id}/acknowledge`, admin.stale);
    expect([p.status, p.body.error?.code]).toEqual([403, 'recent_auth_required']);
    expect(await denied()).toBe(before + 2);
    expect((await pool.query(`select acknowledged_at from admin_alerts where id = $1`, [id])).rows[0].acknowledged_at).toBeNull();
  });

  it('acknowledges once; a second administrator gets the first acknowledger; unknown and malformed IDs fail', async () => {
    const first = await account(true);
    const second = await account(true);
    const id = await seedAlert('key_unseal_failed', '2026-01-02T00:00:00Z');
    const a = await call('POST', `/admin/alerts/${id}/acknowledge`, first.token);
    expect(a.status).toBe(200);
    expect(a.body.data).toMatchObject({ id, acknowledgedBy: first.id, counts: { jobs: 3 } });
    expect(contractValidator('AlertResponse')(a.body)).toBe(true);
    const b = await call('POST', `/admin/alerts/${id}/acknowledge`, second.token);
    expect(b.status).toBe(200);
    expect(b.body.data.acknowledgedBy).toBe(first.id);
    expect(b.body.data.acknowledgedAt).toBe(a.body.data.acknowledgedAt);
    const missing = await call('POST', `/admin/alerts/${'1'.repeat(8)}-1111-4111-8111-111111111111/acknowledge`, first.token);
    expect([missing.status, missing.body.error?.code]).toEqual([404, 'not_found']);
    const bad = await call('POST', '/admin/alerts/not-a-uuid/acknowledge', first.token);
    expect([bad.status, bad.body.error?.code]).toEqual([400, 'validation_failed']);
  });

  it('lists open alerts first and pages without gaps or repeats, with a signed cursor and a filter', async () => {
    const admin = await account(true);
    await pool.query(`delete from admin_alerts`);
    const ids: string[] = [];
    const ack = { at: '2026-02-01T00:00:00.000001Z', by: admin.id };
    for (let i = 0; i < 4; i++) ids.push(await seedAlert('job_burst', `2026-01-0${String(i + 1)}T00:00:00.000123Z`));
    for (let i = 0; i < 3; i++) {
      ids.push(await seedAlert('job_burst', `2026-01-1${String(i)}T00:00:00Z`, { at: i === 2 ? '2026-02-01T00:00:00.000002Z' : ack.at, by: admin.id }));
    }
    const all = (await pool.query(
      `select id from admin_alerts order by acknowledged_at asc nulls first, raised_at desc, id desc`,
    )).rows.map((r: { id: string }) => r.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    const isPage = contractValidator('AlertPage');
    do {
      const q: string = `/admin/alerts?limit=3${cursor === null ? '' : `&cursor=${cursor}`}`;
      const r = await call('GET', q, admin.token);
      expect(r.status).toBe(200);
      expect(isPage(r.body)).toBe(true);
      expect(JSON.stringify(r.body)).not.toMatch(/@/);
      seen.push(...r.body.data.map((a: { id: string }) => a.id));
      cursor = r.body.metaData.pagination.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(all);
    expect(seen.slice(0, 4).every((id) => ids.slice(0, 4).includes(id))).toBe(true);

    const open = await call('GET', '/admin/alerts?acknowledged=false', admin.token);
    expect(open.body.data).toHaveLength(4);
    const done = await call('GET', '/admin/alerts?acknowledged=true&limit=2', admin.token);
    expect(done.body.data.map((a: { id: string }) => a.id)).toEqual(all.slice(4, 6));
    // A cursor from one filter is refused under another, and a tampered one is refused.
    const next = done.body.metaData.pagination.nextCursor as string;
    for (const url of [`/admin/alerts?cursor=${next}`, `/admin/alerts?acknowledged=true&cursor=${next}x`]) {
      const r = await call('GET', url, admin.token);
      expect([r.status, r.body.error?.code]).toEqual([400, 'validation_failed']);
    }
    for (const url of ['/admin/alerts?limit=0', '/admin/alerts?limit=51', '/admin/alerts?acknowledged=maybe']) {
      expect((await call('GET', url, admin.token)).status).toBe(400);
    }
  });
});
