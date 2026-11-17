import 'reflect-metadata';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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

// TASK-054 (production 3/6) through the real worker composition root (`createWorkerApp`, the one `main.worker.ts` runs) on
// real PostgreSQL and an in-process S3 stand-in, with a local TLS server standing in for api.wavespeed.ai, its output host
// and api.openai.com (the real ones are never called) and fake ffmpeg and ffprobe scripts on the PATH: the first QC created
// when a clip completes, `production.qc-run`, the result states and their reasons, the re-run keeping history, the usage
// ledger, the transcript canary and the recovery sweep's QC hooks. TC-QC-01, 03, 04, 05..10.

const OPENAI_KEY = 'integration-openai-secret-0123456789abcdef';
const WAVESPEED_KEY = 'integration-wavespeed-secret-0123456789abcdef';
const MODEL = 'bytedance/seedance-2.0/text-to-video';
const API_HOST = 'api.openai.com';
const CDN_HOST = 'cdn.example.net';
const DIALOGUE = 'A calm start to the day.';
/** A word no script contains: it must reach neither a log line nor an error. */
const CANARY = 'zqcanaryzqtranscript';

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
  const error = (res: ServerResponse, status: number, code: string): void => xml(res, status, `<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      if (key === '' && req.method === 'GET') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const listed = [...objects.entries()].filter(([name]) => name.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
        const contents = listed.map(([name, o]) => `<Contents><Key>${name}</Key><Size>${String(o.body.length)}</Size><LastModified>${o.at.toISOString()}</LastModified></Contents>`).join('');
        return xml(res, 200, `<ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${String(listed.length)}</KeyCount><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
      }
      if (key === '' && req.method === 'POST' && url.searchParams.has('delete')) {
        for (const match of body.toString().matchAll(/<Key>([^<]+)<\/Key>/g)) objects.delete(match[1] as string);
        return xml(res, 200, '<DeleteResult></DeleteResult>');
      }
      if (req.method === 'PUT') {
        if (req.headers['if-none-match'] === '*' && objects.has(key)) return error(res, 412, 'PreconditionFailed');
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
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
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
let fakeBin: string;
let savedPath: string | undefined;

/** A small MP4: a size field, `ftyp`, a brand, then filler. `marker` text in it makes the fake ffprobe report no audio. */
const mp4 = (marker = ''): Buffer => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12, 7), Buffer.from(marker)]);

interface Call { method: string; url: string; auth: string | undefined; body: string }
let calls: Call[] = [];
interface Behaviour {
  /** The transcription answer. */
  transcribe: () => { status?: number; text?: string; hang?: boolean };
}
let behaviour: Behaviour;
const defaults = (): Behaviour => ({ transcribe: () => ({ text: DIALOGUE }) });
const transcribes = (): Call[] => calls.filter((c) => c.url === '/v1/audio/transcriptions');

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
    allowedHosts: { wavespeed: [API_HOST, CDN_HOST], openai: [API_HOST] },
    timeoutMs: 2500,
    maxBytes: 5_000_000,
    resolver: async () => ['127.0.0.1'],
    testing: { isBlockedAddress: (address) => address !== '127.0.0.1', tls: { ca: stub.ca }, port: stub.port },
  });
  return { module: StubEgress, providers: [{ provide: EGRESS, useValue: egress }], exports: [EGRESS] };
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

/** Fake ffprobe and ffmpeg: no audio when the clip file carries the marker, else a tiny "WAV". The worker finds them on the PATH. */
function installFakeFfmpeg(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qc-fake-bin-'));
  const write = (name: string, body: string): void => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  write('ffprobe', 'for a; do f="$a"; done\nif grep -q NOAUDIO "$f"; then printf ""; else printf "1\\n"; fi');
  write('ffmpeg', 'while [ $# -gt 0 ]; do if [ "$1" = "-i" ]; then f="$2"; fi; shift; done\nif grep -q BROKEN "$f"; then exit 1; fi\nprintf "RIFFfakewav"');
  return dir;
}

