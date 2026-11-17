import 'reflect-metadata';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorkerApp } from '../../bootstrap/worker.module.js';
import type { WorkerApp } from '../../bootstrap/worker.module.js';
import { runSeed } from '../../database/seed.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../platform/db/test-database.js';
import type { TestDatabase } from '../../platform/db/test-database.js';
import { EGRESS, Egress } from '../../platform/egress/index.js';
import { startServer } from '../../platform/egress/test-support.js';
import { createRuntimeBoss, startRuntimeBoss } from '../../platform/jobs/boss.js';
import { installJobs } from '../../platform/jobs/test-support.js';
import { buildLogger } from '../../platform/logging/index.js';
import { STORAGE_PORT } from '../media/index.js';
import type { StoragePort } from '../media/index.js';
import { KEY_WRAP_PORT } from '../provider-keys/index.js';
import type { KeyWrapPort } from '../provider-keys/index.js';
import { priceTableSeedStep } from '../usage/index.js';
import { brandRulesSeedStep } from './infrastructure/repositories/brand-rules-file.js';

// TASK-049 (brief 2/4) through the real worker composition root (`createWorkerApp`, the one `main.worker.ts` runs) on real
// PostgreSQL and a real MinIO server, with a local TLS server standing in for api.openai.com (the real one is never
// called): `brief.generate` and `brief.analyze-image` handled by the worker process, the key opened by key ID in the
// worker only, usage events and reservations settled, the cause classes of a failing provider. TC-BRF-*, TC-UPL analysis,
// TC-PCA (cap before call), TC-KEY-06 (the key never leaves).

const KEY = 'integration-openai-secret-0123456789abcdef';
const CTA = 'Take the free 2-minute quiz';
interface TestBucket {
  readonly endpoint: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly bucket: string;
  stop(): Promise<void>;
}

/** A throwaway MinIO server with one private bucket, started by the foundation tests' helper (loaded at run time, as media's own tests do). */
async function startTestBucket(bucket = 'app'): Promise<TestBucket> {
  const url = pathToFileURL(join(import.meta.dirname, '..', '..', '..', '..', '..', 'tools', 'foundation-tests', 'media', 'minio.ts')).href;
  const { startMinio } = (await import(/* @vite-ignore */ url)) as {
    startMinio(): Promise<Omit<TestBucket, 'bucket'>>;
  };
  const minio = await startMinio();
  const admin = new S3Client({
    region: 'us-east-1',
    endpoint: minio.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: minio.accessKey, secretAccessKey: minio.secretKey },
  });
  await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  admin.destroy();
  return { ...minio, bucket };
}

const lines: string[] = [];
const sink = new Writable({ write(chunk: Buffer, _e, done) { lines.push(chunk.toString()); done(); } });

let testDb: TestDatabase;
let pool: pg.Pool;
let minio: TestBucket;
let worker: WorkerApp;
let apiBoss: PgBoss;
let storage: StoragePort;
let wrap: KeyWrapPort;
let stub: Awaited<ReturnType<typeof startServer>>;

interface Seen { auth: string | undefined; body: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
let seen: Seen[] = [];
type Reply = (n: number) => { status?: number; body?: unknown; raw?: string; hang?: boolean };
let reply: Reply = () => ({});

const calm = (n: number): string =>
  Array.from({ length: n }, (_, i) => (i % 5 === 4 || i === n - 1 ? `calm${String(i)}.` : `calm${String(i)}`)).join(' ');
const completion = (content: unknown) => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content), refusal: null } }] });
const briefBody = (a: string, b: string) => completion({
  segments: [{ position: 1, dialogue: a, prompt: 'A calm kitchen' }, { position: 2, dialogue: b, prompt: 'A morning window' }],
});

function kekMaps() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 0x10001 });
  return {
    KEK_PUBLIC_KEYS: JSON.stringify({ 1: publicKey.export({ type: 'spki', format: 'pem' }).toString() }),
    KEK_PRIVATE_KEYS: JSON.stringify({ 1: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }),
    KEK_ACTIVE_VERSION: '1',
  };
}

