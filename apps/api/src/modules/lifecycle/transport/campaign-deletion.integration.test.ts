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
import { CampaignDeletionJob } from '../lifecycle.module.js';

// TASK-058 (lifecycle 1/2) through the real api composition root (`createApiApp`, the one `main.api.ts` runs) with
// `fastify.inject`, and the real worker composition root (`createWorkerApp`) on real PostgreSQL and an in-process S3 stand-in
// that also plays the `erasure-ledger` bucket: API-042, the `lifecycle.campaign-deletion` run, the stuck path with an
// injected storage failure, the ledger object, the verification sweep. TC-DEL-01, 03, 04 (cancel half), 06, 07.

const ORIGIN = 'http://localhost:3000';
const contractsDir = join(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'packages', 'contracts');
const APP_BUCKET = 'app';
const LEDGER_BUCKET = 'ledger';

interface Stand {
  readonly endpoint: string;
  /** Every stored object as `bucket/key`. */
  readonly objects: Map<string, Buffer>;
  failDeletes: boolean;
  stop(): Promise<void>;
}

/** An in-process S3 stand-in (path-style, plain http): conditional put, get, delete, batch delete and list, in any bucket. */
async function startStand(): Promise<Stand> {
  const objects = new Map<string, Buffer>();
  const stand = { objects, failDeletes: false } as { objects: Map<string, Buffer>; failDeletes: boolean };
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
let job: CampaignDeletionJob;
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
  testDb = await createTestDatabase({ label: 'task058', migrations: false });
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
    OWNER_EMAIL: 'owner58@example.test',
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
  job = worker.context.get(CampaignDeletionJob, { strict: false });
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
async function call(method: 'GET' | 'POST' | 'DELETE', url: string, token?: string, payload?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
  const res = await fastify().inject({ method, url: `/api/v1${url}`, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: res.statusCode, raw: res.body, body: (res.body === '' ? { success: true, metaData: {} } : JSON.parse(res.body)) as Body };
}

async function account() {
  const sub = `user_t58_${String(++seq)}`;
  const email = `l${String(seq)}@example.test`;
  local.addUser(sub, email, true);
  await pool.query(`insert into invitations (id, email, expires_at) values (gen_random_uuid(), $1, now() + interval '1 day')`, [email]);
  const token = local.issueToken({ sub, azp: ORIGIN, fva: [1, 1] });
  expect((await call('GET', '/me', token)).status).toBe(200);
  const id = (await pool.query(`select id from users where idp_subject = $1`, [sub])).rows[0].id as string;
  await pool.query(
    `insert into provider_keys (id, owner_id, provider, status, version, ciphertext, nonce, wrapped_dek, kek_version, last4, fingerprint, fingerprint_pepper_version)
     values ($1, $2, 'wavespeed', 'active', 1, $3, $4, $5, 1, 'cdef', $6, 1)`,
    [randomUUID(), id, Buffer.alloc(32, 1), Buffer.alloc(12, 2), Buffer.alloc(384, 3), 'b'.repeat(64)],
  );
  return { id, token };
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
async function seedRun(c: Seeded, over: { step?: number; state?: string } = {}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into deletion_runs (id, kind, subject_id, owner_id, step, state) values ($1, 'campaign', $2, $3, $4, $5)`,
    [id, c.campaign, c.owner, over.step ?? 1, over.state ?? 'running'],
  );
  return id;
}

describe('API-042 and the deletion run through the real entry points', () => {
  it('TC-DEL-01: hides the campaign at once, cancels its jobs and reservations, queues the run, and the worker removes everything', async () => {
    const a = await account();
    const c = await campaign(a.id, { media: 2 });
    // An unfinished clip with its reservation, a brief job with its reservation, through the public job-creating route.
    const clip = await call('POST', `/campaigns/${c.campaign}/segments/1/jobs`, a.token, undefined, { 'idempotency-key': 'del-1' });
    expect(clip.status).toBe(202);
    const briefJob = randomUUID();
    await pool.query(
      `insert into brief_jobs (id, owner_id, kind, campaign_id, state, reuse_hash, deadline_at) values ($1, $2, 'brief_generation', $3, 'pending', $4, now() + interval '1 hour')`,
      [briefJob, a.id, c.campaign, 'c'.repeat(64)],
    );
    await pool.query(`insert into spend_reservations (id, owner_id, job_type, job_id, estimated_cost_usd, remaining_calls) values ($1, $2, 'brief_generation', $3, 0.1, 2)`, [randomUUID(), a.id, briefJob]);
    expect(await count('spend_reservations', 'owner_id = $1', [a.id])).toBe(2);

    // Before: listed, readable. Cancel path first: no token changes nothing.
    expect((await call('DELETE', `/campaigns/${c.campaign}`)).status).toBe(401);
    expect((await one<{ state: string }>('select state from campaigns where id = $1', [c.campaign])).state).toBe('active');
    expect((await call('GET', '/campaigns', a.token)).body.data.map((x: { id: string }) => x.id)).toContain(c.campaign);

    const res = await call('DELETE', `/campaigns/${c.campaign}`, a.token);
    expect(res.status).toBe(202);
    expect(contractValidator('DeletionAcceptedResponse')(res.body)).toBe(true);
    expect(res.body.data.state).toBe('running');
    const runId = res.body.data.deletionRunId as string;

    // At once: gone from the list, the detail is the single not-found, the state is `deleting`.
    expect((await call('GET', '/campaigns', a.token)).body.data.map((x: { id: string }) => x.id)).not.toContain(c.campaign);
    const detail = await call('GET', `/campaigns/${c.campaign}`, a.token);
    expect(detail.status).toBe(404);
    expect(detail.body.error?.code).toBe('not_found');
    expect((await one<{ state: string }>('select state from campaigns where id = $1', [c.campaign])).state).toBe('deleting');
    // Jobs cancelled, reservations released, the audit event written, the run row present.
    expect(await one(`select state, cause_class from video_jobs where id = $1`, [clip.body.data.id])).toEqual({ state: 'cancelled', cause_class: 'cancelled_campaign_deleted' });
    expect(await one(`select state, cause_class from brief_jobs where id = $1`, [briefJob])).toEqual({ state: 'cancelled', cause_class: 'cancelled_campaign_deleted' });
    expect(await count('spend_reservations', 'owner_id = $1', [a.id])).toBe(0);
    expect(await count('audit_events', `action = 'campaign.deleted' and object_id = $1 and outcome = 'allowed'`, [c.campaign])).toBe(1);
    expect(await one(`select kind, subject_id, owner_id, state from deletion_runs where id = $1`, [runId])).toEqual({ kind: 'campaign', subject_id: c.campaign, owner_id: a.id, state: 'running' });
    // Repeating the call answers the same not-found.
    expect((await call('DELETE', `/campaigns/${c.campaign}`, a.token)).status).toBe(404);

    // The worker took the run from the queue: ledger object, objects and rows gone, then the wait before the count.
    await until(async () => (await one<{ step: number }>('select step from deletion_runs where id = $1', [runId])).step === 3, 'step 3');
    expect(ledgerObjects()).toHaveLength(1);
    expect(ledgerObjects()[0]).toContain(runId);
    expect(JSON.parse(stand.objects.get(ledgerObjects()[0] as string)?.toString() ?? '{}')).toEqual({ runId, kind: 'campaign', subjectId: c.campaign });
    expect(appObjects(`u/${a.id}/c/${c.campaign}/`)).toHaveLength(0);
    expect(await count('media_objects', 'campaign_id = $1', [c.campaign])).toBe(0);
    expect((await one<{ state: string; step: number }>('select state, step from deletion_runs where id = $1', [runId]))).toMatchObject({ state: 'running', step: 3 });
    expect(await count('campaigns', 'id = $1', [c.campaign])).toBe(1); // still invisible, not yet gone

    // A copy that landed in the window is swept by the verification count; then the campaign and its rows go.
    const late = `u/${a.id}/c/${c.campaign}/clip/${randomUUID()}.mp4`;
    await storage.put(late, Buffer.alloc(8, 2), 'video/mp4', 100);
    await fastForward(runId);
    expect(await job.run(runId, log)).toBe('completed');
    expect(appObjects(`u/${a.id}/c/${c.campaign}/`)).toHaveLength(0);
    expect(await count('campaigns', 'id = $1', [c.campaign])).toBe(0);
    expect(await count('drafts', 'campaign_id = $1', [c.campaign])).toBe(0);
    expect(await count('video_jobs', 'campaign_id = $1', [c.campaign])).toBe(0);
    expect(await one(`select state, step, remaining_objects from deletion_runs where id = $1`, [runId])).toEqual({ state: 'completed', step: 4, remaining_objects: 0 });
    expect(await count('audit_events', `action = 'campaign.deletion_completed' and object_id = $1`, [c.campaign])).toBe(1);
    expect(ledgerObjects()).toHaveLength(1);
  });

  it('TC-DEL-06: another user, a never-existing id and a bad id answer the one not-found and change nothing', async () => {
    const a = await account();
    const b = await account();
    const c = await campaign(a.id, { media: 1 });
    const foreign = await call('DELETE', `/campaigns/${c.campaign}`, b.token);
    const missing = await call('DELETE', `/campaigns/${randomUUID()}`, b.token);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body.error?.code).toBe('not_found');
    expect({ ...foreign.body.error, message: undefined }).toEqual({ ...missing.body.error, message: undefined });
    expect(await one('select state from campaigns where id = $1', [c.campaign])).toEqual({ state: 'active' });
    expect(await count('deletion_runs', 'subject_id = $1', [c.campaign])).toBe(0);
    expect(appObjects(`u/${a.id}/c/${c.campaign}/`)).toHaveLength(1);
    expect(await count('audit_events', `action = 'access.denied_foreign' and object_id = $1 and outcome = 'denied'`, [c.campaign])).toBe(1);
    expect((await call('DELETE', '/campaigns/not-a-uuid', b.token)).status).toBe(400);
  });

  it('TC-DEL-03, TC-DEL-07: storage removal fails then retries, the run is stuck with one alert while the campaign stays invisible, and a resumed run completes with a zero count', async () => {
    const a = await account();
    const c = await campaign(a.id, { state: 'deleting', media: 3 });
    const runId = await seedRun(c);
    stand.failDeletes = true;
    // Attempt 1 fails and is left to the queue's retry; attempt 2 reaches the limit (2): stuck.
    await expect(job.run(runId, log)).rejects.toThrow();
    expect(await one(`select state, attempts, step, last_error_class from deletion_runs where id = $1`, [runId])).toMatchObject({ state: 'running', attempts: 1, step: 2 });
    expect(await job.run(runId, log)).toBe('stuck');
    expect(await one(`select state, attempts from deletion_runs where id = $1`, [runId])).toEqual({ state: 'stuck', attempts: 2 });
    expect(await count('admin_alerts', `kind = 'campaign_deletion_stuck' and subject_user_id = $1`, [a.id])).toBe(1);
    expect(await count('audit_events', `action = 'campaign.deletion_stuck' and object_id = $1`, [c.campaign])).toBe(1);
    // Invisible all along; a stuck run is left alone and the alert is not raised again.
    expect((await call('GET', `/campaigns/${c.campaign}`, a.token)).status).toBe(404);
    expect((await call('GET', '/campaigns', a.token)).body.data.map((x: { id: string }) => x.id)).not.toContain(c.campaign);
    expect(await job.run(runId, log)).toBe('skipped');
    expect(await count('admin_alerts', `kind = 'campaign_deletion_stuck' and subject_user_id = $1`, [a.id])).toBe(1);
    expect(appObjects(`u/${a.id}/c/${c.campaign}/`).length).toBeGreaterThan(0);

    // The operator resumes it (the ops command arrives with the next slice): storage is back, the run completes.
    stand.failDeletes = false;
    await pool.query(`update deletion_runs set state = 'running', attempts = 0 where id = $1`, [runId]);
    expect(await job.run(runId, log)).toBe('waiting');
    await fastForward(runId);
    expect(await job.run(runId, log)).toBe('completed');
    expect(appObjects(`u/${a.id}/c/${c.campaign}/`)).toHaveLength(0);
    expect(await count('media_objects', 'campaign_id = $1', [c.campaign])).toBe(0);
    expect(await count('campaigns', 'id = $1', [c.campaign])).toBe(0);
    expect(await one(`select state, remaining_objects from deletion_runs where id = $1`, [runId])).toEqual({ state: 'completed', remaining_objects: 0 });
  });

  it('TC-DEL-04: a clip that was copying at deletion is cancelled and nothing is written for the campaign afterwards', async () => {
    const a = await account();
    const c = await campaign(a.id);
    const queuedClip = await call('POST', `/campaigns/${c.campaign}/segments/1/jobs`, a.token, undefined, { 'idempotency-key': 'del-4' });
    expect(queuedClip.status).toBe(202);
    // The provider finished and the copy is under way: the job is `processing` with `provider_completed_at` set.
    await pool.query(`update video_jobs set state = 'processing', provider_task_id = 'task-1', provider_completed_at = now() where id = $1`, [queuedClip.body.data.id]);
    expect((await call('DELETE', `/campaigns/${c.campaign}`, a.token)).status).toBe(202);
    expect(await one(`select state, cause_class from video_jobs where id = $1`, [queuedClip.body.data.id])).toEqual({ state: 'cancelled', cause_class: 'cancelled_campaign_deleted' });
    expect(await count('spend_reservations', 'owner_id = $1', [a.id])).toBe(0);
    // The copy that was in flight puts after the cancel (the stand-in cannot be stopped mid-put); the verification count
    // finds and removes it, and no media row is left.
    const late = `u/${a.id}/c/${c.campaign}/clip/${randomUUID()}.mp4`;
    await storage.put(late, Buffer.alloc(8, 3), 'video/mp4', 100);
    const runId = (await one<{ id: string }>('select id from deletion_runs where subject_id = $1', [c.campaign])).id;
    await until(async () => (await one<{ step: number }>('select step from deletion_runs where id = $1', [runId])).step === 3, 'step 3');
    expect(appObjects(`u/${a.id}/c/${c.campaign}/`)).toHaveLength(0);
    await fastForward(runId);
    expect(await job.run(runId, log)).toBe('completed');
    expect(await count('media_objects', 'campaign_id = $1', [c.campaign])).toBe(0);
    expect(appObjects(`u/${a.id}/c/${c.campaign}/`)).toHaveLength(0);
  });
});
