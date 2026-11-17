/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles; prettier reflow detached the per-line directives (AIU-256) */
import 'reflect-metadata';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorkerApp } from '../../../bootstrap/worker.module.js';
import type { WorkerApp } from '../../../bootstrap/worker.module.js';
import { runSeed } from '../../../database/seed.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../../platform/db/test-database.js';
import type { TestDatabase } from '../../../platform/db/test-database.js';
import { EGRESS, Egress } from '../../../platform/egress/index.js';
import { startServer } from '../../../platform/egress/test-support.js';
import { createRuntimeBoss, startRuntimeBoss } from '../../../platform/jobs/boss.js';
import { installJobs } from '../../../platform/jobs/test-support.js';
import { buildLogger } from '../../../platform/logging/index.js';
import { STORAGE_PORT } from '../../media/index.js';
import type { StoragePort } from '../../media/index.js';
import { KEY_WRAP_PORT } from '../../provider-keys/index.js';
import type { KeyWrapPort } from '../../provider-keys/index.js';
import { priceTableSeedStep } from '../../usage/index.js';

// TASK-057 (production 6/6) through the real worker composition root (`createWorkerApp`, the one `main.worker.ts` runs) on
// real PostgreSQL and an in-process S3 stand-in, with a local TLS server standing in for api.openai.com (the real one is
// never called): `production.thumbstopper-submit`, the image stored privately, the cost recorded from the price table, the
// refusal causes (credit, key, provider fault, not an image) and the recovery sweep's thumbstopper hooks. TC-THM-05, 06, 07.

const OPENAI_KEY = 'integration-openai-secret-0123456789abcdef';
const API_HOST = 'api.openai.com';
const IMAGE_MODEL = 'local-stub-image';
const CALLOUT = 'Mellow mornings';

interface TestBucket {
  readonly endpoint: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly bucket: string;
  stop(): Promise<void>;
}

/**
 * An in-process S3 stand-in (path-style, plain http) with the few calls the storage adapter makes: conditional put, get,
 * delete, batch delete and list. The clip objects this suite checks are the worker's own writes and deletes, so no MinIO
 * binary (and its free-disk requirement) is needed; the adapter itself is proven against MinIO by s3-storage.integration.test.ts.
 */
async function startTestBucket(bucket = 'app'): Promise<TestBucket> {
  const objects = new Map<string, { body: Buffer; type: string; at: Date }>();
  const xml = (res: ServerResponse, status: number, body: string): void => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/xml');
    res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
  };
  const error = (res: ServerResponse, status: number, code: string): void =>
    xml(res, status, `<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      if (key === '' && req.method === 'GET') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const listed = [...objects.entries()]
          .filter(([name]) => name.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b));
        const contents = listed
          .map(
            ([name, o]) =>
              `<Contents><Key>${name}</Key><Size>${String(o.body.length)}</Size><LastModified>${o.at.toISOString()}</LastModified></Contents>`,
          )
          .join('');
        return xml(
          res,
          200,
          `<ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${String(listed.length)}</KeyCount><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        );
      }
      if (key === '' && req.method === 'POST' && url.searchParams.has('delete')) {
        for (const match of body.toString().matchAll(/<Key>([^<]+)<\/Key>/g))
          objects.delete(match[1] as string);
        return xml(res, 200, '<DeleteResult></DeleteResult>');
      }
      if (req.method === 'PUT') {
        if (req.headers['if-none-match'] === '*' && objects.has(key))
          return error(res, 412, 'PreconditionFailed');
        objects.set(key, { body, type: String(req.headers['content-type'] ?? ''), at: new Date() });
        res.setHeader('etag', '"stub"');
        res.statusCode = 200;
        return res.end();
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const found = objects.get(key);
        if (found === undefined) return error(res, 404, 'NoSuchKey');
        res.setHeader('content-type', found.type);
        res.setHeader('content-length', String(found.body.length));
        res.statusCode = 200;
        return res.end(req.method === 'HEAD' ? undefined : found.body);
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        res.statusCode = 204;
        return res.end();
      }
      return error(res, 400, 'BadRequest');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: `http://127.0.0.1:${String(port)}`,
    accessKey: 'stub-access',
    secretKey: 'stub-secret',
    bucket,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const lines: string[] = [];