beforeAll(async () => {
  fakeBin = installFakeFfmpeg();
  savedPath = process.env['PATH'];
  process.env['PATH'] = `${fakeBin}${delimiter}${savedPath ?? ''}`;
  stub = await startServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      calls.push({ method: req.method ?? '', url, auth: req.headers['authorization'], body: Buffer.concat(parts).toString('latin1') });
      const json = (status: number, body: unknown): void => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST' && url === '/v1/audio/transcriptions') {
        const answer = behaviour.transcribe();
        if (answer.hang === true) return;
        return json(answer.status ?? 200, answer.status === undefined || answer.status < 300 ? { text: answer.text ?? DIALOGUE } : { error: { code: 'server_error' } });
      }
      if (req.method === 'POST' && url.startsWith('/api/v3/predictions/delete')) return json(200, { code: 200, message: 'success' });
      if (req.method === 'POST' && url.startsWith('/api/v3/')) return json(200, { code: 200, message: 'success', data: { id: 'task-qc-1', status: 'created' } });
      const read = /^\/api\/v3\/predictions\/([^/]+)\/result$/.exec(url);
      if (req.method === 'GET' && read !== null) {
        return json(200, { code: 200, data: { id: read[1], status: 'completed', outputs: [`https://${CDN_HOST}:${String(stub.port)}/files/clip.mp4`], error: '' } });
      }
      if (url.startsWith('/files/')) {
        res.setHeader('content-type', 'video/mp4');
        return res.end(mp4());
      }
      res.statusCode = 404;
      res.end();
    });
  });
  minio = await startTestBucket();
  testDb = await createTestDatabase({ label: 'task054wrk', migrations: false });
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
      const sql = statement.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim();
      if (sql !== '') await pool.query(sql);
    }
  }
  await installJobs(testDb.url);
  await runSeed({ dataset: 'reference', appEnv: 'development', databaseUrl: testDb.url, steps: [priceTableSeedStep()] });
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
  if (savedPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = savedPath;
  rmSync(fakeBin, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  behaviour = defaults();
});

interface Fixture { owner: string; campaign: string; segment: string; job: string; run: string; storageKey: string }
interface Options {
  /** The clip's bytes; the marker decides what the fake ffmpeg finds in it. */
  clipMarker?: string;
  openAiKey?: 'active' | 'none' | 'disabled';
  dialogue?: string;
  /** SQL for the run's `state`, `submitting_at`, `created_at` and `deadline_at` (offsets from now). */
  runState?: string;
  submittingAt?: string;
  createdAt?: string;
  deadlineAt?: string;
  callCount?: number;
  /** The clip's own (`video`) reservation with its QC part, as the api leaves it at creation. */
  videoReservation?: boolean;
  sameOwner?: { owner: string; keyId: string };
  stampKey?: boolean;
}

