import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { ModulesContainer } from '@nestjs/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from '../../../bootstrap/api.module.js';
import { createWorkerApp } from '../../../bootstrap/worker.module.js';
import type { WorkerApp } from '../../../bootstrap/worker.module.js';
import { runSeed } from '../../../database/seed.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../../platform/db/test-database.js';
import type { TestDatabase } from '../../../platform/db/test-database.js';
import { installJobs } from '../../../platform/jobs/test-support.js';
import { buildLogger, createHttpLogging } from '../../../platform/logging/index.js';
import { STORAGE_PORT } from '../../media/index.js';
import type { StoragePort } from '../../media/index.js';
import { priceTableSeedStep } from '../../usage/index.js';
import { IDENTITY_PORT } from '../../identity/index.js';
import type { LocalIdentity } from '../../identity/index.js';
import { AccountErasureJob } from '../lifecycle.module.js';
import { AccountLifecycleService } from '../application/account-lifecycle.service.js';

// TASK-059 (lifecycle 2/2) through the real api composition root (`createApiApp`, the one `main.api.ts` runs) with
// `fastify.inject`, and the real worker composition root (`createWorkerApp`) on real PostgreSQL and an in-process S3 stand-in
// that also plays the `erasure-ledger` bucket: API-101, 102, 103 and 105, the `lifecycle.account-erasure` run, the ledger
// object before the first step, the stuck path with an injected identity provider or storage failure and its resume.
// TC-ACC-08, 09, 10, TC-DEL-05, TC-LED-01, 02, TC-BKP-26, TC-INV-07.

const ORIGIN = 'http://localhost:3000';
const contractsDir = join(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'packages', 'contracts');
const APP_BUCKET = 'app';
const LEDGER_BUCKET = 'ledger';

interface Stand {
  readonly endpoint: string;
  /** Every stored object as `bucket/key`. */
  readonly objects: Map<string, Buffer>;
  failDeletes: boolean;
  /** While true every put in the ledger bucket fails (the bucket is unreachable). */
  failLedger: boolean;
  stop(): Promise<void>;
}

/** An in-process S3 stand-in (path-style, plain http): conditional put, get, delete, batch delete and list, in any bucket. */
async function startStand(): Promise<Stand> {
  const objects = new Map<string, Buffer>();
  const stand = { objects, failDeletes: false, failLedger: false } as { objects: Map<string, Buffer>; failDeletes: boolean; failLedger: boolean };
  const xml = (res: ServerResponse, status: number, body: string): void => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/xml');
    res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
  };
  const error = (res: ServerResponse, status: number, code: string): void => xml(res, status, `<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const [, bucket = '', ...rest] = url.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      if (key === '' && req.method === 'GET') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const listed = [...objects.entries()]
          .filter(([name]) => name.startsWith(`${bucket}/${prefix}`))
          .sort(([a], [b]) => a.localeCompare(b));
        const contents = listed.map(([name, o]) => `<Contents><Key>${name.slice(bucket.length + 1)}</Key><Size>${String(o.length)}</Size><LastModified>${new Date().toISOString()}</LastModified></Contents>`).join('');
        return xml(res, 200, `<ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${String(listed.length)}</KeyCount><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
      }
      if (key === '' && req.method === 'POST' && url.searchParams.has('delete')) {
        if (stand.failDeletes) return error(res, 500, 'InternalError');
        for (const match of body.toString().matchAll(/<Key>([^<]+)<\/Key>/g)) objects.delete(`${bucket}/${match[1] as string}`);
        return xml(res, 200, '<DeleteResult></DeleteResult>');
      }
      const name = `${bucket}/${key}`;
      if (req.method === 'PUT') {
        if (bucket === LEDGER_BUCKET && stand.failLedger) return error(res, 500, 'InternalError');
        if (req.headers['if-none-match'] === '*' && objects.has(name)) return error(res, 412, 'PreconditionFailed');
        objects.set(name, body);
        res.setHeader('etag', '"stub"');
        res.statusCode = 200;
        return res.end();
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const found = objects.get(name);
        if (found === undefined) return error(res, 404, 'NoSuchKey');
        res.setHeader('content-length', String(found.length));
        res.statusCode = 200;
        return res.end(req.method === 'HEAD' ? undefined : found);
      }
      if (req.method === 'DELETE') {
        if (stand.failDeletes) return error(res, 500, 'InternalError');
        objects.delete(name);
        res.statusCode = 204;
        return res.end();
      }
      return error(res, 400, 'BadRequest');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(stand, {
    endpoint: `http://127.0.0.1:${String(port)}`,
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  }) as Stand;
}