const sink = new Writable({
  write(chunk: Buffer, _e, done) {
    lines.push(chunk.toString());
    done();
  },
});

let testDb: TestDatabase;
let pool: pg.Pool;
let minio: TestBucket;
let worker: WorkerApp;
let apiBoss: PgBoss;
let storage: StoragePort;
let wrap: KeyWrapPort;
let stub: Awaited<ReturnType<typeof startServer>>;

/** A small PNG: the signature, then filler. */
const png = (): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 9),
  ]);

interface Call {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
}
let calls: Call[] = [];
interface Behaviour {
  /** The image answer: a status, and for a 200 the bytes the provider returns (a PNG by default). */
  image: () => { status?: number; bytes?: Buffer; errorCode?: string; hang?: boolean };
}
let behaviour: Behaviour;
const defaults = (): Behaviour => ({ image: () => ({ bytes: png() }) });
const images = (): Call[] => calls.filter((c) => c.url === '/v1/images/generations');

function kekMaps() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicExponent: 0x10001,
  });
  return {
    KEK_PUBLIC_KEYS: JSON.stringify({
      1: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }),
    KEK_PRIVATE_KEYS: JSON.stringify({
      1: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }),
    KEK_ACTIVE_VERSION: '1',
  };
}

function egressModule(): DynamicModule {
  @Module({})
  class StubEgress {}
  const egress = new Egress({
    allowedHosts: { wavespeed: [API_HOST], openai: [API_HOST] },
    timeoutMs: 2500,
    maxBytes: 5_000_000,
    resolver: async () => ['127.0.0.1'],
    testing: {
      isBlockedAddress: (address) => address !== '127.0.0.1',
      tls: { ca: stub.ca },
      port: stub.port,
    },
  });
  return {
    module: StubEgress,
    providers: [{ provide: EGRESS, useValue: egress }],
    exports: [EGRESS],
  };
}

const baseEnv = () => ({
  ...kekMaps(),
  R2_ENDPOINT: minio.endpoint,
  R2_BUCKET: minio.bucket,
  R2_ACCESS_KEY_ID: minio.accessKey,
  R2_SECRET_ACCESS_KEY: minio.secretKey,
  MEDIA_MAX_PIXEL_DIMENSION: '300',
  MEDIA_MAX_PIXELS: '40000',
  MEDIA_UNATTACHED_TTL_HOURS: '24',
  KEY_AUTO_DISABLE_THRESHOLD: '2',
  OPENAI_IMAGE_MODEL: IMAGE_MODEL,
  POLL_INTERVAL_SEC: '2',
  POLL_LEASE_SEC: '5',
  SUBMIT_ORPHAN_AFTER_SEC: '60',
  PROVIDER_OUTPUT_COPY_WINDOW_HOURS: '1',
  PROVIDER_OUTPUT_MAX_BYTES: '20000',
});

const workerConfig = () => ({
  DATABASE_URL: testDb.url,
  DATABASE_POOL_MAX: 8,
  DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
  WORKER_WATCHDOG_SECONDS: 180,
  WORKER_DRAIN_SECONDS: 5,
  WORKER_CONCURRENCY_PROVIDER: 4,
  WORKER_CONCURRENCY_SANITIZE: 1,
  WORKER_CONCURRENCY_DELETION: 1,
});