/** A completed clip with its stored object, its OpenAI key and a pending QC run (what API-064 or the copy step leaves behind). */
async function clip(opts: Options = {}): Promise<Fixture> {
  const owner = opts.sameOwner?.owner ?? randomUUID();
  const keyId = opts.sameOwner?.keyId ?? randomUUID();
  if (opts.sameOwner === undefined) {
    await pool.query(`insert into users (id, idp_subject, email, linked_via) values ($1, $2, $3, 'first_admin')`, [owner, `sub_${owner.slice(0, 20)}`, `${owner.slice(0, 12)}@example.test`]);
    if (opts.openAiKey !== 'none') {
      const sealed = wrap.seal(Buffer.from(OPENAI_KEY), { userId: owner, provider: 'openai', keyId, version: 1 });
      await pool.query(
        `insert into provider_keys (id, owner_id, provider, status, version, ciphertext, nonce, wrapped_dek, kek_version, last4, fingerprint, fingerprint_pepper_version)
         values ($1, $2, 'openai', $3, 1, $4, $5, $6, $7, 'cdef', $8, 1)`,
        [keyId, owner, opts.openAiKey === 'disabled' ? 'disabled' : 'active', sealed.ciphertext, sealed.nonce, sealed.wrappedDek, sealed.kekVersion, 'c'.repeat(64)],
      );
    }
  }
  const campaign = randomUUID();
  const brief = randomUUID();
  const segment = randomUUID();
  await pool.query(`insert into campaigns (id, owner_id, product_name, product_description, segment_count) values ($1, $2, 'Calm Cap', 'A slow morning drink', 2)`, [campaign, owner]);
  await pool.query(`insert into briefs (id, campaign_id, owner_id, state, accepted_at) values ($1, $2, $3, 'accepted', now())`, [brief, campaign, owner]);
  await pool.query(`insert into brief_segments (id, brief_id, position, dialogue, prompt, word_count) values ($1, $2, 1, $3, 'A bright kitchen at dawn', 6)`, [segment, brief, opts.dialogue ?? DIALOGUE]);
  const job = randomUUID();
  const storageKey = `u/${owner}/c/${campaign}/clip/${job}.mp4`;
  await storage.put(storageKey, mp4(opts.clipMarker), 'video/mp4', 1_000_000);
  await pool.query(`insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, campaign_id) values ($1, $2, 'clip', 'ready', $3, 40, 'video/mp4', $4)`, [job, owner, storageKey, campaign]);
  await pool.query(
    `insert into video_jobs (id, owner_id, campaign_id, segment_id, segment_revision, provider_model, options, state, reuse_hash, deadline_at, provider_task_id, provider_completed_at, output_media_id)
     values ($1, $2, $3, $4, 1, $5, '{"durationSeconds":15,"resolution":"1080p","aspectRatio":"9:16"}', 'completed', $6, now(), 'task-1', now(), $1)`,
    [job, owner, campaign, segment, MODEL, randomBytes(32).toString('hex')],
  );
  const run = randomUUID();
  const at = (offset: string | undefined, fallback: string): string => `now() + interval '${offset ?? fallback}'`;
  await pool.query(
    `insert into qc_runs (id, owner_id, video_job_id, state, reuse_hash, key_id, key_version, call_count, submitting_at, deadline_at, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, ${opts.submittingAt === undefined ? 'null' : at(opts.submittingAt, '0 seconds')}, ${at(opts.deadlineAt, '10 minutes')}, ${at(opts.createdAt, '0 seconds')})`,
    [run, owner, job, opts.runState ?? 'pending', randomBytes(32).toString('hex'), opts.stampKey === true && opts.openAiKey !== 'none' ? keyId : null, opts.stampKey === true && opts.openAiKey !== 'none' ? 1 : null, opts.callCount ?? 0],
  );
  await pool.query(`insert into spend_reservations (id, owner_id, job_type, job_id, estimated_cost_usd, remaining_calls) values ($1, $2, 'qc', $3, 0.01, 1)`, [randomUUID(), owner, run]);
  if (opts.videoReservation === true) {
    await pool.query(`insert into spend_reservations (id, owner_id, job_type, job_id, estimated_cost_usd, remaining_calls) values ($1, $2, 'video', $3, 0.01, 1)`, [randomUUID(), owner, job]);
  }
  return { owner, campaign, segment, job, run, storageKey };
}

