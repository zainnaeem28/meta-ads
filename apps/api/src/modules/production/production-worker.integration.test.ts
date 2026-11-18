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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorkerApp } from '../../bootstrap/worker.module.js';
import type { WorkerApp } from '../../bootstrap/worker.module.js';
import { runSeed } from '../../database/seed.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../platform/db/test-database.js';
import type { TestDatabase } from '../../platform/db/test-database.js';
import { EGRESS, Egress } from '../../platform/egress/index.js';
import { startServer } from '../../platform/egress/test-support.js';
import { createRuntimeBoss, startRuntimeBoss } from '../../platform/jobs/boss.js';
import { installJobs, stopPeriodicSweep } from '../../platform/jobs/test-support.js';
import { buildLogger } from '../../platform/logging/index.js';
import { STORAGE_PORT } from '../media/index.js';
import type { StoragePort } from '../media/index.js';
import { KEY_WRAP_PORT } from '../provider-keys/index.js';
import type { KeyWrapPort } from '../provider-keys/index.js';
import { priceTableSeedStep } from '../usage/index.js';

// TASK-053 (production 2/6) through the real worker composition root (`createWorkerApp`, the one `main.worker.ts` runs) on
// real PostgreSQL and an in-process S3 stand-in, with a local TLS server standing in for api.wavespeed.ai and its output host
// (the real ones are never called): `production.video-submit`, `production.poll`, `video.copy-output` and the hourly
// `production.provider-copy-cleanup` handled by the worker process, the recovery sweep's hooks, the key opened by key ID in
// the worker only. TC-CLP-06, TC-PCA-01..06, 08, 10, TC-EGR (output fetch), TC-KEY-06.

const KEY = 'integration-wavespeed-secret-0123456789abcdef';
const MODEL = 'bytedance/seedance-2.0/image-to-video';
/** The stub answers for both names: the certificate of the egress test support covers these hosts. */
const API_HOST = 'api.openai.com';
const CDN_HOST = 'cdn.example.net';
const OUTPUT_LIMIT = 20_000;

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

/** A small MP4: a size field, `ftyp`, a brand, then filler. */
const mp4 = (extra = 2000): Buffer =>
  Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12 + extra, 7)]);

interface Call {
  method: string;
  url: string;
  auth: string | undefined;
  body: Record<string, any>;
}
let calls: Call[] = [];
interface Behaviour {
  /** The answer to a submit. */
  submit: (n: number) => { status?: number; body?: unknown; hang?: boolean };
  /** The task state a status read reports. */
  state: (taskId: string) => {
    status: string;
    outputPath?: string;
    outputHost?: string;
    error?: string;
    http?: number;
  };
  /** How long the output route waits before it answers, ms. */
  fileDelayMs: number;
}
let behaviour: Behaviour;
const defaults = (): Behaviour => ({
  submit: (n) => ({
    body: { code: 200, message: 'success', data: { id: `task-${String(n)}`, status: 'created' } },
  }),
  state: () => ({ status: 'completed', outputPath: '/files/clip.mp4' }),
  fileDelayMs: 0,
});
const statusReads = (taskId: string): number =>
  calls.filter((c) => c.method === 'GET' && c.url === `/api/v3/predictions/${taskId}/result`)
    .length;
const submits = (): Call[] =>
  calls.filter((c) => c.method === 'POST' && c.url.startsWith(`/api/v3/${MODEL}`));
const deletes = (): Call[] => calls.filter((c) => c.url === '/api/v3/predictions/delete');

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

