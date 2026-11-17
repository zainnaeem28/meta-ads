import 'reflect-metadata';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiApp } from '../../../bootstrap/api.module.js';
import { createWorkerApp } from '../../../bootstrap/worker.module.js';
import type { WorkerApp } from '../../../bootstrap/worker.module.js';
import { runSeed } from '../../../database/seed.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../../platform/db/test-database.js';
import type { TestDatabase } from '../../../platform/db/test-database.js';
import { EGRESS, Egress } from '../../../platform/egress/index.js';
import { startServer } from '../../../platform/egress/test-support.js';
import { installJobs } from '../../../platform/jobs/test-support.js';
import { buildLogger, createHttpLogging } from '../../../platform/logging/index.js';
import { STORAGE_PORT, uploadKey } from '../../media/index.js';
import type { StoragePort } from '../../media/index.js';
import { KEY_WRAP_PORT } from '../../provider-keys/index.js';
import type { KeyWrapPort } from '../../provider-keys/index.js';
import { priceTableSeedStep } from '../../usage/index.js';
import { brandRulesSeedStep } from '../infrastructure/repositories/brand-rules-file.js';

// TASK-051 (brief 4/4) through the real api composition root (`createApiApp`, the one `main.api.ts` runs) with
// `fastify.inject` on real PostgreSQL and a real MinIO server, and the real worker composition root (`createWorkerApp`)
// with a local TLS server in place of api.openai.com: API-024 (draft submit), API-035 and API-036 (image analysis) and
// API-053 (regenerate) create their jobs through SB-D14, the worker's stub provider completes them. TC-INT-*, TC-IDM-*, TC-CAP-*.

const ORIGIN = 'http://localhost:3000';
const KEY = 'integration-openai-secret-0123456789abcdef';
const contractsDir = join(import.meta.dirname, '..', '..', '..', '..', '..', '..', 'packages', 'contracts');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f0005000201a52e5ad90000000049454e44ae426082', 'hex');

interface TestBucket {
  readonly endpoint: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly bucket: string;
  stop(): Promise<void>;
}

async function startTestBucket(bucket = 'app'): Promise<TestBucket> {
  const url = pathToFileURL(join(contractsDir, '..', '..', 'tools', 'foundation-tests', 'media', 'minio.ts')).href;
  const { startMinio } = (await import(/* @vite-ignore */ url)) as { startMinio(): Promise<Omit<TestBucket, 'bucket'>> };
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

const sink = new Writable({ write(_chunk: Buffer, _e, done) { done(); } });
let testDb: TestDatabase;
let pool: pg.Pool;
let minio: TestBucket;
let worker: WorkerApp;
let app: Awaited<ReturnType<typeof createApiApp>>['app'];
let storage: StoragePort;
let wrap: KeyWrapPort;
let stub: Awaited<ReturnType<typeof startServer>>;
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

const calm = (n: number): string =>
  Array.from({ length: n }, (_, i) => (i % 5 === 4 || i === n - 1 ? `calm${String(i)}.` : `calm${String(i)}`)).join(' ');
const completion = (content: unknown) => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content), refusal: null } }] });
let generated = 'first';
interface Seen { model: string }
let seen: Seen[] = [];
const answer = (model: string) =>
  model === 'local-stub-vision'
    ? completion({ productDescription: 'A small amber glass bottle with a silver cap.' })
    : completion({
        segments: [
          { position: 1, dialogue: `${generated} ${calm(32)}`, prompt: 'A calm kitchen' },
          { position: 2, dialogue: `${calm(30)} Adults 21 and over only. Take the free 2-minute quiz`, prompt: 'A morning window' },
        ],
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
      const body = JSON.parse(Buffer.concat(parts).toString() || '{}') as { model: string };
      seen.push({ model: body.model });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer(body.model)));
    });
  });
  minio = await startTestBucket();
  testDb = await createTestDatabase({ label: 'task051', migrations: false });
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
  for (const file of ['0010_task-032-audit.sql', '0020_task-033-identity.sql', '0030_task-039-provider-keys.sql', '0040_task-041-media.sql', '0050_task-044-usage.sql', '0070_task-046-campaigns.sql', '0080_task-048-brief.sql']) {
    for (const statement of tables(file)) await pool.query(statement);
  }
  await installJobs(testDb.url);
  await runSeed({ dataset: 'reference', appEnv: 'development', databaseUrl: testDb.url, steps: [priceTableSeedStep(), brandRulesSeedStep()] });
  const env: Record<string, string | undefined> = {
    KEK_PUBLIC_KEYS: undefined,
    KEK_PRIVATE_KEYS: undefined,
    R2_ENDPOINT: minio.endpoint,
    R2_BUCKET: minio.bucket,
    R2_ACCESS_KEY_ID: minio.accessKey,
    R2_SECRET_ACCESS_KEY: minio.secretKey,
    STORAGE_PUBLIC_ORIGIN: minio.endpoint,
    OPENAI_TEXT_MODEL: 'local-stub-text',
    OPENAI_VISION_MODEL: 'local-stub-vision',
    OWNER_EMAIL: 'owner51@example.test',
    INVITE_EMAIL_DOMAINS: 'example.test',
    CURSOR_SIGNING_KEY: 'k'.repeat(40),
  };
  for (const [name, value] of Object.entries(env)) {
    savedEnv[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
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
      logger: buildLogger({ level: 'silent', destination: sink }).logger,
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
  wrap = worker.context.get<KeyWrapPort>(KEY_WRAP_PORT, { strict: false });
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
  const providers = [...app.get(ModulesContainer, { strict: false }).values()].flatMap((m) => [...m.providers.values()]);
  const found = providers.map((p) => p.instance as Partial<Local> | undefined).find((i) => typeof i?.issueToken === 'function');
  if (found === undefined) throw new Error('local identity provider not found');
  local = found as Local;
  storage = app.get<StoragePort>(STORAGE_PORT, { strict: false });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await worker?.runtime.drain().catch(() => undefined);
  await worker?.context.close().catch(() => undefined);
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await pool?.end();
  await testDb?.drop();
  await minio?.stop();
  await stub?.close();
});