const runRow = async (id: string): Promise<Record<string, any>> => (await pool.query('select * from qc_runs where id = $1', [id])).rows[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function untilRun(id: string, done: (row: Record<string, any>) => boolean, what: string, ms = 60_000): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const deadline = Date.now() + ms;
  for (;;) {
    const row = await runRow(id);
    if (done(row)) return row;
    if (Date.now() > deadline) throw new Error(`qc run ${id}: ${what}; stayed ${String(row['state'])}/${String(row['qc_state'])} (${String(row['last_error_code'])})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const finished = (id: string) => untilRun(id, (row) => row['state'] === 'completed' || row['state'] === 'failed' || row['state'] === 'cancelled', 'did not finish');
const events = async (jobType: string, jobId: string) =>
  (await pool.query(`select call_seq, outcome, cost_basis, provider, operation from usage_events where job_type = $1 and job_id = $2 order by call_seq`, [jobType, jobId])).rows as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
const reservationCount = async (jobType: string, jobId: string) => (await pool.query(`select 1 from spend_reservations where job_type = $1 and job_id = $2`, [jobType, jobId])).rowCount;
const send = (run: string) => apiBoss.send('production.qc-run', { runId: run });
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


describe('production.qc-run, through the worker process', () => {
  it('passes a clip whose spoken words match: one call, the key opened in the worker, usage recorded, reservations released (TC-QC-01)', async () => {
    const f = await clip({ stampKey: true, videoReservation: true });
    await send(f.run);
    const row = await untilRun(f.run, (r) => r['state'] === 'completed', 'did not complete');
    expect(row).toMatchObject({ qc_state: 'passed', reason: null, call_count: 1 });
    expect(Number(row['word_error_rate'])).toBe(0);
    const sent = transcribes();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.auth).toBe(`Bearer ${OPENAI_KEY}`);
    expect(sent[0]?.body).toContain('name="model"\r\n\r\ngpt-transcribe');
    expect(sent[0]?.body).toContain('name="language"\r\n\r\nen');
    expect(sent[0]?.body).toContain('RIFFfakewav');
    expect(await events('qc', f.run)).toEqual([expect.objectContaining({ call_seq: 1, outcome: 'succeeded', provider: 'openai', operation: 'gpt-transcribe', cost_basis: 'estimate' })]);
    expect(await reservationCount('qc', f.run)).toBe(0);
    expect(await reservationCount('video', f.job)).toBe(0);
    expect(logText()).not.toContain(OPENAI_KEY);
  });

  it('fails a clip whose words differ, with a summary of missing and extra words, and never logs the transcript (TC-QC-01, canary)', async () => {
    behaviour.transcribe = () => ({ text: `A ${CANARY} ${CANARY} to the day.` });
    const f = await clip();
    await send(f.run);
    const row = await finished(f.run);
    expect(row).toMatchObject({ state: 'completed', qc_state: 'failed' });
    expect(row['reason']).toBe(`33% of the words differ from the script. Missing: calm, start. Extra: ${CANARY}, ${CANARY}.`);
    expect(Number(row['word_error_rate'])).toBe(0.333);
    expect(logText()).not.toContain(CANARY);
  });

  it('skips with "no audio track" and makes no call when the clip has no audio (TC-QC-01)', async () => {
    const f = await clip({ clipMarker: 'NOAUDIO', videoReservation: true });
    await send(f.run);
    const row = await finished(f.run);
    expect(row).toMatchObject({ qc_state: 'skipped', reason: 'No audio track in this clip.', call_count: 0 });
    expect(transcribes()).toHaveLength(0);
    expect(await events('qc', f.run)).toEqual([]);
    expect(await reservationCount('qc', f.run)).toBe(0);
    expect(await reservationCount('video', f.job)).toBe(0);
  });

  it('skips when the audio cannot be read, and when the clip is gone from storage, without a call', async () => {
    const broken = await clip({ clipMarker: 'BROKEN' });
    await send(broken.run);
    expect(await finished(broken.run)).toMatchObject({ qc_state: 'skipped', last_error_code: 'audio_unreadable' });
    const gone = await clip();
    await storage.delete(gone.storageKey);
    await send(gone.run);
    expect(await finished(gone.run)).toMatchObject({ qc_state: 'skipped', last_error_code: 'qc_error' });
    expect(transcribes()).toHaveLength(0);
  });

  it('skips with "add your OpenAI key" and no call when the owner has no usable key, releasing the reservation (TC-KEY)', async () => {
    for (const openAiKey of ['none', 'disabled'] as const) {
      const f = await clip({ openAiKey });
      await send(f.run);
      const row = await finished(f.run);
      expect(row['qc_state']).toBe('skipped');
      expect(row['reason']).toBe(openAiKey === 'none' ? 'Add your OpenAI key in Settings, then re-run QC.' : 'Your OpenAI key is disabled. Enter it again in Settings, then re-run QC.');
      expect(await reservationCount('qc', f.run)).toBe(0);
    }
    expect(transcribes()).toHaveLength(0);
  });

  it('skips with the cause when the transcription fails, keeping the estimate counted for an unknown outcome (TC-QC-04)', async () => {
    behaviour.transcribe = () => ({ status: 500 });
    const f = await clip({ videoReservation: true });
    await send(f.run);
    const row = await finished(f.run);
    expect(row).toMatchObject({ state: 'completed', qc_state: 'skipped', reason: 'The transcription service was not available. Re-run QC.', call_count: 1 });
    expect(await events('qc', f.run)).toEqual([expect.objectContaining({ outcome: 'unconfirmed', cost_basis: 'unconfirmed_estimate' })]);
    expect(await reservationCount('qc', f.run)).toBe(0);
    expect(await reservationCount('video', f.job)).toBe(0);
  });

  it('a 401 is skipped, recorded at zero, and counts toward disabling the key', async () => {
    behaviour.transcribe = () => ({ status: 401 });
    const f = await clip({ stampKey: true });
    await send(f.run);
    expect(await finished(f.run)).toMatchObject({ qc_state: 'skipped', last_error_code: 'configuration' });
    expect(await events('qc', f.run)).toEqual([expect.objectContaining({ outcome: 'rejected', cost_basis: 'zero_rejected' })]);
    const key = (await pool.query(`select consecutive_auth_failures from provider_keys where owner_id = $1 and provider = 'openai'`, [f.owner])).rows[0];
    expect(key.consecutive_auth_failures).toBe(1);
  });

  it('skips a clip whose segment changed after it was made, without a call', async () => {
    const f = await clip();
    await pool.query('update brief_segments set revision = 2 where id = $1', [f.segment]);
    await send(f.run);
    expect(await finished(f.run)).toMatchObject({ qc_state: 'skipped', reason: 'The segment changed after this clip was made, so its audio was not compared.' });
    expect(transcribes()).toHaveLength(0);
  });

  it('keeps the old result when a new run is made: a re-run is a new row, the history stays (TC-QC-03)', async () => {
    behaviour.transcribe = () => ({ text: 'something else entirely' });
    const first = await clip();
    await send(first.run);
    expect(await finished(first.run)).toMatchObject({ qc_state: 'failed' });
    const before = await runRow(first.run);
    behaviour.transcribe = () => ({ text: DIALOGUE });
    const next = randomUUID();
    await pool.query(`insert into qc_runs (id, owner_id, video_job_id, reuse_hash, deadline_at) values ($1, $2, $3, $4, now() + interval '10 minutes')`, [next, first.owner, first.job, randomBytes(32).toString('hex')]);
    await send(next);
    expect(await finished(next)).toMatchObject({ qc_state: 'passed' });
    expect(await runRow(first.run)).toEqual(before);
    const history = (await pool.query(`select id, qc_state from qc_runs where video_job_id = $1 order by created_at desc, id`, [first.job])).rows;
    expect(history.map((r: { qc_state: string }) => r.qc_state).sort()).toEqual(['failed', 'passed']);
  });

  it('transcribes at most once when the same message is delivered twice', async () => {
    const f = await clip();
    await Promise.all([send(f.run), send(f.run)]);
    await finished(f.run);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(transcribes()).toHaveLength(1);
    expect(await events('qc', f.run)).toHaveLength(1);
  });

  it('does nothing for a run that is already finished or cancelled', async () => {
    const f = await clip({ runState: 'cancelled' });
    await send(f.run);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await runRow(f.run)).toMatchObject({ state: 'cancelled', qc_state: 'pending' });
    expect(transcribes()).toHaveLength(0);
  });
});

describe('the first QC of a clip, through the whole worker path', () => {
  it('is created in the transaction that completes the clip and passes, with the clip\'s own QC reservation used (TC-QC-01, 05)', async () => {
    const owner = randomUUID();
    const wsKey = randomUUID();
    const aiKey = randomUUID();
    await pool.query(`insert into users (id, idp_subject, email, linked_via) values ($1, $2, $3, 'first_admin')`, [owner, `sub_${owner.slice(0, 20)}`, `${owner.slice(0, 12)}@example.test`]);
    for (const [id, provider, secret] of [[wsKey, 'wavespeed', WAVESPEED_KEY], [aiKey, 'openai', OPENAI_KEY]] as const) {
      const sealed = wrap.seal(Buffer.from(secret), { userId: owner, provider, keyId: id, version: 1 });
      await pool.query(
        `insert into provider_keys (id, owner_id, provider, status, version, ciphertext, nonce, wrapped_dek, kek_version, last4, fingerprint, fingerprint_pepper_version)
         values ($1, $2, $3, 'active', 1, $4, $5, $6, $7, 'cdef', $8, 1)`,
        [id, owner, provider, sealed.ciphertext, sealed.nonce, sealed.wrappedDek, sealed.kekVersion, (provider === 'openai' ? 'd' : 'e').repeat(64)],
      );
    }
    const campaign = randomUUID();
    const brief = randomUUID();
    const segment = randomUUID();
    const job = randomUUID();
    await pool.query(`insert into campaigns (id, owner_id, product_name, product_description, segment_count) values ($1, $2, 'Calm Cap', 'A slow morning drink', 1)`, [campaign, owner]);
    await pool.query(`insert into briefs (id, campaign_id, owner_id, state, accepted_at) values ($1, $2, $3, 'accepted', now())`, [brief, campaign, owner]);
    await pool.query(`insert into brief_segments (id, brief_id, position, dialogue, prompt, word_count) values ($1, $2, 1, $3, 'A bright kitchen at dawn', 6)`, [segment, brief, DIALOGUE]);
    await pool.query(
      `insert into video_jobs (id, owner_id, campaign_id, segment_id, segment_revision, provider_model, options, state, reuse_hash, key_id, key_version, deadline_at)
       values ($1, $2, $3, $4, 1, $5, '{"durationSeconds":15,"resolution":"1080p","aspectRatio":"9:16"}', 'pending', $6, $7, 1, now() + interval '30 minutes')`,
      [job, owner, campaign, segment, MODEL, randomBytes(32).toString('hex'), wsKey],
    );
    await pool.query(`insert into spend_reservations (id, owner_id, job_type, job_id, estimated_cost_usd, remaining_calls) values ($1, $2, 'video', $3, 1.51, 2)`, [randomUUID(), owner, job]);
    await apiBoss.send('production.video-submit', { jobId: job });
    await untilJob(job, 'completed');
    const run = (await pool.query('select id::text from qc_runs where video_job_id = $1', [job])).rows;
    expect(run).toHaveLength(1);
    const row = await untilRun(run[0].id as string, (r) => r['state'] === 'completed', 'did not complete');
    expect(row).toMatchObject({ qc_state: 'passed', key_id: null });
    expect(transcribes()).toHaveLength(1);
    expect(transcribes()[0]?.auth).toBe(`Bearer ${OPENAI_KEY}`);
    expect((await events('video', job)).map((e) => [e['call_seq'], e['outcome'], e['provider']])).toEqual([[1, 'succeeded', 'wavespeed']]);
    expect((await events('qc', run[0].id as string)).map((e) => [e['call_seq'], e['outcome'], e['provider']])).toEqual([[1, 'succeeded', 'openai']]);
    expect(await reservationCount('video', job)).toBe(0);
    expect(await reservationCount('qc', run[0].id as string)).toBe(0);
  });
});

async function untilJob(job: string, state: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const row = (await pool.query('select state, cause_class, cause_message from video_jobs where id = $1', [job])).rows[0];
    if (row.state === state) return;
    if (Date.now() > deadline || row.state === 'failed') throw new Error(`video job stayed ${String(row.state)} (${String(row.cause_class)}: ${String(row.cause_message)})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('the QC recovery sweep', () => {
  it('settles a run that lost its answer as skipped "interrupted", keeping the estimate counted, and releases the reservations', async () => {
    const f = await clip({ runState: 'submitting', submittingAt: '-120 seconds', callCount: 1, videoReservation: true });
    await sweepNow();
    await untilRun(f.run, (r) => r['state'] === 'completed', 'was not settled');
    expect(await runRow(f.run)).toMatchObject({ qc_state: 'skipped', reason: 'The check was interrupted. Re-run QC.', last_error_code: 'outcome_unknown' });
    expect(await events('qc', f.run)).toEqual([expect.objectContaining({ outcome: 'unconfirmed' })]);
    expect(await reservationCount('qc', f.run)).toBe(0);
    expect(await reservationCount('video', f.job)).toBe(0);
    expect(transcribes()).toHaveLength(0);
  });

  it('settles a run that never started before its deadline as skipped, with no usage event', async () => {
    const f = await clip({ deadlineAt: '-1 minute', createdAt: '-11 minutes' });
    await sweepNow();
    await untilRun(f.run, (r) => r['state'] === 'completed', 'was not settled');
    expect(await runRow(f.run)).toMatchObject({ qc_state: 'skipped', reason: 'The check did not start in time. Re-run QC.' });
    expect(await events('qc', f.run)).toEqual([]);
    expect(await reservationCount('qc', f.run)).toBe(0);
  });

  it('queues a pending run whose message was lost, and the run then completes', async () => {
    const f = await clip({ createdAt: '-5 minutes' });
    await sweepNow();
    const row = await untilRun(f.run, (r) => r['state'] === 'completed', 'was not requeued');
    expect(row['qc_state']).toBe('passed');
    expect(transcribes()).toHaveLength(1);
  });
});