beforeAll(async () => {
  stub = await startServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      calls.push({
        method: req.method ?? '',
        url,
        auth: req.headers['authorization'],
        body: Buffer.concat(parts).toString('latin1'),
      });
      const json = (status: number, payload: unknown): void => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'POST' && url === '/v1/images/generations') {
        const answer = behaviour.image();
        if (answer.hang === true) return;
        const status = answer.status ?? 200;
        return json(
          status,
          status < 300
            ? { data: [{ b64_json: (answer.bytes ?? png()).toString('base64') }] }
            : { error: { code: answer.errorCode ?? 'server_error' } },
        );
      }
      res.statusCode = 404;
      res.end();
    });
  });
  minio = await startTestBucket();
  testDb = await createTestDatabase({ label: 'task057wrk', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 6 });
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  for (const file of [
    '0010_task-032-audit.sql',
    '0020_task-033-identity.sql',
    '0030_task-039-provider-keys.sql',
    '0040_task-041-media.sql',
    '0050_task-044-usage.sql',
    '0070_task-046-campaigns.sql',
    '0080_task-048-brief.sql',
    '0090_task-052-production-video.sql',
    '0100_task-055-production-assembly.sql',
    '0110_task-057-production-thumbstopper.sql',
  ]) {
    const tables = readFileSync(join(REAL_MIGRATIONS, file), 'utf8').split('-- Grants')[0] ?? '';
    for (const statement of tables.split('--> statement-breakpoint')) {
      const sql = statement
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim();
      if (sql !== '') await pool.query(sql);
    }
  }
  await installJobs(testDb.url);
  await runSeed({
    dataset: 'reference',
    appEnv: 'development',
    databaseUrl: testDb.url,
    steps: [priceTableSeedStep()],
  });
  const stream = buildLogger({ level: 'debug', destination: sink });
  worker = await createWorkerApp(workerConfig(), {
    logger: stream.logger,
    egress: egressModule(),
    wavespeedBaseUrl: `https://${API_HOST}:${String(stub.port)}`,
    env: baseEnv(),
    exit: () => undefined,
  });
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
  calls = [];
  behaviour = defaults();
});

interface Fixture {
  owner: string;
  campaign: string;
  job: string;
  keyId: string;
}
interface Options {
  openAiKey?: 'active' | 'none' | 'disabled';
  /** The job's key stamp: `current` (default), `replaced` (a newer version exists), or none at all. */
  stamp?: 'current' | 'replaced' | 'none';
  state?: string;
  submittingAt?: string;
  createdAt?: string;
  deadlineAt?: string;
  callCount?: number;
  campaignState?: string;
  sameOwner?: { owner: string; keyId: string };
}

/** A campaign with its OpenAI key and a thumbstopper job with its reservation (what API-075 leaves behind). */
async function thumbJob(opts: Options = {}): Promise<Fixture> {
  const owner = opts.sameOwner?.owner ?? randomUUID();
  const keyId = opts.sameOwner?.keyId ?? randomUUID();
  if (opts.sameOwner === undefined) {
    await pool.query(
      `insert into users (id, idp_subject, email, linked_via) values ($1, $2, $3, 'first_admin')`,
      [owner, `sub_${owner.slice(0, 20)}`, `${owner.slice(0, 12)}@example.test`],
    );
    if (opts.openAiKey !== 'none') {
      const version = opts.stamp === 'replaced' ? 2 : 1;
      const sealed = wrap.seal(Buffer.from(OPENAI_KEY), {
        userId: owner,
        provider: 'openai',
        keyId,
        version,
      });
      await pool.query(
        `insert into provider_keys (id, owner_id, provider, status, version, ciphertext, nonce, wrapped_dek, kek_version, last4, fingerprint, fingerprint_pepper_version)
         values ($1, $2, 'openai', $3, $4, $5, $6, $7, $8, 'cdef', $9, 1)`,
        [
          keyId,
          owner,
          opts.openAiKey === 'disabled' ? 'disabled' : 'active',
          version,
          sealed.ciphertext,
          sealed.nonce,
          sealed.wrappedDek,
          sealed.kekVersion,
          'c'.repeat(64),
        ],
      );
    }
  }
  const campaign = randomUUID();
  await pool.query(
    `insert into campaigns (id, owner_id, product_name, product_description, segment_count, state) values ($1, $2, 'Calm Cap', 'A slow morning drink', 2, $3)`,
    [campaign, owner, opts.campaignState ?? 'active'],
  );
  const job = randomUUID();
  const at = (offset: string | undefined, fallback: string): string =>
    `now() + interval '${offset ?? fallback}'`;
  const stamped = opts.stamp !== 'none' && opts.openAiKey !== 'none';
  await pool.query(
    `insert into thumbstopper_jobs (id, owner_id, campaign_id, callout_text, provider_model, state, reuse_hash, key_id, key_version, call_count, submitting_at, deadline_at, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${opts.submittingAt === undefined ? 'null' : at(opts.submittingAt, '0 seconds')}, ${at(opts.deadlineAt, '5 minutes')}, ${at(opts.createdAt, '0 seconds')})`,
    [
      job,
      owner,
      campaign,
      CALLOUT,
      IMAGE_MODEL,
      opts.state ?? 'pending',
      randomBytes(32).toString('hex'),
      stamped ? keyId : null,
      stamped ? 1 : null,
      opts.callCount ?? 0,
    ],
  );
  await pool.query(
    `insert into spend_reservations (id, owner_id, job_type, job_id, estimated_cost_usd, remaining_calls) values ($1, $2, 'thumbstopper', $3, 0.04, 1)`,
    [randomUUID(), owner, job],
  );
  return { owner, campaign, job, keyId };
}