/** Resolves the stand-in names to the local server and `private.example.com` to a private address the client must refuse. */
function egressModule(): DynamicModule {
  @Module({})
  class StubEgress {}
  const egress = new Egress({
    allowedHosts: { wavespeed: [API_HOST, CDN_HOST, 'private.example.com', 'other.example.com'] },
    timeoutMs: 2500,
    maxBytes: 5_000_000,
    resolver: async (host) => [host === 'private.example.com' ? '10.0.0.5' : '127.0.0.1'],
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
  POLL_INTERVAL_SEC: '2',
  POLL_LEASE_SEC: '5',
  SUBMIT_ORPHAN_AFTER_SEC: '60',
  PROVIDER_OUTPUT_COPY_WINDOW_HOURS: '1',
  PROVIDER_OUTPUT_MAX_BYTES: String(OUTPUT_LIMIT),
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
      const text = Buffer.concat(parts).toString();
      const url = req.url ?? '';
      calls.push({
        method: req.method ?? '',
        url,
        auth: req.headers['authorization'],
        body: text === '' ? {} : (JSON.parse(text) as Record<string, any>),
      });
      const json = (status: number, body: unknown): void => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST' && url.startsWith('/api/v3/predictions/delete'))
        return json(200, { code: 200, message: 'success' });
      if (req.method === 'POST' && url.startsWith('/api/v3/')) {
        const answer = behaviour.submit(submits().length);
        if (answer.hang === true) return;
        return json(answer.status ?? 200, answer.body ?? {});
      }
      const read = /^\/api\/v3\/predictions\/([^/]+)\/result$/.exec(url);
      if (req.method === 'GET' && read !== null) {
        const taskId = read[1] as string;
        const state = behaviour.state(taskId);
        if (state.http !== undefined)
          return json(state.http, { code: state.http, message: 'no such task' });
        const outputs =
          state.outputPath === undefined
            ? []
            : [`https://${state.outputHost ?? CDN_HOST}:${String(stub.port)}${state.outputPath}`];
        return json(200, {
          code: 200,
          data: { id: taskId, status: state.status, outputs, error: state.error ?? '' },
        });
      }
      if (url.startsWith('/files/')) {
        setTimeout(() => {
          if (url === '/files/redirect.mp4') {
            res.statusCode = 302;
            res.setHeader(
              'location',
              `https://other.example.com:${String(stub.port)}/files/clip.mp4`,
            );
            return res.end();
          }
          if (url === '/files/page.html') {
            res.setHeader('content-type', 'text/html');
            return res.end(Buffer.concat([Buffer.from('<html>'), Buffer.alloc(100, 65)]));
          }
          if (url === '/files/huge.mp4') {
            res.setHeader('content-type', 'video/mp4');
            return res.end(mp4(OUTPUT_LIMIT * 2));
          }
          if (url === '/files/broken.mp4') {
            res.statusCode = 500;
            return res.end('down');
          }
          res.setHeader('content-type', 'video/mp4');
          return res.end(mp4());
        }, behaviour.fileDelayMs);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  minio = await startTestBucket();
  // The roles of M0001 do not exist on the shared test server, so each migration's tables are applied as written (the
  // grants are proven by the migration suites) and the test connects as the database owner.
  testDb = await createTestDatabase({ label: 'task053', migrations: false });
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
  // The every-minute cron sweep and the start-up sweep would re-arm polls and read the provider during a test that
  // counts reads: stop the schedule and let the start-up sweep finish, then only `sweepNow()` sweeps.
  await stopPeriodicSweep(testDb.url);
  await sweepNow();
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

// A job a test leaves running would keep polling and add to the next test's provider calls: settle them all.
afterEach(async () => {
  await pool.query(
    `update video_jobs set state = 'cancelled', cause_class = 'cancelled_campaign_deleted' where state in ('pending', 'submitting', 'submitted', 'processing')`,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
});

interface Fixture {
  owner: string;
  keyId: string;
  campaign: string;
  segment: string;
  reference: string | null;
  job: string;
}
interface JobOptions {
  state?: string;
  taskId?: string | null;
  /** SQL for `provider_completed_at`, `deadline_at`, `next_poll_at`, `submitting_at`, `created_at`. */
  completedAt?: string | null;
  deadlineAt?: string;
  nextPollAt?: string | null;
  submittingAt?: string | null;
  createdAt?: string;
  withReference?: boolean;
  keyStatus?: string;
  withKey?: boolean;
  /** Another clip of an owner who already has a key. */
  sameOwner?: { owner: string; keyId: string };
}

/** What the api leaves behind for a clip: owner, key, campaign, brief segment, reference image and a reservation. */
async function clip(opts: JobOptions = {}): Promise<Fixture> {
  const owner = opts.sameOwner?.owner ?? randomUUID();
  const keyId = opts.sameOwner?.keyId ?? randomUUID();
  if (opts.sameOwner === undefined) {
    await pool.query(
      `insert into users (id, idp_subject, email, linked_via) values ($1, $2, $3, 'first_admin')`,
      [owner, `sub_${owner.slice(0, 20)}`, `${owner.slice(0, 12)}@example.test`],
    );
    if (opts.withKey !== false) {
      const sealed = wrap.seal(Buffer.from(KEY), {
        userId: owner,
        provider: 'wavespeed',
        keyId,
        version: 1,
      });
      await pool.query(
        `insert into provider_keys (id, owner_id, provider, status, version, ciphertext, nonce, wrapped_dek, kek_version, last4, fingerprint, fingerprint_pepper_version)
         values ($1, $2, 'wavespeed', $3, 1, $4, $5, $6, $7, 'cdef', $8, 1)`,
        [
          keyId,
          owner,
          opts.keyStatus ?? 'active',
          sealed.ciphertext,
          sealed.nonce,
          sealed.wrappedDek,
          sealed.kekVersion,
          'b'.repeat(64),
        ],
      );
    }
  }
  const campaign = randomUUID();
  const brief = randomUUID();
  const segment = randomUUID();
  await pool.query(
    `insert into campaigns (id, owner_id, product_name, product_description, segment_count) values ($1, $2, 'Calm Cap', 'A slow morning drink', 2)`,
    [campaign, owner],
  );
  await pool.query(
    `insert into briefs (id, campaign_id, owner_id, state) values ($1, $2, $3, 'draft')`,
    [brief, campaign, owner],
  );
  await pool.query(
    `insert into brief_segments (id, brief_id, position, dialogue, prompt, word_count) values ($1, $2, 1, 'A calm start to the day.', 'A bright kitchen at dawn', 6)`,
    [segment, brief],
  );
  let reference: string | null = null;
  if (opts.withReference !== false) {
    reference = randomUUID();
    const key = `u/${owner}/media/${reference}`;
    await storage.put(key, Buffer.from('reference-image-bytes'), 'image/png', 1_000_000);
    await pool.query(
      `insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type) values ($1, $2, 'upload', 'ready', $3, 21, 'image/png')`,
      [reference, owner, key],
    );
  }
  const job = randomUUID();
  const state = opts.state ?? 'pending';
  const at = (value: string | null | undefined, fallback: string | null): string | null =>
    value === undefined ? fallback : value;
  await pool.query(
    `insert into video_jobs (id, owner_id, campaign_id, segment_id, segment_revision, reference_media_id, provider_model, options, state, reuse_hash,
       key_id, key_version, call_count, submitting_at, next_poll_at, deadline_at, provider_completed_at, provider_task_id, created_at)
     values ($1, $2, $3, $4, 1, $5, $6, '{"durationSeconds":15,"resolution":"1080p","aspectRatio":"9:16"}', $7, $8, $9, 1, $10,
       ${at(opts.submittingAt, null) === null ? 'null' : `now() + interval '${opts.submittingAt as string}'`},
       ${at(opts.nextPollAt, null) === null ? 'null' : `now() + interval '${opts.nextPollAt as string}'`},
       now() + interval '${opts.deadlineAt ?? '30 minutes'}',
       ${at(opts.completedAt, null) === null ? 'null' : `now() + interval '${opts.completedAt as string}'`},
       $11, ${opts.createdAt === undefined ? 'now()' : `now() + interval '${opts.createdAt}'`})`,
    [
      job,
      owner,
      campaign,
      segment,
      reference,
      MODEL,
      state,
      randomBytes(32).toString('hex'),
      opts.withKey === false ? null : keyId,
      state === 'pending' ? 0 : 1,
      opts.taskId ?? (state === 'pending' ? null : `task-${job.slice(0, 8)}`),
    ],
  );
  await pool.query(
    `insert into spend_reservations (id, owner_id, job_type, job_id, estimated_cost_usd, remaining_calls) values ($1, $2, 'video', $3, 1.51, 2)`,
    [randomUUID(), owner, job],
  );
  return { owner, keyId, campaign, segment, reference, job };
}

const rowOf = async (id: string): Promise<Record<string, any>> =>
  (await pool.query('select * from video_jobs where id = $1', [id])).rows[0] as Record<string, any>;

async function until(
  id: string,
  done: (row: Record<string, any>) => boolean,
  what: string,
  ms = 60_000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const row = await rowOf(id);
    if (done(row)) return row;
    if (
      row['state'] === 'failed' &&
      !done({ ...row, state: 'failed' }) &&
      Date.now() > deadline - ms + 8000
    )
      throw new Error(
        `job ${id}: ${what}; failed (${String(row['cause_class'])}: ${String(row['cause_message'])}, ${String(row['last_error_code'])})`,
      );
    if (Date.now() > deadline)
      throw new Error(
        `job ${id}: ${what}; stayed ${String(row['state'])} (${String(row['cause_class'])}: ${String(row['cause_message'])}, ${String(row['last_error_code'])})`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const settled = (id: string, what = 'did not settle') =>
  until(id, (row) => ['completed', 'failed', 'cancelled'].includes(row['state'] as string), what);
const events = async (job: string) =>
  (
    await pool.query(
      `select call_seq, outcome, estimated_cost_usd::text as cost, cost_basis, operation from usage_events where job_id = $1 order by call_seq`,
      [job],
    )
  ).rows as Record<string, any>[];
const reservations = async (job: string) =>
  (await pool.query(`select 1 from spend_reservations where job_id = $1`, [job])).rowCount;
/** One whole recovery sweep: a tick that finds another sweep holding the lock does nothing, so it is repeated until one ran. */
async function sweepNow(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const before = lines.filter((line) => line.includes('recovery sweep finished')).length;
    await worker.runtime.sweep();
    if (lines.filter((line) => line.includes('recovery sweep finished')).length > before) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the recovery sweep never ran');
}
const eventually = async (
  read: () => Promise<number | null>,
  expected: number,
  what: string,
): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while ((await read()) !== expected) {
    if (Date.now() > deadline)
      throw new Error(
        `${what}: ${lines
          .filter((line) => line.includes('hook failed'))
          .join('|')
          .slice(0, 800)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};
/** A failed submit turns the row first; its usage event and the release of the reservation commit in the next transaction. */
const bookkept = (job: string): Promise<void> =>
  eventually(() => reservations(job), 0, `the reservation of ${job} was not released`);
const send = (queue: string, job: string, options: Record<string, unknown> = {}) =>
  apiBoss.send(queue, { jobId: job }, options);
const copyJobs = async (job: string) =>
  (
    await pool.query(
      `select 1 from pgboss.job where name = 'video.copy-output' and singleton_key = $1`,
      [job],
    )
  ).rowCount;
const mediaRows = async (campaign: string) =>
  (await pool.query(`select * from media_objects where campaign_id = $1`, [campaign]))
    .rows as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('production.video-submit and the clip, through the worker process', () => {
  it('submits once with the key and a signed reference URL, polls, copies the clip to storage and deletes the provider task', async () => {
    const f = await clip();
    await send('production.video-submit', f.job);
    const job = await until(
      f.job,
      (row) => row['state'] === 'completed' && row['provider_output_deleted_at'] != null,
      'did not complete and delete the provider task',
    );
    expect(job['call_count']).toBe(1);
    expect(job['provider_task_id']).toMatch(/^task-/);
    expect(job['provider_completed_at']).not.toBeNull();
    expect(job['next_poll_at']).toBeNull();
    // one submit; the key is a bearer token, the model path, prompt with the dialogue and the reference as a signed URL
    expect(submits()).toHaveLength(1);
    const sent = submits()[0] as Call;
    expect(sent.auth).toBe(`Bearer ${KEY}`);
    expect(sent.body['prompt']).toContain('A bright kitchen at dawn');
    expect(sent.body['prompt']).toContain('A calm start to the day.');
    expect(sent.body).toMatchObject({ duration: 15, resolution: '1080p', aspect_ratio: '9:16' });
    expect(sent.body['image']).toMatch(/^https?:\/\//);
    expect(sent.body['image']).toContain(`u/${f.owner}/media/${f.reference as string}`);
    // the clip is a registered media row and an object of the campaign's own prefix
    const output = (await mediaRows(f.campaign))[0] as Record<string, any>;
    expect(job['output_media_id']).toBe(output['id']);
    expect(output).toMatchObject({
      kind: 'clip',
      state: 'ready',
      content_type: 'video/mp4',
      owner_id: f.owner,
    });
    expect(output['storage_key']).toBe(
      `u/${f.owner}/c/${f.campaign}/clip/${output['id'] as string}.mp4`,
    );
    const stored: Buffer[] = [];
    for await (const chunk of await storage.get(output['storage_key'] as string))
      stored.push(chunk as Buffer);
    expect(Buffer.concat(stored).equals(mp4())).toBe(true);
    // the provider task is deleted after our copy
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0]?.body).toEqual({ ids: [job['provider_task_id']] });
    expect(job['provider_output_deleted_at']).not.toBeNull();
    // usage: one succeeded event at the estimate; the first-QC part of the reservation is left for the QC run
    expect(await events(f.job)).toEqual([
      {
        call_seq: 1,
        outcome: 'succeeded',
        cost: '1.5000',
        cost_basis: 'estimate',
        operation: MODEL,
      },
    ]);
    expect(
      (
        await pool.query('select remaining_calls from spend_reservations where job_id = $1', [
          f.job,
        ])
      ).rows[0].remaining_calls,
    ).toBe(1);
    // the key, the output URL and the storage key are in no job row and no log line
    expect(JSON.stringify(job)).not.toContain(KEY);
    expect(JSON.stringify(job)).not.toContain(CDN_HOST);
    const payloads = (
      await pool.query(
        `select data::text as data from pgboss.job where name like 'production.%' or name = 'video.copy-output'`,
      )
    ).rows
      .map((r) => r.data as string)
      .join('');
    expect(payloads).not.toContain(KEY);
    expect(payloads).not.toContain(CDN_HOST);
    const logged = lines.join('');
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(CDN_HOST);
    expect(logged).not.toContain('/files/');
  });

  it('a redelivered submit makes no second provider call (TC-CLP-03)', async () => {
    const f = await clip();
    await send('production.video-submit', f.job);
    await send('production.video-submit', f.job);
    await send('production.video-submit', f.job);
    await until(f.job, (row) => row['state'] === 'completed', 'did not complete');
    expect(submits()).toHaveLength(1);
  });

  it('a submit whose answer is lost ends outcome_unknown, converts the estimate and is never repeated (TC-CLP-06)', async () => {
    const f = await clip();
    behaviour.submit = () => ({ hang: true });
    await send('production.video-submit', f.job);
    await settled(f.job);
    await bookkept(f.job);
    const job = await rowOf(f.job);
    expect(job['state']).toBe('failed');
    expect(job['cause_class']).toBe('outcome_unknown');
    expect(job['provider_task_id']).toBeNull();
    expect(submits()).toHaveLength(1);
    expect(await events(f.job)).toEqual([
      {
        call_seq: 1,
        outcome: 'unconfirmed',
        cost: '1.5000',
        cost_basis: 'unconfirmed_estimate',
        operation: MODEL,
      },
    ]);
    await bookkept(f.job);
    // a later delivery of the same message changes nothing
    await send('production.video-submit', f.job);
    await sweepNow();
    expect(submits()).toHaveLength(1);
  });

  it('a worker killed between the provider call and the task id write is settled by the sweep, with no second call (TC-CLP-06)', async () => {
    const f = await clip({ state: 'submitting', taskId: null, submittingAt: '-10 minutes' });
    await pool.query('update video_jobs set provider_task_id = null where id = $1', [f.job]);
    await sweepNow();
    const job = await rowOf(f.job);
    expect(job).toMatchObject({ state: 'failed', cause_class: 'outcome_unknown' });
    expect(await events(f.job)).toEqual([
      {
        call_seq: 1,
        outcome: 'unconfirmed',
        cost: '1.5000',
        cost_basis: 'unconfirmed_estimate',
        operation: MODEL,
      },
    ]);
    await bookkept(f.job);
    await send('production.video-submit', f.job);
    await sweepNow();
    expect(calls).toHaveLength(0);
  });

  it('settles the orphans of several owners in one sweep, each with its own unconfirmed event (TC-CLP-06)', async () => {
    const clips = await Promise.all(
      [1, 2, 3].map(() => clip({ state: 'submitting', taskId: null, submittingAt: '-10 minutes' })),
    );
    await pool.query('update video_jobs set provider_task_id = null where id = any($1)', [
      clips.map((c) => c.job),
    ]);
    await sweepNow();
    for (const c of clips) {
      expect(await rowOf(c.job)).toMatchObject({ state: 'failed', cause_class: 'outcome_unknown' });
      expect(await events(c.job)).toEqual([
        expect.objectContaining({ outcome: 'unconfirmed', cost_basis: 'unconfirmed_estimate' }),
      ]);
      await bookkept(c.job);
    }
    expect(calls).toHaveLength(0);
  });

  it('holds a sixth clip of one owner as pending until one of the five running finishes (REQ-009, ARCHITECTURE §5.5)', async () => {
    const first = await clip({ state: 'processing', nextPollAt: '1 hour' });
    const running = [
      first,
      ...(await Promise.all(
        [1, 2, 3, 4].map(() =>
          clip({ state: 'processing', nextPollAt: '1 hour', sameOwner: first }),
        ),
      )),
    ];
    const waiting = await clip({ sameOwner: first });
    await send('production.video-submit', waiting.job);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(await rowOf(waiting.job)).toMatchObject({ state: 'pending', call_count: 0 });
    expect(submits()).toHaveLength(0);
    await pool.query(`update video_jobs set state = 'completed' where id = $1`, [
      (running[0] as Fixture).job,
    ]);
    const job = await until(
      waiting.job,
      (row) => ['submitted', 'processing', 'completed'].includes(row['state'] as string),
      'was never submitted after a slot freed',
      30_000,
    );
    expect(job['call_count']).toBe(1);
    expect(submits()).toHaveLength(1);
  });

  it('classifies a refused submit: 401, 402 and 429 are unbilled rejections with the cause for the owner (ARCHITECTURE §5.10)', async () => {
    const run = async (status: number, body: unknown) => {
      const f = await clip();
      behaviour.submit = () => ({ status, body });
      await send('production.video-submit', f.job);
      await settled(f.job);
      await bookkept(f.job);
      return {
        f,
        job: await rowOf(f.job),
        events: await events(f.job),
        reserved: await reservations(f.job),
      };
    };
    const unauthorized = await run(401, { code: 401, message: `Invalid API key ${KEY}` });
    expect(unauthorized.job['cause_class']).toBe('configuration');
    expect(unauthorized.events).toEqual([
      expect.objectContaining({ outcome: 'rejected', cost: '0.0000', cost_basis: 'zero_rejected' }),
    ]);
    expect(unauthorized.reserved).toBe(0);
    const failures = (
      await pool.query(
        'select consecutive_auth_failures, status from provider_keys where id = $1',
        [unauthorized.f.keyId],
      )
    ).rows[0];
    expect(failures).toMatchObject({ consecutive_auth_failures: 1, status: 'active' });
    expect(JSON.stringify(unauthorized.job)).not.toContain(KEY);

    const credit = await run(400, { code: 400, message: 'Insufficient balance, please top up' });
    expect(credit.job['cause_class']).toBe('credit');
    const busy = await run(429, { code: 429, message: 'rate limit' });
    expect(busy.job['cause_class']).toBe('temporary');
    const down = await run(503, {});
    expect(down.job['cause_class']).toBe('outcome_unknown');
    expect(down.events[0]).toMatchObject({ outcome: 'unconfirmed' });
    expect(lines.join('')).not.toContain(KEY);
  });

  it('fails a pending clip whose key was replaced, deleted or disabled before any call, and releases the reservation', async () => {
    const replaced = await clip();
    await pool.query('update provider_keys set version = 2 where id = $1', [replaced.keyId]);
    const disabled = await clip({ keyStatus: 'disabled' });
    for (const f of [replaced, disabled]) await send('production.video-submit', f.job);
    expect((await settled(replaced.job))['cause_class']).toBe('key_replaced');
    expect((await settled(disabled.job))['cause_class']).toBe('configuration');
    for (const f of [replaced, disabled]) {
      await bookkept(f.job);
      expect(await events(f.job)).toEqual([]);
    }
    expect(calls).toHaveLength(0);
  });

  it('fails the clip reference_unreachable when the reference image is not ready, without a call', async () => {
    const f = await clip();
    await pool.query(`update media_objects set state = 'processing' where id = $1`, [f.reference]);
    await send('production.video-submit', f.job);
    const job = await settled(f.job);
    expect(job['cause_class']).toBe('reference_unreachable');
    expect(calls).toHaveLength(0);
    await bookkept(f.job);
  });
});

describe('production.poll and the deadline', () => {
  it('a duplicate poll reaches the provider once (TC-PCA-01)', async () => {
    behaviour.state = () => ({ status: 'processing' });
    const f = await clip({ state: 'submitted', nextPollAt: '-1 seconds' });
    const taskId = (await rowOf(f.job))['provider_task_id'] as string;
    await Promise.all([send('production.poll', f.job), send('production.poll', f.job)]);
    await until(f.job, (row) => row['state'] === 'processing', 'was not polled');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(statusReads(taskId)).toBe(1);
  });

  it('a lost poll is re-armed by the recovery sweep (TC-PCA-01)', async () => {
    behaviour.state = () => ({ status: 'processing' });
    const f = await clip({ state: 'processing', nextPollAt: '-2 minutes' });
    const taskId = (await rowOf(f.job))['provider_task_id'] as string;
    await sweepNow();
    await until(
      f.job,
      (row) => statusReads(taskId) >= 1 && row['next_poll_at'] !== null,
      'poll was not re-armed',
    );
    expect(statusReads(taskId)).toBeGreaterThanOrEqual(1);
  });

  it('records completion, drops next_poll_at and enqueues exactly one copy job in the same commit (TC-PCA-01, 08)', async () => {
    behaviour.fileDelayMs = 1200;
    const f = await clip({ state: 'submitted', nextPollAt: '-1 seconds' });
    const taskId = (await rowOf(f.job))['provider_task_id'] as string;
    await send('production.poll', f.job);
    const job = await until(
      f.job,
      (row) => row['provider_completed_at'] !== null,
      'completion was not recorded',
    );
    expect(job['state']).toBe('processing');
    expect(job['next_poll_at']).toBeNull();
    expect(await copyJobs(f.job)).toBe(1);
    // a second completion report changes nothing and enqueues nothing more
    // the copy job reads the task once to find the output; wait for it so the count below is settled, not a race
    await until(
      f.job,
      () => calls.some((c) => c.url === '/files/clip.mp4'),
      'the output was not requested',
    );
    const readsBefore = statusReads(taskId);
    expect(readsBefore).toBe(2);
    await send('production.poll', f.job);
    await eventually(
      async () =>
        (
          await pool.query(
            `select 1 from pgboss.job where name = 'production.poll' and data->>'jobId' = $1 and state = 'completed'`,
            [f.job],
          )
        ).rowCount,
      2,
      'the second poll was not handled',
    );
    expect(statusReads(taskId)).toBe(readsBefore);
    expect(await copyJobs(f.job)).toBe(1);
    await until(f.job, (row) => row['state'] === 'completed', 'did not complete');
  });

  it('a clip the provider finished just before the deadline is still copied, and the deadline no longer applies (TC-PCA-01, 02)', async () => {
    const f = await clip({
      state: 'processing',
      completedAt: '-2 seconds',
      deadlineAt: '-1 minutes',
      nextPollAt: null,
    });
    await sweepNow();
    const job = await until(
      f.job,
      (row) => row['state'] === 'completed',
      'was not copied after the deadline',
    );
    expect(job['cause_class']).toBeNull();
    expect(job['output_media_id']).not.toBeNull();
    expect(await mediaRows(f.campaign)).toHaveLength(1);
  });

  it('a clip the provider never finishes fails provider_timeout at the deadline and a late completion does not revive it (TC-PCA-03)', async () => {
    const before = await clip({
      state: 'processing',
      nextPollAt: '-1 seconds',
      deadlineAt: '1 minutes',
    });
    behaviour.state = () => ({ status: 'processing' });
    await send('production.poll', before.job);
    await until(
      before.job,
      (row) => row['state'] === 'processing' && row['next_poll_at'] !== null,
      'was not polled',
    );
    expect((await rowOf(before.job))['state']).toBe('processing');

    const late = await clip({
      state: 'processing',
      nextPollAt: '-1 seconds',
      deadlineAt: '-1 seconds',
    });
    const taskId = (await rowOf(late.job))['provider_task_id'] as string;
    behaviour.state = () => ({ status: 'completed', outputPath: '/files/clip.mp4' });
    await send('production.poll', late.job);
    const job = await settled(late.job);
    expect(job).toMatchObject({ state: 'failed', cause_class: 'provider_timeout' });
    expect(job['provider_task_id']).toBe(taskId);
    expect(statusReads(taskId)).toBe(0);
    await bookkept(late.job);
    await send('production.poll', late.job);
    await sweepNow();
    expect((await rowOf(late.job))['state']).toBe('failed');
    expect(await copyJobs(late.job)).toBe(0);
  });

  it('a provider that reports the task failed fails the clip with the provider cause only (ARCHITECTURE §5.10)', async () => {
    behaviour.state = () => ({ status: 'failed', error: `content policy ${KEY}` });
    const f = await clip({ state: 'submitted', nextPollAt: '-1 seconds' });
    await send('production.poll', f.job);
    const job = await settled(f.job);
    expect(job['cause_class']).toBe('temporary');
    expect(JSON.stringify(job)).not.toContain('content policy');
    await bookkept(f.job);
    expect((await events(f.job)).length).toBe(0);
  });
});

describe('video.copy-output', () => {
  it('cancel during the copy deletes our own object and leaves no media row (TC-PCA-06)', async () => {
    behaviour.fileDelayMs = 1500;
    const f = await clip({ state: 'processing', completedAt: '-1 seconds', nextPollAt: null });
    await send('video.copy-output', f.job);
    await until(
      f.job,
      () => calls.some((c) => c.url === '/files/clip.mp4'),
      'the output was not requested',
    );
    await pool.query(
      `update video_jobs set state = 'cancelled', cause_class = 'cancelled_campaign_deleted' where id = $1`,
      [f.job],
    );
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const job = await rowOf(f.job);
    expect(job).toMatchObject({ state: 'cancelled', output_media_id: null });
    expect(await mediaRows(f.campaign)).toHaveLength(0);
    const left = await storage.list(`u/${f.owner}/c/${f.campaign}/`);
    expect(left.objects).toHaveLength(0);
    expect(deletes()).toHaveLength(0);
  });

  it('refuses a private address, a redirect, an oversize file and a file that is not a video, failing with a clear cause (TC-EGR-01, 02)', async () => {
    const cases = [
      {
        name: 'private',
        state: {
          status: 'completed',
          outputPath: '/files/clip.mp4',
          outputHost: 'private.example.com',
        },
        message: /safely/,
      },
      {
        name: 'redirect',
        state: { status: 'completed', outputPath: '/files/redirect.mp4' },
        message: /safely/,
      },
      {
        name: 'oversize',
        state: { status: 'completed', outputPath: '/files/huge.mp4' },
        message: /larger/,
      },
      {
        name: 'html',
        state: { status: 'completed', outputPath: '/files/page.html' },
        message: /not a video/,
      },
    ];
    for (const c of cases) {
      behaviour.state = () => c.state;
      const f = await clip({ state: 'processing', completedAt: '-1 seconds', nextPollAt: null });
      await send('video.copy-output', f.job);
      const job = await settled(f.job, `${c.name} did not fail`);
      expect(job, c.name).toMatchObject({
        state: 'failed',
        cause_class: 'output_unreachable',
        output_media_id: null,
      });
      expect(job['cause_message'], c.name).toMatch(c.message);
      expect(JSON.stringify(job), c.name).not.toContain(CDN_HOST);
      expect(await mediaRows(f.campaign), c.name).toHaveLength(0);
      await bookkept(f.job);
      expect(deletes(), c.name).toHaveLength(0);
    }
    // the private host was never connected to: only the status reads and the stub's own hosts were seen
    expect(calls.filter((c) => c.url === '/files/clip.mp4')).toHaveLength(0);
  });

  it('keeps retrying a clip that cannot be fetched inside the copy window and fails it output_unreachable after it (TC-PCA-04)', async () => {
    behaviour.state = () => ({ status: 'completed', outputPath: '/files/broken.mp4' });
    const within = await clip({
      state: 'processing',
      completedAt: '-59 minutes',
      nextPollAt: null,
    });
    const beyond = await clip({
      state: 'processing',
      completedAt: '-61 minutes',
      nextPollAt: null,
    });
    await sweepNow();
    const failed = await settled(beyond.job);
    expect(failed).toMatchObject({ state: 'failed', cause_class: 'output_unreachable' });
    expect(failed['provider_completed_at']).not.toBeNull();
    // the submit event stands; nothing is added for the failed copy
    await eventually(
      () => reservations(beyond.job),
      0,
      'the reservation of the failed clip was not released',
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await rowOf(within.job)).toMatchObject({ state: 'processing', cause_class: null });
    expect(await copyJobs(within.job)).toBeGreaterThanOrEqual(1);
  });

  it('a worker killed after the completion commit and before the put is recovered by the sweep, once (TC-PCA-05)', async () => {
    const f = await clip({ state: 'processing', completedAt: '-5 seconds', nextPollAt: null });
    expect(await copyJobs(f.job)).toBe(0);
    await sweepNow();
    await sweepNow();
    const job = await until(f.job, (row) => row['state'] === 'completed', 'was not copied');
    expect(submits()).toHaveLength(0);
    expect(await mediaRows(f.campaign)).toHaveLength(1);
    const objects = await storage.list(`u/${f.owner}/c/${f.campaign}/`);
    expect(objects.objects).toHaveLength(1);
    expect(job['output_media_id']).not.toBeNull();
  });
});

describe('production.provider-copy-cleanup', () => {
  it('deletes the finished output of failed and cancelled clips past their deadline; waits for a running one; skips a week-old one (TC-PCA-10)', async () => {
    const failed = await clip({ state: 'failed', deadlineAt: '-10 minutes', nextPollAt: null });
    const cancelled = await clip({
      state: 'cancelled',
      deadlineAt: '-10 minutes',
      nextPollAt: null,
    });
    const running = await clip({ state: 'failed', deadlineAt: '-10 minutes', nextPollAt: null });
    const old = await clip({
      state: 'failed',
      deadlineAt: '-10 minutes',
      nextPollAt: null,
      createdAt: '-8 days',
    });
    const young = await clip({ state: 'failed', deadlineAt: '10 minutes', nextPollAt: null });
    const taskOf = async (f: Fixture): Promise<string> =>
      (await rowOf(f.job))['provider_task_id'] as string;
    const [failedTask, cancelledTask, runningTask, oldTask, youngTask] = (await Promise.all(
      [failed, cancelled, running, old, young].map(taskOf),
    )) as [string, string, string, string, string];
    behaviour.state = (taskId) => ({
      status: taskId === runningTask ? 'processing' : 'completed',
      outputPath: '/files/clip.mp4',
    });
    await send('production.provider-copy-cleanup', failed.job);
    await until(failed.job, (row) => row['provider_output_deleted_at'] !== null, 'was not cleaned');
    await until(
      cancelled.job,
      (row) => row['provider_output_deleted_at'] !== null,
      'was not cleaned',
    );
    const asked = deletes().flatMap((c) => c.body['ids'] as string[]);
    expect(asked).toContain(failedTask);
    expect(asked).toContain(cancelledTask);
    expect(asked).not.toContain(runningTask);
    expect(asked).not.toContain(oldTask);
    expect(asked).not.toContain(youngTask);
    expect((await rowOf(running.job))['provider_output_deleted_at']).toBeNull();
    expect(statusReads(oldTask)).toBe(0);
  });
});

describe('start-up configuration (TC-PCA-07)', () => {
  it('refuses a copy window outside 1 to 72 hours and a deadline outside 5 to 180 minutes, naming the variable', async () => {
    const start = (overrides: Record<string, string>) =>
      createWorkerApp(workerConfig(), {
        logger: buildLogger({ level: 'silent', destination: sink }).logger,
        egress: egressModule(),
        env: { ...baseEnv(), ...overrides },
        exit: () => undefined,
      });
    await expect(start({ PROVIDER_OUTPUT_COPY_WINDOW_HOURS: '0' })).rejects.toThrow(
      /PROVIDER_OUTPUT_COPY_WINDOW_HOURS/,
    );
    await expect(start({ PROVIDER_OUTPUT_COPY_WINDOW_HOURS: '73' })).rejects.toThrow(
      /PROVIDER_OUTPUT_COPY_WINDOW_HOURS/,
    );
    await expect(start({ VIDEO_JOB_DEADLINE_MIN: '4' })).rejects.toThrow(/VIDEO_JOB_DEADLINE_MIN/);
    await expect(start({ VIDEO_JOB_DEADLINE_MIN: '181' })).rejects.toThrow(
      /VIDEO_JOB_DEADLINE_MIN/,
    );
  });
});