const sink = new Writable({ write(_chunk: Buffer, _e, done) { done(); } });
let testDb: TestDatabase;
let pool: pg.Pool;
let stand: Stand;
let app: Awaited<ReturnType<typeof createApiApp>>['app'];
let worker: WorkerApp;
let storage: StoragePort;
let job: AccountErasureJob;
let service: AccountLifecycleService;
let idp: LocalIdentity;
let seq = 0;
const savedEnv: Record<string, string | undefined> = {};

interface Local {
  addUser(sub: string, email: string, verified: boolean): void;
  issueToken(claims: { sub: string; azp: string; fva: [number, number] }): string;
}
let local: Local;

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

const log = { info: () => undefined, warn: () => undefined };

beforeAll(async () => {
  stand = await startStand();
  testDb = await createTestDatabase({ label: 'task059', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 8 });
  const tables = (file: string): string[] =>
    (readFileSync(join(REAL_MIGRATIONS, file), 'utf8').split('-- Grants')[0] ?? '')
      .split('--> statement-breakpoint')
      .map((statement) => statement.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
      .filter((statement) => statement !== '');
  for (const statement of tables('0001_task-025-platform.sql')) {
    if (/^CREATE (TABLE|INDEX|UNIQUE INDEX) "?(idempotency_records|rate_limit_buckets)/.test(statement)) await pool.query(statement);
  }
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  for (const file of [
    '0010_task-032-audit.sql',
    '0020_task-033-identity.sql',
    '0030_task-039-provider-keys.sql',
    '0040_task-041-media.sql',
    '0050_task-044-usage.sql',
    '0060_task-058-lifecycle.sql',
    '0070_task-046-campaigns.sql',
    '0080_task-048-brief.sql',
    '0090_task-052-production-video.sql',
  ]) {
    for (const statement of tables(file)) await pool.query(statement);
  }
  await installJobs(testDb.url);
  await runSeed({ dataset: 'reference', appEnv: 'development', databaseUrl: testDb.url, steps: [priceTableSeedStep()] });
  const workerEnv = {
    KEK_PUBLIC_KEYS: undefined,
    KEK_PRIVATE_KEYS: undefined,
    R2_ENDPOINT: stand.endpoint,
    R2_BUCKET: APP_BUCKET,
    R2_ACCESS_KEY_ID: 'stub-access',
    R2_SECRET_ACCESS_KEY: 'stub-secret',
    R2_LEDGER_BUCKET: LEDGER_BUCKET,
    R2_LEDGER_ACCESS_KEY_ID: 'stub-ledger-access',
    R2_LEDGER_SECRET_ACCESS_KEY: 'stub-ledger-secret',
    MEDIA_MAX_PIXEL_DIMENSION: '300',
    MEDIA_MAX_PIXELS: '40000',
    MEDIA_UNATTACHED_TTL_HOURS: '24',
    DELETION_RETRY_LIMIT: '2',
    VIDEO_JOB_DEADLINE_MIN: '5',
  };
  const env: Record<string, string | undefined> = {
    KEK_PUBLIC_KEYS: undefined,
    KEK_PRIVATE_KEYS: undefined,
    R2_ENDPOINT: stand.endpoint,
    R2_BUCKET: APP_BUCKET,
    R2_ACCESS_KEY_ID: 'stub-access',
    R2_SECRET_ACCESS_KEY: 'stub-secret',
    STORAGE_PUBLIC_ORIGIN: stand.endpoint,
    OWNER_EMAIL: 'owner59@example.test',
    INVITE_EMAIL_DOMAINS: 'example.test',
    CURSOR_SIGNING_KEY: 'k'.repeat(40),
  };
  for (const [name, value] of Object.entries(env)) {
    savedEnv[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  ({ app } = await createApiApp(
    {
      WEB_ORIGIN: ORIGIN,
      APP_ENV: 'development',
      DATABASE_URL: testDb.url,
      DATABASE_POOL_MAX: 8,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      RATE_LIMIT_IP_KEY: 'r'.repeat(40),
    },
    createHttpLogging({ level: 'silent', destination: sink }),
  ));
  const providers = [...app.get(ModulesContainer, { strict: false }).values()].flatMap((m) => [...m.providers.values()]);
  const found = providers.map((p) => p.instance as Partial<Local> | undefined).find((i) => typeof i?.issueToken === 'function');
  if (found === undefined) throw new Error('local identity provider not found');
  local = found as Local;
  worker = await createWorkerApp(
    {
      DATABASE_URL: testDb.url,
      DATABASE_POOL_MAX: 8,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      WORKER_WATCHDOG_SECONDS: 180,
      WORKER_DRAIN_SECONDS: 5,
      WORKER_CONCURRENCY_PROVIDER: 2,
      WORKER_CONCURRENCY_SANITIZE: 1,
      WORKER_CONCURRENCY_DELETION: 2,
    },
    { logger: buildLogger({ level: 'silent', destination: sink }).logger, env: workerEnv, exit: () => undefined },
  );
  storage = worker.context.get<StoragePort>(STORAGE_PORT, { strict: false });
  job = worker.context.get(AccountErasureJob, { strict: false });
  service = app.get(AccountLifecycleService, { strict: false });
  idp = worker.context.get<LocalIdentity>(IDENTITY_PORT, { strict: false });
}, 300_000);

afterAll(async () => {
  await worker?.runtime.drain().catch(() => undefined);
  await worker?.context.close().catch(() => undefined);
  await app?.close();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await pool?.end();
  await testDb?.drop();
  await stand?.stop();
});

const fastify = () => app.getHttpAdapter().getInstance();
interface Body { success: boolean; data?: any; error?: { code: string; message: string; details?: any[] }; metaData: any } // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(method: 'GET' | 'POST' | 'DELETE' | 'PUT', url: string, token?: string, payload?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
  const res = await fastify().inject({ method, url: `/api/v1${url}`, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: res.statusCode, raw: res.body, body: (res.body === '' ? { success: true, metaData: {} } : JSON.parse(res.body)) as Body };
}

async function account() {
  const sub = `user_t59_${String(++seq)}`;
  const email = `l${String(seq)}@example.test`;
  local.addUser(sub, email, true);
  idp.addUser(sub, email, true);
  await pool.query(`insert into invitations (id, email, expires_at) values (gen_random_uuid(), $1, now() + interval '1 day')`, [email]);
  const token = local.issueToken({ sub, azp: ORIGIN, fva: [1, 1] });
  expect((await call('GET', '/me', token)).status).toBe(200);
  const id = (await pool.query(`select id from users where idp_subject = $1`, [sub])).rows[0].id as string;
  await pool.query(
    `insert into provider_keys (id, owner_id, provider, status, version, ciphertext, nonce, wrapped_dek, kek_version, last4, fingerprint, fingerprint_pepper_version)
     values ($1, $2, 'wavespeed', 'active', 1, $3, $4, $5, 1, 'cdef', $6, 1)`,
    [randomUUID(), id, Buffer.alloc(32, 1), Buffer.alloc(12, 2), Buffer.alloc(384, 3), 'b'.repeat(64)],
  );
  return { id, token, sub, email };
}

/** An administrator: a linked account with the `admin` role (the first-admin path is not what these cases test). */
async function admin() {
  const a = await account();
  await pool.query(`update users set role = 'admin' where id = $1`, [a.id]);
  return a;
}

interface Seeded { campaign: string; owner: string; media: string[]; keys: string[] }

/** A campaign with a brief, two segments and `media` generated clips, each with a row and an object in the app bucket. */
async function campaign(owner: string, opts: { state?: string; media?: number } = {}): Promise<Seeded> {
  const campaignId = randomUUID();
  const briefId = randomUUID();
  await pool.query(
    `insert into campaigns (id, owner_id, state, product_name, product_description, segment_count) values ($1, $2, $3, 'Calm Cap', 'A slow morning drink', 2)`,
    [campaignId, owner, opts.state ?? 'active'],
  );
  await pool.query(`insert into drafts (id, owner_id, campaign_id, product_name) values ($1, $2, $3, 'Calm Cap')`, [randomUUID(), owner, campaignId]);
  await pool.query(`insert into briefs (id, campaign_id, owner_id, state, accepted_at) values ($1, $2, $3, 'accepted', now())`, [briefId, campaignId, owner]);
  for (const position of [1, 2]) {
    await pool.query(
      `insert into brief_segments (id, brief_id, position, dialogue, prompt, word_count) values ($1, $2, $3, $4, $5, 30)`,
      [randomUUID(), briefId, position, `Dialogue ${String(position)}`, `A calm kitchen ${String(position)}`],
    );
  }
  const media: string[] = [];
  const keys: string[] = [];
  for (let i = 0; i < (opts.media ?? 0); i += 1) {
    const id = randomUUID();
    const key = `u/${owner}/c/${campaignId}/clip/${id}.mp4`;
    await storage.put(key, Buffer.alloc(64, 1), 'video/mp4', 1000);
    await pool.query(
      `insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, campaign_id) values ($1, $2, 'clip', 'ready', $3, 64, 'video/mp4', $4)`,
      [id, owner, key, campaignId],
    );
    await pool.query(
      `insert into storage_usage (owner_id, bytes_used) values ($1, 64) on conflict (owner_id) do update set bytes_used = storage_usage.bytes_used + 64`,
      [owner],
    );
    media.push(id);
    keys.push(key);
  }
  return { campaign: campaignId, owner, media, keys };
}

const one = async <T = any>(text: string, params: unknown[] = []): Promise<T> => (await pool.query(text, params)).rows[0] as T; // eslint-disable-line @typescript-eslint/no-explicit-any
const count = async (table: string, where: string, params: unknown[]) => (await one<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`, params)).n;
const appObjects = (prefix: string) => [...stand.objects.keys()].filter((name) => name.startsWith(`${APP_BUCKET}/${prefix}`));
const ledgerObjects = () => [...stand.objects.keys()].filter((name) => name.startsWith(`${LEDGER_BUCKET}/erasure/`));
const fastForward = (runId: string) => pool.query(`update deletion_runs set not_before = now() where id = $1`, [runId]);
async function until(check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const bodyOf = (res: { body: Body }) => res.body;
const runOf = async (userId: string) => one<{ id: string; step: number; state: string; attempts: number; remaining_objects: number | null; not_before: string }>(`select id, step, state, attempts, remaining_objects, not_before from deletion_runs where kind = 'account' and subject_id = $1`, [userId]);
const quarantine = (id: string) => `q/${id}/${randomUUID()}.bin`;

/** The data of one account in every class of PRD §3.3: a campaign with media, a quarantined upload, usage and audit rows. */
async function populated(a: { id: string; email: string; sub: string }) {
  const c = await campaign(a.id, { media: 2 });
  const q = quarantine(a.id);
  await storage.put(q, Buffer.alloc(16, 4), 'application/octet-stream', 100);
  await pool.query(
    `insert into usage_events (id, owner_id, provider, operation, job_type, job_id, call_seq, outcome, estimated_cost_usd, cost_basis) values ($1, $2, 'wavespeed', 'video-1', 'video', $3, 1, 'succeeded', 0.5, 'estimate')`,
    [randomUUID(), a.id, randomUUID()],
  );
  // The subject's own invitation (with a provider invitation), one they sent, and an access request of theirs.
  const providerInvitation = await idp.createInvitation(a.email, 7);
  await pool.query(`update invitations set idp_invitation_id = $2, state = 'invited', accepted_user_id = null where lower(email) = $1`, [a.email, providerInvitation]);
  const sent = randomUUID();
  await pool.query(`insert into invitations (id, email, invited_by, state, expires_at) values ($1, $2, $3, 'invited', now() + interval '1 day')`, [sent, `sent-${sent.slice(0, 8)}@example.test`, a.id]);
  await pool.query(`insert into access_requests (id, idp_subject, email, state) values ($1, $2, $3, 'pending')`, [randomUUID(), a.sub, a.email]);
  return { c, q, providerInvitation, sent, objects: [...c.keys, q] };
}

/** Counts of rows that hold `text` in any text, varchar or jsonb column of the application schema. */
async function rowsHolding(text: string): Promise<Record<string, number>> {
  const columns = (await pool.query<{ table_name: string; column_name: string; data_type: string }>(
    `select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' and data_type in ('text', 'character varying', 'jsonb', 'character')`,
  )).rows;
  const found: Record<string, number> = {};
  for (const { table_name, column_name, data_type } of columns) {
    const expr = data_type === 'jsonb' ? `"${column_name}"::text` : `"${column_name}"`;
    const n = (await one<{ n: number }>(`select count(*)::int as n from "${table_name}" where ${expr} ilike $1`, [`%${text}%`])).n;
    if (n > 0) found[`${table_name}.${column_name}`] = n;
  }
  return found;
}

describe('API-101, API-102: suspend and reinstate', () => {
  it('TC-ACC-08: suspend ends access at the next request and cancels the jobs, reinstate restores it, a repeat changes nothing', async () => {
    const boss = await admin();
    const a = await account();
    const c = await campaign(a.id, { media: 1 });
    const clip = await call('POST', `/campaigns/${c.campaign}/segments/1/jobs`, a.token, undefined, { 'idempotency-key': 'susp-1' });
    expect(clip.status).toBe(202);
    const briefJob = randomUUID();
    await pool.query(`insert into brief_jobs (id, owner_id, kind, campaign_id, state, reuse_hash, deadline_at) values ($1, $2, 'brief_generation', $3, 'pending', $4, now() + interval '1 hour')`, [briefJob, a.id, c.campaign, 'd'.repeat(64)]);
    await pool.query(`insert into spend_reservations (id, owner_id, job_type, job_id, estimated_cost_usd, remaining_calls) values ($1, $2, 'brief_generation', $3, 0.1, 2)`, [randomUUID(), a.id, briefJob]);
    expect((await call('GET', '/me', a.token)).status).toBe(200);

    // A user is refused, and the refusal is audited; nothing changes.
    const denied = await call('POST', `/admin/users/${a.id}/suspend`, a.token);
    expect(denied.status).toBe(403);
    expect(denied.body.error?.code).toBe('forbidden_role');
    expect((await call('POST', `/admin/users/${a.id}/suspend`)).status).toBe(401);
    expect((await call('POST', '/admin/users/not-a-uuid/suspend', boss.token)).status).toBe(400);
    expect((await call('POST', `/admin/users/${randomUUID()}/suspend`, boss.token)).body.error?.code).toBe('not_found');

    const res = await call('POST', `/admin/users/${a.id}/suspend`, boss.token);
    expect(res.status).toBe(200);
    expect(contractValidator('AdminUserResponse')(res.body)).toBe(true);
    expect(res.body.data).toMatchObject({ id: a.id, status: 'suspended', email: a.email });
    // The user's next request fails with the specified code; data is kept and unreachable.
    const next = await call('GET', '/me', a.token);
    expect(next.status).toBe(403);
    expect(next.body.error?.code).toBe('account_suspended');
    expect((await call('GET', '/campaigns', a.token)).body.error?.code).toBe('account_suspended');
    expect(await count('campaigns', 'id = $1', [c.campaign])).toBe(1);
    expect(await one(`select state, cause_class from video_jobs where id = $1`, [clip.body.data.id])).toEqual({ state: 'cancelled', cause_class: 'cancelled_account_suspended' });
    expect(await one(`select state, cause_class from brief_jobs where id = $1`, [briefJob])).toEqual({ state: 'cancelled', cause_class: 'cancelled_account_suspended' });
    expect(await count('spend_reservations', 'owner_id = $1', [a.id])).toBe(0);
    expect(await count('audit_events', `action = 'account.suspended' and object_id = $1 and actor_id = $2`, [a.id, boss.id])).toBe(1);
    // The session-revoke job is queued with the status change.
    expect(await count('pgboss.job', `name = 'identity.revoke-sessions' and data->>'userId' = $1`, [a.id])).toBe(1);

    // Suspending again is 200 unchanged with no second event.
    const again = await call('POST', `/admin/users/${a.id}/suspend`, boss.token);
    expect(again.status).toBe(200);
    expect(again.body.data.version).toBe(res.body.data.version);
    expect(await count('audit_events', `action = 'account.suspended' and object_id = $1`, [a.id])).toBe(1);

    const back = await call('POST', `/admin/users/${a.id}/reinstate`, boss.token);
    expect(back.status).toBe(200);
    expect(back.body.data.status).toBe('active');
    expect((await call('GET', '/me', a.token)).status).toBe(200);
    // Cancelled jobs are not resumed; the audit event is written once and a repeat is 200 unchanged.
    expect(await one(`select state from video_jobs where id = $1`, [clip.body.data.id])).toEqual({ state: 'cancelled' });
    expect((await call('POST', `/admin/users/${a.id}/reinstate`, boss.token)).status).toBe(200);
    expect(await count('audit_events', `action = 'account.reinstated' and object_id = $1`, [a.id])).toBe(1);
    // The user can run a clip again.
    expect((await call('POST', `/campaigns/${c.campaign}/segments/1/jobs`, a.token, undefined, { 'idempotency-key': 'susp-2' })).status).toBe(202);
  });

  it('refuses an administrator suspending themselves, with an audit event', async () => {
    const only = await admin();
    const self = await call('POST', `/admin/users/${only.id}/suspend`, only.token);
    expect(self.status).toBe(422);
    expect(self.body.error?.code).toBe('self_action');
    expect(await one(`select status from users where id = $1`, [only.id])).toEqual({ status: 'active' });
    expect(await count('audit_events', `action = 'admin_invariant.refused' and object_id = $1 and outcome = 'denied'`, [only.id])).toBe(1);
    expect((await call('GET', '/me', only.token)).status).toBe(200);
  });
});

describe('API-103: remove and the erasure run through the real entry points', () => {
  it('TC-ACC-09: without the identifier, or with a wrong one, nothing is removed', async () => {
    const boss = await admin();
    const a = await account();
    const c = await campaign(a.id, { media: 1 });
    const missing = await call('POST', `/admin/users/${a.id}/remove`, boss.token, {});
    expect(missing.status).toBe(400);
    expect((await call('POST', `/admin/users/${a.id}/remove`, boss.token, { confirmation: 'ab' })).status).toBe(400);
    const wrong = await call('POST', `/admin/users/${a.id}/remove`, boss.token, { confirmation: 'someone-else@example.test' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error?.code).toBe('confirmation_mismatch');
    expect((await call('POST', `/admin/users/${a.id}/remove`, boss.token, { confirmation: a.email, extra: 1 })).status).toBe(400);
    expect(await one(`select status from users where id = $1`, [a.id])).toEqual({ status: 'active' });
    expect(await one(`select state from campaigns where id = $1`, [c.campaign])).toEqual({ state: 'active' });
    expect(await count('provider_keys', 'owner_id = $1', [a.id])).toBe(1);
    expect(await count('deletion_runs', 'subject_id = $1', [a.id])).toBe(0);
    expect(await count('audit_events', `action = 'account.removed' and object_id = $1`, [a.id])).toBe(0);
    expect((await call('GET', '/me', a.token)).status).toBe(200);
    expect((await call('POST', `/admin/users/${boss.id}/remove`, boss.token, { confirmation: boss.email })).body.error?.code).toBe('self_action');
    expect((await call('POST', `/admin/users/${a.id}/remove`, a.token, { confirmation: a.email })).status).toBe(403);
  });

  it('TC-ACC-10, TC-DEL-05, TC-LED-01, TC-LED-02, TC-INV-07: removal ends access at once and the run erases everything but IDs', async () => {
    const boss = await admin();
    const a = await account();
    const data = await populated(a);
    const clip = await call('POST', `/campaigns/${data.c.campaign}/segments/1/jobs`, a.token, undefined, { 'idempotency-key': 'rm-1' });
    expect(clip.status).toBe(202);
    const preCount = data.objects.length;
    expect(appObjects(`u/${a.id}/`).length + appObjects(`q/${a.id}/`).length).toBe(preCount);

    // Case and spaces in the typed identifier do not matter.
    const res = await call('POST', `/admin/users/${a.id}/remove`, boss.token, { confirmation: `  ${a.email.toUpperCase()} ` });
    expect(res.status).toBe(202);
    expect(contractValidator('DeletionAcceptedResponse')(res.body)).toBe(true);
    const runId = res.body.data.deletionRunId as string;

    // At once: sign-in fails, keys are gone, campaigns are hidden, jobs cancelled, the run and the audit event exist.
    const next = await call('GET', '/me', a.token);
    expect(next.status).toBe(403);
    expect(next.body.error?.code).toBe('account_removed');
    expect(await one(`select status from users where id = $1`, [a.id])).toEqual({ status: 'removed' });
    expect(await count('provider_keys', 'owner_id = $1', [a.id])).toBe(0);
    expect(await count('key_events', `owner_id = $1 and kind = 'deleted'`, [a.id])).toBe(1);
    expect(await one(`select state from campaigns where id = $1`, [data.c.campaign])).toEqual({ state: 'deleting' });
    expect(await one(`select state, cause_class from video_jobs where id = $1`, [clip.body.data.id])).toEqual({ state: 'cancelled', cause_class: 'cancelled_account_removed' });
    expect(await count('spend_reservations', 'owner_id = $1', [a.id])).toBe(0);
    expect(await count('audit_events', `action = 'account.removed' and object_id = $1 and actor_id = $2`, [a.id, boss.id])).toBe(1);
    expect(await one(`select kind, subject_id, owner_id, state, step from deletion_runs where id = $1`, [runId])).toEqual({ kind: 'account', subject_id: a.id, owner_id: a.id, state: 'running', step: 1 });
    // A second removal is refused; the first run stands.
    expect((await call('POST', `/admin/users/${a.id}/remove`, boss.token, { confirmation: a.email })).body.error?.code).toBe('state_conflict');
    // The administrator sees it: IDs only (API-105).
    const listed = await call('GET', '/admin/erasures?limit=50', boss.token);
    expect(listed.status).toBe(200);
    expect(contractValidator('DeletionRunPage')(listed.body)).toBe(true);
    expect(listed.body.data.find((r: { id: string }) => r.id === runId)).toMatchObject({ kind: 'account', subjectId: a.id, state: 'running' });
    expect(JSON.stringify(listed.body)).not.toContain(a.email);

    // The worker took the run from the queue: ledger object first, sessions revoked, identity user deleted, objects gone,
    // then the wait for the longest job deadline.
    await until(async () => (await one<{ step: number }>('select step from deletion_runs where id = $1', [runId])).step === 4, 'step 4');
    expect(ledgerObjects().filter((name) => name.includes(runId))).toHaveLength(1);
    const ledger = stand.objects.get(ledgerObjects().find((name) => name.includes(runId)) as string)?.toString() ?? '';
    expect(JSON.parse(ledger)).toEqual({ runId, kind: 'account', subjectId: a.id });
    expect(ledger).not.toContain(a.email);
    expect(idp.sessionRevocations).toContain(a.sub);
    expect(idp.users.has(a.sub)).toBe(false);
    expect(appObjects(`u/${a.id}/`)).toHaveLength(0);
    expect(appObjects(`q/${a.id}/`)).toHaveLength(0);
    expect(await count('users', 'id = $1', [a.id])).toBe(1); // still there until the hard delete

    // A copy that landed in the window is swept by the verification count; then the account and its rows go.
    await storage.put(`u/${a.id}/c/${data.c.campaign}/clip/${randomUUID()}.mp4`, Buffer.alloc(8, 2), 'video/mp4', 100);
    await fastForward(runId);
    expect(await job.run(runId, log)).toBe('completed');
    expect(appObjects(`u/${a.id}/`)).toHaveLength(0);
    expect(await one(`select state, step, remaining_objects from deletion_runs where id = $1`, [runId])).toEqual({ state: 'completed', step: 5, remaining_objects: 0 });
    for (const table of ['users', 'campaigns', 'drafts', 'briefs', 'media_objects', 'provider_keys', 'video_jobs', 'storage_usage']) {
      const where = table === 'users' ? 'id = $1' : table === 'briefs' ? 'owner_id = $1' : 'owner_id = $1';
      expect(await count(table, where, [a.id]), table).toBe(0);
    }
    // Invitations of the address are deleted with their provider invitations revoked; the one the subject sent stays
    // with no inviter. The access request goes.
    expect(await count('invitations', 'lower(email) = $1', [a.email])).toBe(0);
    expect(idp.invitations.get(data.providerInvitation)?.revoked).toBe(true);
    expect(await one(`select invited_by from invitations where id = $1`, [data.sent])).toEqual({ invited_by: null });
    expect(await count('access_requests', 'idp_subject = $1 or lower(email) = $2', [a.sub, a.email])).toBe(0);
    // Kept as IDs only: usage, audit, key events and the run itself.
    expect(await count('usage_events', 'owner_id = $1', [a.id])).toBe(1);
    expect(await count('audit_events', `object_id = $1 and action in ('account.removed', 'account.erasure_completed')`, [a.id])).toBe(2);
    expect(await count('key_events', 'owner_id = $1', [a.id])).toBe(1);
    // No email persists anywhere in the application schema, in the ledger, or in the queue.
    expect(await rowsHolding(a.email)).toEqual({});
    expect(await count('pgboss.job', `data::text ilike $1`, [`%${a.email}%`])).toBe(0);
    expect(ledgerObjects().map((name) => stand.objects.get(name)?.toString() ?? '').join('')).not.toContain(a.email);
    // The old token finds no account at all now: an app route is refused (the removed address has no invitation left).
    expect((await call('GET', '/campaigns', a.token)).status).toBe(403);
    expect(await count('users', 'idp_subject = $1', [a.sub])).toBe(0);
    // A job that arrives again changes nothing.
    expect(await job.run(runId, log)).toBe('skipped');
  });

  it('TC-BKP-26: with the ledger bucket unreachable no step starts and nothing is erased; it retries and then goes on', async () => {
    const boss = await admin();
    const a = await account();
    const data = await populated(a);
    const res = await call('POST', `/admin/users/${a.id}/remove`, boss.token, { confirmation: a.email });
    const runId = res.body.data.deletionRunId as string;
    stand.failLedger = true;
    try {
      // The queue's own attempt may already have failed; run the step by hand: it throws and counts one attempt.
      await expect(job.run(runId, log)).rejects.toThrow();
      expect(ledgerObjects().filter((name) => name.includes(runId))).toHaveLength(0);
      expect(await runOf(a.id)).toMatchObject({ step: 1, state: 'running' });
      expect(idp.users.has(a.sub)).toBe(true);
      expect(idp.sessionRevocations).not.toContain(a.sub);
      expect(appObjects(`u/${a.id}/`).length + appObjects(`q/${a.id}/`).length).toBe(data.objects.length);
    } finally {
      stand.failLedger = false;
    }
    await pool.query(`update deletion_runs set attempts = 0 where id = $1`, [runId]);
    expect(await job.run(runId, log)).toBe('waiting');
    expect(ledgerObjects().filter((name) => name.includes(runId))).toHaveLength(1);
    expect(await runOf(a.id)).toMatchObject({ step: 4, state: 'running' });
    await fastForward(runId);
    expect(await job.run(runId, log)).toBe('completed');
    expect(await count('users', 'id = $1', [a.id])).toBe(0);
  });

  it('an identity provider failure ends the run stuck with one alert, API-105 shows it, and the resume completes it', async () => {
    const boss = await admin();
    const a = await account();
    await populated(a);
    const runId = (await call('POST', `/admin/users/${a.id}/remove`, boss.token, { confirmation: a.email })).body.data.deletionRunId as string;
    await until(async () => (await one<{ step: number }>('select step from deletion_runs where id = $1', [runId])).step >= 3, 'step 3');
    await pool.query(`update deletion_runs set step = 2, attempts = 0, not_before = now(), state = 'running' where id = $1`, [runId]);
    idp.users.set(a.sub, { sub: a.sub, email: a.email, emailVerified: true });
    idp.available = false;
    try {
      // Attempt 1 fails and is left to the queue's retry; attempt 2 reaches the limit (2): stuck.
      await expect(job.run(runId, log)).rejects.toThrow();
      expect(await runOf(a.id)).toMatchObject({ state: 'running', attempts: 1, step: 2 });
      expect(await job.run(runId, log)).toBe('stuck');
    } finally {
      idp.available = true;
    }
    expect(await runOf(a.id)).toMatchObject({ state: 'stuck', attempts: 2, step: 2 });
    expect(await count('admin_alerts', `kind = 'account_erasure_stuck' and subject_user_id = $1`, [a.id])).toBe(1);
    expect(await count('audit_events', `action = 'account.erasure_stuck' and object_id = $1`, [a.id])).toBe(1);
    // Access stays blocked, a stuck run is left alone and the alert is not raised again.
    expect((await call('GET', '/me', a.token)).body.error?.code).toBe('account_removed');
    expect(await job.run(runId, log)).toBe('skipped');
    expect(await count('admin_alerts', `kind = 'account_erasure_stuck' and subject_user_id = $1`, [a.id])).toBe(1);

    const stuck = await call('GET', '/admin/erasures?state=stuck', boss.token);
    expect(stuck.status).toBe(200);
    expect(stuck.body.data.map((r: { id: string }) => r.id)).toContain(runId);
    expect(stuck.body.data.every((r: { state: string }) => r.state === 'stuck')).toBe(true);
    expect((await call('GET', '/admin/erasures?state=bogus', boss.token)).status).toBe(400);
    expect((await call('GET', '/admin/erasures', a.token)).status).toBe(403);
    expect((await call('GET', '/admin/erasures')).status).toBe(401);

    // The operator resumes it (`erasure:resume`): audited, queued, and the run completes with the provider back.
    expect(await service.resume(runId)).toBe(true);
    expect(await service.resume(runId)).toBe(false);
    expect(await count('audit_events', `action = 'erasure.resumed' and object_id = $1 and actor_type = 'operator'`, [a.id])).toBe(1);
    await until(async () => (await one<{ step: number }>('select step from deletion_runs where id = $1', [runId])).step === 4, 'step 4 after the resume');
    await fastForward(runId);
    expect(await job.run(runId, log)).toBe('completed');
    expect(await count('users', 'id = $1', [a.id])).toBe(0);
    expect(idp.users.has(a.sub)).toBe(false);
    const done = await call('GET', '/admin/erasures?state=completed&limit=50', boss.token);
    expect(done.body.data.find((r: { id: string }) => r.id === runId)).toMatchObject({ state: 'completed', remainingObjects: 0, step: 5 });
  });

  it('a storage failure ends the run stuck at the object step and nothing is hard-deleted until the count is zero', async () => {
    const boss = await admin();
    const a = await account();
    const data = await populated(a);
    const runId = (await call('POST', `/admin/users/${a.id}/remove`, boss.token, { confirmation: a.email })).body.data.deletionRunId as string;
    await until(async () => (await one<{ step: number }>('select step from deletion_runs where id = $1', [runId])).step >= 4, 'step 4');
    // Put the run back before the object step with objects present and the storage failing.
    for (const key of data.objects) await storage.put(key, Buffer.alloc(8, 7), 'application/octet-stream', 100);
    await pool.query(`update deletion_runs set step = 3, attempts = 0, not_before = now() where id = $1`, [runId]);
    stand.failDeletes = true;
    try {
      await expect(job.run(runId, log)).rejects.toThrow();
      expect(await job.run(runId, log)).toBe('stuck');
    } finally {
      stand.failDeletes = false;
    }
    expect(await count('users', 'id = $1', [a.id])).toBe(1);
    expect(appObjects(`u/${a.id}/`).length).toBeGreaterThan(0);
    expect(await service.resume(runId)).toBe(true);
    await until(async () => (await one<{ step: number }>('select step from deletion_runs where id = $1', [runId])).step === 4, 'step 4');
    await fastForward(runId);
    expect(await job.run(runId, log)).toBe('completed');
    expect(appObjects(`u/${a.id}/`)).toHaveLength(0);
    expect(await count('users', 'id = $1', [a.id])).toBe(0);
  });

  it('pages the erasure runs newest change first with a signed cursor', async () => {
    const boss = await admin();
    const first = await call('GET', '/admin/erasures?limit=1', boss.token);
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.metaData.pagination.hasNextPage).toBe(true);
    const cursor = first.body.metaData.pagination.nextCursor as string;
    const second = await call('GET', `/admin/erasures?limit=1&cursor=${encodeURIComponent(cursor)}`, boss.token);
    expect(second.status).toBe(200);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    expect((await call('GET', `/admin/erasures?limit=1&cursor=${encodeURIComponent(cursor)}&state=stuck`, boss.token)).status).toBe(400);
    expect(bodyOf(first).success).toBe(true);
  });
});