const jobRow = async (id: string): Promise<Record<string, any>> =>
  (await pool.query('select * from thumbstopper_jobs where id = $1', [id])).rows[0] as Record<
    string,
    any
  >;
async function untilJob(
  id: string,
  done: (row: Record<string, any>) => boolean,
  what: string,
  ms = 60_000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const row = await jobRow(id);
    if (done(row)) return row;
    if (Date.now() > deadline)
      throw new Error(
        `thumbstopper job ${id}: ${what}; stayed ${String(row['state'])} (${String(row['last_error_code'])})`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const finished = (id: string) =>
  untilJob(
    id,
    (row) => ['completed', 'failed', 'cancelled'].includes(row['state'] as string),
    'did not finish',
  );
const events = async (jobId: string) =>
  (
    await pool.query(
      `select call_seq, outcome, cost_basis, provider, operation, estimated_cost_usd::float as cost from usage_events where job_type = 'thumbstopper' and job_id = $1 order by call_seq`,
      [jobId],
    )
  ).rows as Record<string, any>[];
const reservationCount = async (jobId: string) =>
  (
    await pool.query(
      `select 1 from spend_reservations where job_type = 'thumbstopper' and job_id = $1`,
      [jobId],
    )
  ).rowCount;
const send = (job: string) => apiBoss.send('production.thumbstopper-submit', { jobId: job });
async function sweepNow(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const before = lines.filter((line) => line.includes('recovery sweep finished')).length;
    await worker.runtime.sweep();
    if (lines.filter((line) => line.includes('recovery sweep finished')).length > before) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the recovery sweep never ran');
}
const logText = (): string => lines.join('\n');
const mediaRows = async (owner: string) =>
  (
    await pool.query(
      `select id::text, kind, state, storage_key, bytes, content_type, campaign_id::text from media_objects where owner_id = $1`,
      [owner],
    )
  ).rows;

describe('production.thumbstopper-submit, through the worker process', () => {
  it("makes the image with the owner's key, stores it privately and records its cost from the price table (TC-THM-05, 06, 07)", async () => {
    const f = await thumbJob();
    await send(f.job);
    const row = await untilJob(f.job, (r) => r['state'] === 'completed', 'did not complete');
    expect(row).toMatchObject({ call_count: 1, cause_class: null, output_media_id: f.job });
    const sent = images();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.auth).toBe(`Bearer ${OPENAI_KEY}`);
    const request = JSON.parse(sent[0]?.body ?? '{}') as {
      model: string;
      prompt: string;
      n: number;
      size: string;
    };
    expect(request).toMatchObject({ model: IMAGE_MODEL, n: 1, size: '1024x1536' });
    expect(request.prompt).toContain(`"${CALLOUT}"`);
    // Stored under the owner's campaign prefix, private (no public URL: only a signed one reads it), registered as ready media.
    const key = `u/${f.owner}/c/${f.campaign}/thumbstopper/${f.job}.png`;
    const stored = await storage.get(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stored) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(png())).toBe(true);
    expect(await mediaRows(f.owner)).toEqual([
      expect.objectContaining({
        id: f.job,
        kind: 'thumbstopper',
        state: 'ready',
        storage_key: key,
        bytes: String(png().length),
        content_type: 'image/png',
        campaign_id: f.campaign,
      }),
    ]);
    expect(await events(f.job)).toEqual([
      expect.objectContaining({
        call_seq: 1,
        outcome: 'succeeded',
        provider: 'openai',
        operation: IMAGE_MODEL,
        cost_basis: 'estimate',
        cost: 0.04,
      }),
    ]);
    expect(await reservationCount(f.job)).toBe(0);
    expect(logText()).not.toContain(OPENAI_KEY);
  });

  it('fails with an actionable message and records zero usage when the account has no credit (TC-THM-05)', async () => {
    behaviour.image = () => ({ status: 402 });
    const f = await thumbJob();
    await send(f.job);
    const row = await finished(f.job);
    expect(row).toMatchObject({
      state: 'failed',
      cause_class: 'credit',
      cause_message: 'Your OpenAI account has no credit left. Add credit, then try again.',
      call_count: 1,
      output_media_id: null,
    });
    expect(await events(f.job)).toEqual([
      expect.objectContaining({ outcome: 'rejected', cost_basis: 'zero_rejected', cost: 0 }),
    ]);
    expect(await reservationCount(f.job)).toBe(0);
    expect(await mediaRows(f.owner)).toEqual([]);
  });

  it('a 401 fails the job as a key configuration fault, recorded at zero, and counts toward disabling the key', async () => {
    behaviour.image = () => ({ status: 401 });
    const f = await thumbJob();
    await send(f.job);
    expect(await finished(f.job)).toMatchObject({
      state: 'failed',
      cause_class: 'configuration',
      cause_message:
        'OpenAI did not accept the request. Check your key in Settings, then try again.',
    });
    expect(await events(f.job)).toEqual([
      expect.objectContaining({ outcome: 'rejected', cost_basis: 'zero_rejected' }),
    ]);
    const key = (
      await pool.query(`select consecutive_auth_failures from provider_keys where id = $1`, [
        f.keyId,
      ])
    ).rows[0];
    expect(key.consecutive_auth_failures).toBe(1);
  });

  it('a provider fault leaves the estimate counted as unconfirmed and is never retried (TC-THM-05)', async () => {
    behaviour.image = () => ({ status: 500 });
    const f = await thumbJob();
    await send(f.job);
    const row = await finished(f.job);
    expect(row).toMatchObject({
      state: 'failed',
      cause_class: 'outcome_unknown',
      cause_message: 'The image could not be made. Check your OpenAI account before trying again.',
      call_count: 1,
    });
    expect(await events(f.job)).toEqual([
      expect.objectContaining({ outcome: 'unconfirmed', cost_basis: 'unconfirmed_estimate' }),
    ]);
    expect(await reservationCount(f.job)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(images()).toHaveLength(1);
  });

  it('stores nothing when the answer is not an image of an allowed type, and the billed call stays recorded (TC-THM-06)', async () => {
    behaviour.image = () => ({ bytes: Buffer.from('<html><script>alert(1)</script></html>') });
    const f = await thumbJob();
    await send(f.job);
    const row = await finished(f.job);
    expect(row).toMatchObject({
      state: 'failed',
      cause_class: 'output_unreachable',
      last_error_code: 'invalid_response',
      output_media_id: null,
    });
    expect(await events(f.job)).toEqual([expect.objectContaining({ outcome: 'succeeded' })]);
    expect(await mediaRows(f.owner)).toEqual([]);
    expect((await storage.list(`u/${f.owner}/`)).objects).toEqual([]);
  });

  it('refuses an image over the size cap the same way', async () => {
    behaviour.image = () => ({ bytes: Buffer.concat([png(), Buffer.alloc(25_000)]) });
    const f = await thumbJob();
    await send(f.job);
    expect(await finished(f.job)).toMatchObject({
      state: 'failed',
      last_error_code: 'invalid_response',
    });
    expect((await storage.list(`u/${f.owner}/`)).objects).toEqual([]);
  });

  it('fails with the key to fix and makes no call when the key is missing, disabled, replaced or not stamped (TC-KEY)', async () => {
    const cases: [Options, string, string][] = [
      [
        { openAiKey: 'none' },
        'key_deleted',
        'The OpenAI key this image used was removed. Add a key in Settings, then try again.',
      ],
      [
        { openAiKey: 'disabled' },
        'configuration',
        'Your OpenAI key is disabled. Enter it again in Settings, then try again.',
      ],
      [
        { stamp: 'replaced' },
        'key_replaced',
        'Your OpenAI key was replaced while this image waited. Try again.',
      ],
      [
        { stamp: 'none' },
        'key_deleted',
        'The OpenAI key this image used was removed. Add a key in Settings, then try again.',
      ],
    ];
    for (const [opts, cause, message] of cases) {
      const f = await thumbJob(opts);
      await send(f.job);
      const row = await finished(f.job);
      expect([row['state'], row['cause_class'], row['cause_message'], row['call_count']]).toEqual([
        'failed',
        cause,
        message,
        0,
      ]);
      expect(await reservationCount(f.job)).toBe(0);
      expect(await events(f.job)).toEqual([]);
    }
    expect(images()).toHaveLength(0);
  });

  it('does nothing for a job of a campaign that is going away, and for a job that is finished or cancelled', async () => {
    const deleting = await thumbJob({ campaignState: 'deleting' });
    const cancelled = await thumbJob({ state: 'cancelled' });
    await send(deleting.job);
    await send(cancelled.job);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await jobRow(deleting.job)).toMatchObject({ state: 'pending', call_count: 0 });
    expect(await jobRow(cancelled.job)).toMatchObject({ state: 'cancelled', call_count: 0 });
    expect(images()).toHaveLength(0);
  });

  it('makes one call when the same message is delivered twice', async () => {
    const f = await thumbJob();
    await Promise.all([send(f.job), send(f.job)]);
    await finished(f.job);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(images()).toHaveLength(1);
    expect(await events(f.job)).toHaveLength(1);
  });
});