beforeEach(() => {
  seen = [];
  generated = 'first';
});

const fastify = () => app.getHttpAdapter().getInstance();
interface Body { success: boolean; data?: any; error?: { code: string; message: string; details?: any[] }; metaData: any } // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(method: 'GET' | 'POST' | 'PATCH', url: string, token?: string, payload?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
  const res = await fastify().inject({ method, url: `/api/v1${url}`, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: res.statusCode, headers: res.headers, body: (res.body === '' ? { success: true, metaData: {} } : JSON.parse(res.body)) as Body };
}
const post = (url: string, token: string | undefined, key?: string) =>
  call('POST', url, token, undefined, key === undefined ? {} : { 'idempotency-key': key });

async function account(withKey = true, status = 'active') {
  const sub = `user_t51_${String(++seq)}`;
  const email = `s${String(seq)}@example.test`;
  local.addUser(sub, email, true);
  await pool.query(`insert into invitations (id, email, expires_at) values (gen_random_uuid(), $1, now() + interval '1 day')`, [email]);
  const token = local.issueToken({ sub, azp: ORIGIN, fva: [1, 1] });
  expect((await call('GET', '/me', token)).status).toBe(200);
  const id = (await pool.query(`select id from users where idp_subject = $1`, [sub])).rows[0].id as string;
  let keyId: string | null = null;
  if (withKey) {
    keyId = randomUUID();
    const sealed = wrap.seal(Buffer.from(KEY), { userId: id, provider: 'openai', keyId, version: 1 });
    await pool.query(
      `insert into provider_keys (id, owner_id, provider, status, version, ciphertext, nonce, wrapped_dek, kek_version, last4, fingerprint, fingerprint_pepper_version)
       values ($1, $2, 'openai', $3, 1, $4, $5, $6, $7, 'cdef', $8, 1)`,
      [keyId, id, status, sealed.ciphertext, sealed.nonce, sealed.wrappedDek, sealed.kekVersion, 'a'.repeat(64)],
    );
  }
  return { id, token, keyId };
}