function egressModule(): DynamicModule {
  @Module({})
  class StubEgress {}
  const egress = new Egress({
    allowedHosts: { openai: ['api.openai.com'] },
    timeoutMs: 1500,
    maxBytes: 5_000_000,
    resolver: async () => ['127.0.0.1'],
    testing: { isBlockedAddress: () => false, tls: { ca: stub.ca }, port: stub.port },
  });
  return { module: StubEgress, providers: [{ provide: EGRESS, useValue: egress }], exports: [EGRESS] };
}

beforeAll(async () => {
  stub = await startServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => {
      seen.push({ auth: req.headers['authorization'], body: JSON.parse(Buffer.concat(parts).toString() || '{}') as Record<string, any> }); // eslint-disable-line @typescript-eslint/no-explicit-any
      const answer = reply(seen.length);
      if (answer.hang === true) return;
      res.statusCode = answer.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(answer.raw ?? JSON.stringify(answer.body ?? {}));
    });
  });
  minio = await startTestBucket();
  // The roles of M0001 do not exist on the shared test server, so each migration's tables are applied as written (the
  // grants are proven by the migration suites) and the test connects as the database owner.
  testDb = await createTestDatabase({ label: 'task049', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 4 });
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  for (const file of ['0010_task-032-audit.sql', '0020_task-033-identity.sql', '0030_task-039-provider-keys.sql', '0040_task-041-media.sql', '0050_task-044-usage.sql', '0070_task-046-campaigns.sql', '0080_task-048-brief.sql']) {
    const tables = readFileSync(join(REAL_MIGRATIONS, file), 'utf8').split('-- Grants')[0] ?? '';
    for (const statement of tables.split('--> statement-breakpoint')) {
      const sql = statement.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim();
      if (sql !== '') await pool.query(sql);
    }
  }
  await installJobs(testDb.url);
  await runSeed({ dataset: 'reference', appEnv: 'development', databaseUrl: testDb.url, steps: [priceTableSeedStep(), brandRulesSeedStep()] });
  const stream = buildLogger({ level: 'debug', destination: sink });
  worker = await createWorkerApp(
    {
      DATABASE_URL: testDb.url,
      DATABASE_POOL_MAX: 8,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      WORKER_WATCHDOG_SECONDS: 180,
      WORKER_DRAIN_SECONDS: 5,
      WORKER_CONCURRENCY_PROVIDER: 2,
      WORKER_CONCURRENCY_SANITIZE: 1,
      WORKER_CONCURRENCY_DELETION: 1,
    },
    {
      logger: stream.logger,
      egress: egressModule(),
      openAiChatUrl: `https://api.openai.com:${String(stub.port)}/v1/chat/completions`,
      env: {
        ...kekMaps(),
        R2_ENDPOINT: minio.endpoint,
        R2_BUCKET: minio.bucket,
        R2_ACCESS_KEY_ID: minio.accessKey,
        R2_SECRET_ACCESS_KEY: minio.secretKey,
        MEDIA_MAX_PIXEL_DIMENSION: '300',
        MEDIA_MAX_PIXELS: '40000',
        MEDIA_UNATTACHED_TTL_HOURS: '24',
        OPENAI_TEXT_MODEL: 'local-stub-text',
        OPENAI_VISION_MODEL: 'local-stub-vision',
        KEY_AUTO_DISABLE_THRESHOLD: '2',
      },
      exit: () => undefined,
    },
  );
  storage = worker.context.get<StoragePort>(STORAGE_PORT, { strict: false });
  wrap = worker.context.get<KeyWrapPort>(KEY_WRAP_PORT, { strict: false });
  apiBoss = createRuntimeBoss({ DATABASE_URL: testDb.url, role: 'api' });
  apiBoss.on('error', () => undefined);
  await startRuntimeBoss(apiBoss);
}, 300_000);

afterAll(async () => {
  await worker?.runtime.drain().catch(() => undefined);
  await worker?.context.close().catch(() => undefined);
  await apiBoss?.stop({ graceful: false }).catch(() => undefined);
  await pool?.end();
  await testDb?.drop();
  await minio?.stop();
  await stub?.close();
});

beforeEach(() => {
  seen = [];
  reply = () => ({});
});

interface Fixture { owner: string; keyId: string; campaign: string; brief: string; job: string }