describe('the thumbstopper recovery sweep', () => {
  it('settles a job that lost its answer as failed outcome_unknown, keeping the estimate counted, and releases the reservation', async () => {
    const f = await thumbJob({ state: 'submitting', submittingAt: '-120 seconds', callCount: 1 });
    await sweepNow();
    await untilJob(f.job, (r) => r['state'] === 'failed', 'was not settled');
    expect(await jobRow(f.job)).toMatchObject({
      cause_class: 'outcome_unknown',
      last_error_code: 'outcome_unknown',
    });
    expect(await events(f.job)).toEqual([
      expect.objectContaining({ outcome: 'unconfirmed', operation: IMAGE_MODEL }),
    ]);
    expect(await reservationCount(f.job)).toBe(0);
    expect(images()).toHaveLength(0);
  });

  it('settles a job that never started before its deadline as failed, with no usage event', async () => {
    const f = await thumbJob({ deadlineAt: '-1 minute', createdAt: '-6 minutes' });
    await sweepNow();
    await untilJob(f.job, (r) => r['state'] === 'failed', 'was not settled');
    expect(await jobRow(f.job)).toMatchObject({ cause_class: 'provider_timeout' });
    expect(await events(f.job)).toEqual([]);
    expect(await reservationCount(f.job)).toBe(0);
  });

  it('queues a pending job whose message was lost, and the job then completes', async () => {
    const f = await thumbJob({ createdAt: '-5 minutes' });
    await sweepNow();
    await untilJob(f.job, (r) => r['state'] === 'completed', 'was not requeued');
    expect(images()).toHaveLength(1);
  });
});