const COMPLETE = {
  productName: 'Calm Cap',
  productDescription: 'A slow morning drink',
  audience: { ageMin: 25, ageMax: 40 },
  direction: { goal: 'awareness', segmentCount: 2 },
  concept: 'A slow morning',
};
async function draft(token: string, fields: Record<string, unknown> = COMPLETE): Promise<string> {
  const created = await call('POST', '/drafts', token, fields);
  expect(created.status).toBe(201);
  return created.body.data.id as string;
}

async function image(owner: string, state: 'ready' | 'processing' = 'ready') {
  const id = randomUUID();
  const key = uploadKey(owner, id);
  await storage.put(key, PNG, 'image/png', PNG.length);
  await pool.query(
    `insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, width, height) values ($1, $2, 'upload', $3, $4, $5, 'image/png', 1, 1)`,
    [id, owner, state, key, PNG.length],
  );
  await pool.query(`insert into storage_usage (owner_id, bytes_used) values ($1, $2) on conflict (owner_id) do update set bytes_used = storage_usage.bytes_used + $2`, [owner, PNG.length]);
  return id;
}

async function terminal(id: string): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const deadline = Date.now() + 60_000;
  for (;;) {
    const row = (await pool.query('select * from brief_jobs where id = $1', [id])).rows[0] as Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (row !== undefined && ['completed', 'failed', 'cancelled'].includes(row['state'] as string)) return row;
    if (Date.now() > deadline) throw new Error(`job ${id} stayed ${String(row?.['state'])}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const count = async (table: string, where: string, params: unknown[]) =>
  (await pool.query(`select count(*)::int as n from ${table} where ${where}`, params)).rows[0].n as number;
const reservations = (owner: string) => count('spend_reservations', 'owner_id = $1', [owner]);

describe('API-024 submit', () => {
  const valid = contractValidator('SubmitDraftResponse');

  it('creates the campaign, brief and job in one request; the worker stub completes the job (real entry point)', async () => {
    const a = await account();
    const id = await draft(a.token);
    const res = await post(`/drafts/${id}/submit`, a.token, 'submit-1');
    expect(res.status).toBe(202);
    expect(valid(res.body)).toBe(true);
    const { campaignId, briefJob } = res.body.data as { campaignId: string; briefJob: { id: string; state: string; reused: boolean; label: string } };
    expect(briefJob.reused).toBe(false);
    expect(res.headers['location']).toBe(`/api/v1/campaigns/${campaignId}`);
    expect((await pool.query('select campaign_id from drafts where id = $1', [id])).rows[0].campaign_id).toBe(campaignId);
    const job = (await pool.query('select * from brief_jobs where id = $1', [briefJob.id])).rows[0];
    expect(job.kind).toBe('brief_generation');
    expect(job.campaign_id).toBe(campaignId);
    expect(job.key_id).toBe(a.keyId);
    expect(job.reuse_hash).toMatch(/^[0-9a-f]{64}$/);
    const done = await terminal(briefJob.id);
    expect(done['state']).toBe('completed');
    expect(seen.map((s) => s.model)).toEqual(['local-stub-text']);
    const brief = (await pool.query('select state, generation_seq from briefs where campaign_id = $1', [campaignId])).rows[0];
    expect(brief.state).toBe('draft');
    expect(await count('brief_segments', 'brief_id = (select id from briefs where campaign_id = $1)', [campaignId])).toBe(2);
    expect(await reservations(a.id)).toBe(0);
    const read = await call('GET', `/campaigns/${campaignId}/brief`, a.token);
    expect(read.status).toBe(200);
    expect(read.body.data.generationJob.id).toBe(briefJob.id);
  });

  it('resubmit and lost-response replay create exactly one campaign, one job and one reservation', async () => {
    const a = await account();
    const id = await draft(a.token);
    const first = await post(`/drafts/${id}/submit`, a.token, 'dup-key');
    expect(first.status).toBe(202);
    const lost = await post(`/drafts/${id}/submit`, a.token, 'dup-key');
    const fresh = await post(`/drafts/${id}/submit`, a.token, 'another-key');
    for (const again of [lost, fresh]) {
      expect(again.status).toBe(202);
      expect(valid(again.body)).toBe(true);
      expect(again.body.data.campaignId).toBe(first.body.data.campaignId);
      expect(again.body.data.briefJob.id).toBe(first.body.data.briefJob.id);
      expect(again.body.data.briefJob.reused).toBe(true);
    }
    expect(await count('campaigns', 'owner_id = $1', [a.id])).toBe(1);
    expect(await count('brief_jobs', 'owner_id = $1', [a.id])).toBe(1);
    expect(await count('briefs', 'owner_id = $1', [a.id])).toBe(1);
    expect(await count('spend_reservations', 'owner_id = $1', [a.id]) + (await count('usage_events', 'owner_id = $1', [a.id]))).toBeLessThanOrEqual(1);
    await terminal(first.body.data.briefJob.id);
    // After the job ended a resubmit still returns the stored result, with no second generation.
    const late = await post(`/drafts/${id}/submit`, a.token, 'late-key');
    expect(late.body.data.briefJob.id).toBe(first.body.data.briefJob.id);
    expect(late.body.data.briefJob.state).toBe('completed');
    expect(await count('brief_jobs', 'owner_id = $1', [a.id])).toBe(1);
    expect(seen.filter((s) => s.model === 'local-stub-text')).toHaveLength(1);
  });

  it('concurrent submits with one key and with different keys still make one of each', async () => {
    const a = await account();
    const id = await draft(a.token);
    const results = await Promise.all([
      ...Array.from({ length: 3 }, () => post(`/drafts/${id}/submit`, a.token, 'same')),
      ...Array.from({ length: 3 }, (_, i) => post(`/drafts/${id}/submit`, a.token, `diff-${String(i)}`)),
    ]);
    expect(results.map((r) => r.status)).toEqual([202, 202, 202, 202, 202, 202]);
    expect(new Set(results.map((r) => r.body.data.briefJob.id)).size).toBe(1);
    expect(results.filter((r) => !r.body.data.briefJob.reused)).toHaveLength(1);
    expect(await count('campaigns', 'owner_id = $1', [a.id])).toBe(1);
    expect(await count('brief_jobs', 'owner_id = $1', [a.id])).toBe(1);
  });

  it('the same key for another draft is 409 idempotency_key_reused; a missing key is 400; a stranger gets 404', async () => {
    const a = await account();
    const b = await account();
    const one = await draft(a.token);
    const two = await draft(a.token);
    expect((await post(`/drafts/${one}/submit`, a.token, 'k')).status).toBe(202);
    const clash = await post(`/drafts/${two}/submit`, a.token, 'k');
    expect(clash.status).toBe(409);
    expect(clash.body.error?.code).toBe('idempotency_key_reused');
    expect((await post(`/drafts/${two}/submit`, a.token)).status).toBe(400);
    expect((await post(`/drafts/${two}/submit`, b.token, 'x')).status).toBe(404);
    expect((await post(`/drafts/${randomUUID()}/submit`, a.token, 'y')).status).toBe(404);
    expect((await post(`/drafts/${two}/submit`, undefined, 'z')).status).toBe(401);
    expect(await count('campaigns', 'owner_id = $1', [a.id])).toBe(1);
  });

  it('an incomplete draft is 400 validation_failed with a detail per missing field and creates nothing', async () => {
    const a = await account();
    const id = await draft(a.token, { productName: 'Only a name' });
    const res = await post(`/drafts/${id}/submit`, a.token, 'incomplete');
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_failed');
    expect((res.body.error?.details ?? []).map((d: { field: string }) => d.field)).toEqual(
      expect.arrayContaining(['productDescription', 'audience.ageMin', 'audience.ageMax', 'direction.goal', 'direction.segmentCount', 'concept']),
    );
    expect(await count('campaigns', 'owner_id = $1', [a.id])).toBe(0);
    expect(await count('idempotency_records', 'owner_id = $1', [a.id])).toBe(0);
    expect((await pool.query('select campaign_id from drafts where id = $1', [id])).rows[0].campaign_id).toBeNull();
  });

  it('a missing or disabled key creates no job and names the missing configuration (TC-CAP key checks)', async () => {
    const none = await account(false);
    const off = await account(true, 'disabled');
    for (const [who, code] of [[none, 'key_missing'], [off, 'key_disabled']] as const) {
      const id = await draft(who.token);
      const res = await post(`/drafts/${id}/submit`, who.token, `key-${code}`);
      expect(res.status).toBe(422);
      expect(res.body.error?.code).toBe(code);
      expect(JSON.stringify(res.body.error)).toContain('OpenAI');
      expect(await count('campaigns', 'owner_id = $1', [who.id])).toBe(0);
      expect(await count('brief_jobs', 'owner_id = $1', [who.id])).toBe(0);
      expect(await count('briefs', 'owner_id = $1', [who.id])).toBe(0);
      expect(await reservations(who.id)).toBe(0);
      expect(await count('idempotency_records', 'owner_id = $1', [who.id])).toBe(0);
      expect((await pool.query('select campaign_id from drafts where id = $1', [id])).rows[0].campaign_id).toBeNull();
    }
  });

  it('the spend cap is checked before any job: 422 spend_cap_reached naming the limit, nothing created', async () => {
    const a = await account();
    await pool.query(
      `insert into usage_events (id, owner_id, provider, operation, job_type, job_id, call_seq, outcome, estimated_cost_usd, cost_basis)
       values ($1, $2, 'openai', 'local-stub-text', 'video', $3, 1, 'succeeded', 49.99, 'estimate')`,
      [randomUUID(), a.id, randomUUID()],
    );
    const id = await draft(a.token);
    const res = await post(`/drafts/${id}/submit`, a.token, 'capped');
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('spend_cap_reached');
    expect(JSON.stringify(res.body.error)).toContain('spending limit');
    expect(await count('campaigns', 'owner_id = $1', [a.id])).toBe(0);
    expect(await count('brief_jobs', 'owner_id = $1', [a.id])).toBe(0);
    expect(await reservations(a.id)).toBe(0);
  });

  it('attaches a ready product image and takes its description from the completed analysis; an image still processing is 422 media_not_ready', async () => {
    const a = await account();
    const media = await image(a.id);
    const analysed = await post(`/media/${media}/analysis`, a.token, 'analyse-1');
    expect(analysed.status).toBe(202);
    await terminal(analysed.body.data.job.id);
    const id = await draft(a.token, { ...COMPLETE, productDescription: null, productMediaId: media });
    const res = await post(`/drafts/${id}/submit`, a.token, 'with-image');
    expect(res.status).toBe(202);
    const campaign = (await pool.query('select product_description, product_media_id from campaigns where id = $1', [res.body.data.campaignId])).rows[0];
    expect(campaign.product_description).toBe('A small amber glass bottle with a silver cap.');
    expect(campaign.product_media_id).toBe(media);
    const row = (await pool.query('select campaign_id, attached_at from media_objects where id = $1', [media])).rows[0];
    expect(row.campaign_id).toBe(res.body.data.campaignId);
    expect(row.attached_at).not.toBeNull();

    const slow = await image(a.id);
    const other = await draft(a.token, { ...COMPLETE, productMediaId: slow });
    await pool.query(`update media_objects set state = 'processing' where id = $1`, [slow]);
    const refused = await post(`/drafts/${other}/submit`, a.token, 'slow-image');
    expect(refused.status).toBe(422);
    expect(refused.body.error?.code).toBe('media_not_ready');
    expect(await count('campaigns', 'owner_id = $1', [a.id])).toBe(1);
    expect(await count('briefs', 'owner_id = $1', [a.id])).toBe(1);
  });

  it('without a description and without a completed analysis the draft is incomplete', async () => {
    const a = await account();
    const media = await image(a.id);
    const id = await draft(a.token, { ...COMPLETE, productDescription: null, productMediaId: media });
    const res = await post(`/drafts/${id}/submit`, a.token, 'no-analysis');
    expect(res.status).toBe(400);
    expect((res.body.error?.details ?? []).map((d: { field: string }) => d.field)).toEqual(['productDescription']);
  });
});

describe('API-035 and API-036 image analysis', () => {
  const valid = contractValidator('ImageAnalysisResponse');

  it('starts the analysis, the stub completes it, a repeat reuses it, and GET shows the description', async () => {
    const a = await account();
    const media = await image(a.id);
    const none = await call('GET', `/media/${media}/analysis`, a.token);
    expect(none.status).toBe(200);
    expect(valid(none.body)).toBe(true);
    expect(none.body.data).toEqual({ job: null, productDescription: null });
    const res = await post(`/media/${media}/analysis`, a.token, 'an-1');
    expect(res.status).toBe(202);
    expect(valid(res.body)).toBe(true);
    expect(res.body.data.job.reused).toBe(false);
    const jobId = res.body.data.job.id as string;
    expect((await terminal(jobId))['state']).toBe('completed');
    const read = await call('GET', `/media/${media}/analysis`, a.token);
    expect(valid(read.body)).toBe(true);
    expect(read.body.data.job).toMatchObject({ id: jobId, state: 'completed', reused: false });
    expect(read.body.data.productDescription).toBe('A small amber glass bottle with a silver cap.');
    for (const key of ['an-1', 'an-2']) {
      const again = await post(`/media/${media}/analysis`, a.token, key);
      expect(again.status).toBe(202);
      expect(again.body.data.job).toMatchObject({ id: jobId, reused: true });
    }
    expect(await count('brief_jobs', 'owner_id = $1', [a.id])).toBe(1);
    expect(seen.filter((s) => s.model === 'local-stub-vision')).toHaveLength(1);
  });

  it('refuses an image that is not ready, one that is not mine, no key, a disabled key and the cap', async () => {
    const a = await account();
    const b = await account();
    const processing = await image(a.id, 'processing');
    const refused = await post(`/media/${processing}/analysis`, a.token, 'p');
    expect([refused.status, refused.body.error?.code]).toEqual([422, 'media_not_ready']);
    const mine = await image(a.id);
    expect((await post(`/media/${mine}/analysis`, b.token, 'q')).status).toBe(404);
    expect((await call('GET', `/media/${mine}/analysis`, b.token)).status).toBe(404);
    expect((await post(`/media/${randomUUID()}/analysis`, a.token, 'r')).status).toBe(404);
    expect((await post(`/media/${mine}/analysis`, a.token)).status).toBe(400);
    const none = await account(false);
    const off = await account(true, 'disabled');
    for (const [who, code] of [[none, 'key_missing'], [off, 'key_disabled']] as const) {
      const media = await image(who.id);
      const res = await post(`/media/${media}/analysis`, who.token, `k-${code}`);
      expect([res.status, res.body.error?.code]).toEqual([422, code]);
      expect(await count('brief_jobs', 'owner_id = $1', [who.id])).toBe(0);
      expect(await reservations(who.id)).toBe(0);
    }
    const capped = await account();
    await pool.query(
      `insert into usage_events (id, owner_id, provider, operation, job_type, job_id, call_seq, outcome, estimated_cost_usd, cost_basis)
       values ($1, $2, 'openai', 'local-stub-vision', 'video', $3, 1, 'succeeded', 49.995, 'estimate')`,
      [randomUUID(), capped.id, randomUUID()],
    );
    const cappedMedia = await image(capped.id);
    const over = await post(`/media/${cappedMedia}/analysis`, capped.token, 'cap');
    expect([over.status, over.body.error?.code]).toEqual([422, 'spend_cap_reached']);
    expect(await count('brief_jobs', 'owner_id = $1', [capped.id])).toBe(0);
  });
});

describe('API-053 regenerate', () => {
  const valid = contractValidator('BriefJobResponse');

  async function submitted(a: { id: string; token: string }) {
    const id = await draft(a.token);
    const res = await post(`/drafts/${id}/submit`, a.token, `s-${id}`);
    await terminal(res.body.data.briefJob.id);
    return res.body.data.campaignId as string;
  }

  it('replaces the edits: draft goes to generating with a new job, the stub writes the new text, a replay returns the same job', async () => {
    const a = await account();
    const campaign = await submitted(a);
    const brief = (await call('GET', `/campaigns/${campaign}/brief`, a.token)).body.data;
    await pool.query(`update brief_segments set dialogue = 'my own words', revision = revision + 1 where brief_id = $1 and position = 1`, [brief.id]);
    generated = 'second';
    const res = await post(`/campaigns/${campaign}/brief/regenerate`, a.token, 'regen-1');
    expect(res.status).toBe(202);
    expect(valid(res.body)).toBe(true);
    expect(res.body.data.briefState).toBe('generating');
    expect(res.body.data.job.reused).toBe(false);
    expect((await pool.query('select state, generation_seq from briefs where id = $1', [brief.id])).rows[0]).toMatchObject({ state: 'generating', generation_seq: 2 });
    // The old text stays until the new one is written (SB-D11).
    const replay = await post(`/campaigns/${campaign}/brief/regenerate`, a.token, 'regen-1');
    expect(replay.status).toBe(202);
    expect(replay.body.data.job).toMatchObject({ id: res.body.data.job.id, reused: true });
    await terminal(res.body.data.job.id);
    const after = (await call('GET', `/campaigns/${campaign}/brief`, a.token)).body.data;
    expect(after.state).toBe('draft');
    expect(after.segments[0].dialogue).toContain('second');
    expect(after.segments[0].dialogue).not.toContain('my own words');
    expect(await count('brief_jobs', 'campaign_id = $1', [campaign])).toBe(2);
    expect(await reservations(a.id)).toBe(0);
  });

  it('an accepted brief goes back to generating; one already generating is 409 state_conflict', async () => {
    const a = await account();
    const campaign = await submitted(a);
    await pool.query(`update briefs set state = 'accepted', accepted_at = now() where campaign_id = $1`, [campaign]);
    const res = await post(`/campaigns/${campaign}/brief/regenerate`, a.token, 'regen-acc');
    expect(res.status).toBe(202);
    await terminal(res.body.data.job.id);
    await pool.query(`update briefs set state = 'generating' where campaign_id = $1`, [campaign]);
    const busy = await post(`/campaigns/${campaign}/brief/regenerate`, a.token, 'regen-busy');
    expect([busy.status, busy.body.error?.code]).toEqual([409, 'state_conflict']);
    expect(await count('brief_jobs', 'campaign_id = $1', [campaign])).toBe(2);
    expect((await pool.query(`select accepted_at from briefs where campaign_id = $1`, [campaign])).rows[0].accepted_at).toBeNull();
  });

  it('refuses without a key, with a disabled key and over the cap, leaving the brief as it was; 404 for a stranger', async () => {
    const a = await account();
    const b = await account();
    const campaign = await submitted(a);
    expect((await post(`/campaigns/${campaign}/brief/regenerate`, b.token, 'x')).status).toBe(404);
    expect((await post(`/campaigns/${randomUUID()}/brief/regenerate`, a.token, 'y')).status).toBe(404);
    expect((await post(`/campaigns/${campaign}/brief/regenerate`, a.token)).status).toBe(400);
    await pool.query(`update provider_keys set status = 'disabled' where owner_id = $1`, [a.id]);
    const off = await post(`/campaigns/${campaign}/brief/regenerate`, a.token, 'z');
    expect([off.status, off.body.error?.code]).toEqual([422, 'key_disabled']);
    await pool.query(`delete from provider_keys where owner_id = $1`, [a.id]);
    const none = await post(`/campaigns/${campaign}/brief/regenerate`, a.token, 'w');
    expect([none.status, none.body.error?.code]).toEqual([422, 'key_missing']);
    expect((await pool.query(`select state, generation_seq from briefs where campaign_id = $1`, [campaign])).rows[0]).toMatchObject({ state: 'draft', generation_seq: 1 });
    expect(await count('brief_jobs', 'campaign_id = $1', [campaign])).toBe(1);
    const capped = await account();
    const cappedCampaign = await submitted(capped);
    await pool.query(
      `insert into usage_events (id, owner_id, provider, operation, job_type, job_id, call_seq, outcome, estimated_cost_usd, cost_basis)
       values ($1, $2, 'openai', 'local-stub-text', 'video', $3, 1, 'succeeded', 49.99, 'estimate')`,
      [randomUUID(), capped.id, randomUUID()],
    );
    const over = await post(`/campaigns/${cappedCampaign}/brief/regenerate`, capped.token, 'cap');
    expect([over.status, over.body.error?.code]).toEqual([422, 'spend_cap_reached']);
    expect((await pool.query(`select state from briefs where campaign_id = $1`, [cappedCampaign])).rows[0].state).toBe('draft');
    expect(await count('brief_jobs', 'campaign_id = $1', [cappedCampaign])).toBe(1);
  });
});