async function owner(withKey = true, status = 'active'): Promise<{ owner: string; keyId: string }> {
  const id = randomUUID();
  await pool.query(`insert into users (id, idp_subject, email, linked_via) values ($1, $2, $3, 'first_admin')`, [id, `sub_${id.slice(0, 20)}`, `${id.slice(0, 12)}@example.test`]);
  const keyId = randomUUID();
  if (withKey) {
    const sealed = wrap.seal(Buffer.from(KEY), { userId: id, provider: 'openai', keyId, version: 1 });
    await pool.query(
      `insert into provider_keys (id, owner_id, provider, status, version, ciphertext, nonce, wrapped_dek, kek_version, last4, fingerprint, fingerprint_pepper_version)
       values ($1, $2, 'openai', $3, 1, $4, $5, $6, $7, 'cdef', $8, 1)`,
      [keyId, id, status, sealed.ciphertext, sealed.nonce, sealed.wrappedDek, sealed.kekVersion, 'a'.repeat(64)],
    );
  }
  return { owner: id, keyId };
}

/** What the api leaves behind when a brief is submitted: campaign, intake, a `generating` brief and a pending job. */
async function generation(opts: { withKey?: boolean; keyStatus?: string; segments?: number } = {}): Promise<Fixture> {
  const { owner: ownerId, keyId } = await owner(opts.withKey ?? true, opts.keyStatus ?? 'active');
  const campaign = randomUUID();
  const brief = randomUUID();
  const job = randomUUID();
  await pool.query(`insert into campaigns (id, owner_id, product_name, product_description, segment_count) values ($1, $2, 'Calm Cap', 'A slow morning drink', $3)`, [campaign, ownerId, opts.segments ?? 2]);
  await pool.query(`insert into drafts (id, owner_id, intake_mode, concept, audience_age_min, audience_age_max, direction_goal, segment_count, campaign_id) values ($1, $2, 'description', 'A slow morning', 25, 40, 'awareness', $3, $4)`, [randomUUID(), ownerId, opts.segments ?? 2, campaign]);
  await pool.query(`insert into briefs (id, campaign_id, owner_id, state, generation_seq) values ($1, $2, $3, 'generating', 1)`, [brief, campaign, ownerId]);
  await pool.query(
    `insert into brief_jobs (id, owner_id, kind, campaign_id, generation_seq, state, reuse_hash, key_id, key_version, deadline_at)
     values ($1, $2, 'brief_generation', $3, 1, 'pending', $4, $5, 1, now() + interval '10 minutes')`,
    [job, ownerId, campaign, randomBytes(32).toString('hex'), opts.withKey === false ? null : keyId],
  );
  return { owner: ownerId, keyId, campaign, brief, job };
}

async function terminal(table: string, id: string): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const deadline = Date.now() + 60_000;
  for (;;) {
    const row = (await pool.query(`select * from ${table} where id = $1`, [id])).rows[0] as Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (row !== undefined && ['completed', 'failed', 'cancelled'].includes(row['state'] as string)) return row;
    if (Date.now() > deadline) throw new Error(`job ${id} stayed ${String(row?.['state'])}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const events = async (job: string) =>
  (await pool.query(`select call_seq, outcome, estimated_cost_usd::text as cost, cost_basis, operation from usage_events where job_id = $1 order by call_seq`, [job])).rows as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
const reservations = async (job: string) => (await pool.query('select 1 from spend_reservations where job_id = $1', [job])).rowCount;
const send = (queue: string, job: string) => apiBoss.send(queue, { jobId: job });

describe('brief.generate through the worker process', () => {
  it('generates, cleans, claim-checks and writes the brief in place; settles usage; the key stays out of rows and logs', async () => {
    const f = await generation();
    reply = () => ({ body: briefBody(`I tried a slow morning ${calm(30)} — it fit`, `${calm(28)} Adults 21 and over only`) });
    await send('brief.generate', f.job);
    const job = await terminal('brief_jobs', f.job);
    expect(job['state']).toBe('completed');
    expect(job['call_count']).toBe(1);
    const brief = (await pool.query('select * from briefs where id = $1', [f.brief])).rows[0];
    expect(brief.state).toBe('draft');
    expect(brief.version).toBe(2);
    const segments = (await pool.query('select position, dialogue, prompt, word_count, revision, state from brief_segments where brief_id = $1 order by position', [f.brief])).rows;
    expect(segments).toHaveLength(2);
    expect(segments[0].dialogue).not.toMatch(/[—–]/u);
    expect(segments[1].dialogue).toContain(CTA);
    expect(segments.every((s: { word_count: number }) => s.word_count <= 45)).toBe(true);
    const issues = (await pool.query('select rule_id, class from claim_issues where brief_id = $1', [f.brief])).rows;
    expect(issues.every((i: { class: string }) => i.class === 'other')).toBe(true);
    const raised = (await pool.query(`select count(*)::int as n from claim_events where brief_id = $1 and outcome = 'raised'`, [f.brief])).rows[0];
    expect(raised.n).toBe(issues.length);
    // usage: one succeeded event at the estimate; the reservation is gone
    expect(await events(f.job)).toEqual([{ call_seq: 1, outcome: 'succeeded', cost: '0.0100', cost_basis: 'estimate', operation: 'local-stub-text' }]);
    expect(await reservations(f.job)).toBe(0);
    // the provider got the key as a bearer token, structured output and no stored output
    expect(seen).toHaveLength(1);
    expect(seen[0]?.auth).toBe(`Bearer ${KEY}`);
    expect(seen[0]?.body['response_format'].type).toBe('json_schema');
    expect(seen[0]?.body['store']).toBe(false);
    // the key is in no job row, no queue payload, no log line
    const payloads = (await pool.query(`select data::text as data from pgboss.job where name = 'brief.generate'`)).rows.map((r) => r.data as string).join('');
    expect(payloads).not.toContain(KEY);
    expect(JSON.stringify(job)).not.toContain(KEY);
    expect(lines.join('')).not.toContain(KEY);
  });

  it('makes a second call for an over-long segment and records both calls', async () => {
    const f = await generation();
    reply = (n) => n === 1
      ? { body: briefBody(calm(60), calm(30)) }
      : { body: completion({ segments: [{ position: 1, dialogue: calm(40), prompt: 'A calm kitchen' }] }) };
    await send('brief.generate', f.job);
    expect((await terminal('brief_jobs', f.job))['state']).toBe('completed');
    expect(seen).toHaveLength(2);
    expect((await events(f.job)).map((e) => [e.call_seq, e.outcome])).toEqual([[1, 'succeeded'], [2, 'succeeded']]);
    expect(await reservations(f.job)).toBe(0);
    const first = (await pool.query('select dialogue from brief_segments where brief_id = $1 and position = 1', [f.brief])).rows[0];
    expect(first.dialogue.split(/\s+/).length).toBe(40);
  });

  it('classifies a failing provider: 401, 429, 5xx, timeout and a malformed body (TC-BRF, ARCHITECTURE §5.10)', async () => {
    const run = async (answer: ReturnType<Reply>) => {
      const f = await generation();
      reply = () => answer;
      await send('brief.generate', f.job);
      const job = await terminal('brief_jobs', f.job);
      const brief = (await pool.query('select state from briefs where id = $1', [f.brief])).rows[0];
      return { f, job, brief, events: await events(f.job), reserved: await reservations(f.job) };
    };
    const unauthorized = await run({ status: 401, body: { error: { code: 'invalid_api_key', message: `Incorrect API key provided: ${KEY}` } } });
    expect(unauthorized.job['state']).toBe('failed');
    expect(unauthorized.job['cause_class']).toBe('configuration');
    expect(unauthorized.brief.state).toBe('failed');
    expect(unauthorized.events[0]).toMatchObject({ outcome: 'rejected', cost: '0.0000', cost_basis: 'zero_rejected' });
    expect(unauthorized.reserved).toBe(0);
    const failures = (await pool.query('select consecutive_auth_failures, status from provider_keys where id = $1', [unauthorized.f.keyId])).rows[0];
    expect(failures).toMatchObject({ consecutive_auth_failures: 1, status: 'active' });
    expect(JSON.stringify(unauthorized.job)).not.toContain(KEY);

    const busy = await run({ status: 429, body: { error: { code: 'rate_limit_exceeded' } } });
    expect(busy.job['cause_class']).toBe('temporary');
    expect(busy.events[0]).toMatchObject({ outcome: 'rejected', cost: '0.0000' });

    const credit = await run({ status: 429, body: { error: { code: 'insufficient_quota' } } });
    expect(credit.job['cause_class']).toBe('credit');

    const down = await run({ status: 503, raw: 'upstream down' });
    expect(down.job['cause_class']).toBe('outcome_unknown');
    expect(down.events[0]).toMatchObject({ outcome: 'unconfirmed', cost: '0.0100', cost_basis: 'unconfirmed_estimate' });

    const timeout = await run({ hang: true });
    expect(timeout.job['cause_class']).toBe('outcome_unknown');
    expect(timeout.events[0]).toMatchObject({ outcome: 'unconfirmed' });

    const malformed = await run({ raw: '<html>not json</html>' });
    expect(malformed.job['cause_class']).toBe('temporary');
    expect(malformed.job['last_error_code']).toBe('invalid_response');
    expect(malformed.events[0]).toMatchObject({ outcome: 'failed', cost: '0.0100' });
    expect(malformed.brief.state).toBe('failed');
    // none of the failures left a reservation or the key anywhere
    for (const r of [busy, credit, down, timeout, malformed]) expect(r.reserved).toBe(0);
    expect(lines.join('')).not.toContain(KEY);
  }, 120_000);

  it('a regeneration that fails leaves the previous text in place and the brief a draft', async () => {
    const f = await generation();
    await pool.query(`insert into brief_segments (id, brief_id, position, dialogue, prompt, word_count) values ($1, $2, 1, 'old words here', 'old', 3)`, [randomUUID(), f.brief]);
    reply = () => ({ status: 500, raw: 'boom' });
    await send('brief.generate', f.job);
    await terminal('brief_jobs', f.job);
    expect((await pool.query('select state from briefs where id = $1', [f.brief])).rows[0].state).toBe('draft');
    expect((await pool.query('select dialogue from brief_segments where brief_id = $1', [f.brief])).rows[0].dialogue).toBe('old words here');
  });

  it('a missing key creates no call and no charge; a replaced or disabled key too (REQ-016)', async () => {
    const missing = await generation({ withKey: false });
    await send('brief.generate', missing.job);
    expect((await terminal('brief_jobs', missing.job))['cause_class']).toBe('key_deleted');
    const replaced = await generation();
    await pool.query('update provider_keys set version = 2 where id = $1', [replaced.keyId]);
    await send('brief.generate', replaced.job);
    expect((await terminal('brief_jobs', replaced.job))['cause_class']).toBe('key_replaced');
    const disabled = await generation({ keyStatus: 'disabled' });
    await send('brief.generate', disabled.job);
    expect((await terminal('brief_jobs', disabled.job))['cause_class']).toBe('configuration');
    expect(seen).toHaveLength(0);
    for (const f of [missing, replaced, disabled]) {
      expect(await events(f.job)).toEqual([]);
      expect(await reservations(f.job)).toBe(0);
      expect((await pool.query('select state from briefs where id = $1', [f.brief])).rows[0].state).toBe('failed');
    }
  });

  it('refuses over the spend cap before any adapter call (cap precedes the call)', async () => {
    const f = await generation();
    await pool.query(
      `insert into usage_events (id, owner_id, provider, operation, job_type, job_id, call_seq, outcome, estimated_cost_usd, cost_basis)
       values ($1, $2, 'openai', 'local-stub-text', 'video', $3, 1, 'succeeded', 49.99, 'estimate')`,
      [randomUUID(), f.owner, randomUUID()],
    );
    await send('brief.generate', f.job);
    const job = await terminal('brief_jobs', f.job);
    expect(job['state']).toBe('failed');
    expect(job['cause_message']).toContain('spending limit');
    expect(seen).toHaveLength(0);
    expect(await events(f.job)).toEqual([]);
    expect(await reservations(f.job)).toBe(0);
  });

  it('a redelivered or repeated job makes no second provider call (at most once)', async () => {
    const f = await generation();
    reply = () => ({ body: briefBody(calm(36), calm(30)) });
    await send('brief.generate', f.job);
    await terminal('brief_jobs', f.job);
    await send('brief.generate', f.job);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(seen).toHaveLength(1);
  });
});

describe('brief.analyze-image through the worker process', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f0005000201a52e5ad90000000049454e44ae426082', 'hex');

  async function analysis(): Promise<{ owner: string; keyId: string; job: string; media: string }> {
    const { owner: ownerId, keyId } = await owner();
    const media = randomUUID();
    const storageKey = `u/${ownerId}/media/${media}`;
    await storage.put(storageKey, PNG, 'image/png', PNG.length);
    await pool.query(`insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, width, height) values ($1, $2, 'upload', 'ready', $3, $4, 'image/png', 1, 1)`, [media, ownerId, storageKey, PNG.length]);
    const job = randomUUID();
    await pool.query(
      `insert into brief_jobs (id, owner_id, kind, media_id, state, reuse_hash, key_id, key_version, deadline_at)
       values ($1, $2, 'image_analysis', $3, 'pending', $4, $5, 1, now() + interval '10 minutes')`,
      [job, ownerId, media, randomBytes(32).toString('hex'), keyId],
    );
    return { owner: ownerId, keyId, job, media };
  }

  it('sends the bytes inline and stores a description with no ethnicity, age or health inference (fixture person image)', async () => {
    const f = await analysis();
    reply = () => ({
      body: completion({
        productDescription:
          'A small amber glass bottle with a silver cap and a minimalist label. A young Black woman in her twenties holds it and looks very healthy. The box is matte green.',
      }),
    });
    await send('brief.analyze-image', f.job);
    const job = await terminal('brief_jobs', f.job);
    expect(job['state']).toBe('completed');
    expect(job['result_text']).toBe('A small amber glass bottle with a silver cap and a minimalist label. The box is matte green.');
    for (const word of ['young', 'Black', 'twenties', 'healthy', 'woman']) expect(job['result_text']).not.toContain(word);
    const part = seen[0]?.body['messages'][1].content.find((p: { type: string }) => p.type === 'image_url');
    expect(part.image_url.url).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(JSON.stringify(seen[0]?.body['messages'])).not.toMatch(/https?:/u);
    expect(seen[0]?.body['model']).toBe('local-stub-vision');
    expect(await events(f.job)).toEqual([{ call_seq: 1, outcome: 'succeeded', cost: '0.0100', cost_basis: 'estimate', operation: 'local-stub-vision' }]);
    expect(await reservations(f.job)).toBe(0);
    expect(lines.join('')).not.toContain(KEY);
  });

  it('a malformed answer fails the job temporary and the owner can continue without a description (REQ-006)', async () => {
    const f = await analysis();
    reply = () => ({ raw: 'not json' });
    await send('brief.analyze-image', f.job);
    const job = await terminal('brief_jobs', f.job);
    expect(job['state']).toBe('failed');
    expect(job['cause_class']).toBe('temporary');
    expect(job['result_text']).toBeNull();
  });

  it('401 counts against the key and disables it at the threshold; the job fails configuration', async () => {
    const f = await analysis();
    reply = () => ({ status: 401, body: { error: { code: 'invalid_api_key' } } });
    await send('brief.analyze-image', f.job);
    expect((await terminal('brief_jobs', f.job))['cause_class']).toBe('configuration');
    const second = await analysis();
    await pool.query('update provider_keys set consecutive_auth_failures = 1 where id = $1', [second.keyId]);
    await send('brief.analyze-image', second.job);
    await terminal('brief_jobs', second.job);
    expect((await pool.query('select status from provider_keys where id = $1', [second.keyId])).rows[0].status).toBe('disabled');
    expect((await pool.query(`select kind from key_events where key_id = $1 order by at`, [second.keyId])).rows.map((r) => r.kind)).toEqual(['auth_failed', 'disabled']);
  });

  it('an image that is not ready makes no call', async () => {
    const f = await analysis();
    await pool.query(`update media_objects set state = 'processing' where id = $1`, [f.media]);
    await send('brief.analyze-image', f.job);
    expect((await terminal('brief_jobs', f.job))['state']).toBe('failed');
    expect(seen).toHaveLength(0);
    expect(await events(f.job)).toEqual([]);
  });
});
