import 'reflect-metadata';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorkerApp } from '../../../../bootstrap/worker.module.js';
import type { WorkerApp } from '../../../../bootstrap/worker.module.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../../../platform/db/test-database.js';
import type { TestDatabase } from '../../../../platform/db/test-database.js';
import { createRuntimeBoss, startRuntimeBoss } from '../../../../platform/jobs/boss.js';
import { installJobs } from '../../../../platform/jobs/test-support.js';
import { buildLogger } from '../../../../platform/logging/index.js';
import { STORAGE_PORT } from '../../../media/index.js';
import type { StoragePort } from '../../../media/index.js';
import { AssemblyRenderJob } from '../../production.module.js';

// TASK-056 (production 5/6) through the real worker composition root (`createWorkerApp`, the one `main.worker.ts` runs) on
// real PostgreSQL and an in-process S3 stand-in: `production.assembly-render` handled by the worker process with the real
// FFmpeg binary (found by FFMPEG_DIR or on the PATH; fake scripts stand in only where there is none), the expired-lease
// resume, the recovery sweep's assembly hooks and the failure causes. TC-ASM-*, kill-worker-mid-render.

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

const lines: string[] = [];
const sink = new Writable({
  write(chunk: Buffer, _e, done) {
    lines.push(chunk.toString());
    done();
  },
});

let testDb: TestDatabase;
let pool: pg.Pool;
let bucket: TestBucket;
let worker: WorkerApp;
let apiBoss: PgBoss;
let storage: StoragePort;
let toolDir: string;
let scratch: string;
let savedPath: string | undefined;
/** True when the real FFmpeg and ffprobe were found; the clips are then real MP4 files and the output is probed. */
let real = false;

const usable = (dir: string): boolean =>
  ['ffmpeg', 'ffprobe'].every(
    (name) =>
      existsSync(join(dir, name)) &&
      spawnSync(join(dir, name), ['-version'], { stdio: 'ignore' }).status === 0,
  );

/** The real binaries: `FFMPEG_DIR`, else a PATH entry that has both. */
function findTools(): string | undefined {
  const dirs = [process.env['FFMPEG_DIR'], ...(process.env['PATH'] ?? '').split(delimiter)].filter(
    (dir): dir is string => dir !== undefined && dir !== '',
  );
  return dirs.find(usable);
}

/** Fake tools for a machine without FFmpeg: the probe answers with a fixed shape, the render writes a few bytes. */
function installFakeTools(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asm-fake-bin-'));
  const write = (name: string, body: string): void => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  write(
    'ffprobe',
    'for a; do f="$a"; done\nif grep -q BROKEN "$f"; then exit 1; fi\nprintf \'{"streams":[{"codec_type":"video","width":320,"height":568},{"codec_type":"audio"}],"format":{"duration":"15.0"}}\'',
  );
  write(
    'ffmpeg',
    'for a; do out="$a"; done\nprintf "out_time_us=30000000\\n"\nprintf "fakefinalvideo" > "$out"',
  );
  return dir;
}

function tool(name: string, args: string[]): string {
  const result = spawnSync(join(toolDir, name), args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${name} failed: ${result.stderr}`);
  return result.stdout;
}

/** A 15 second 320x568 clip; `silent` has no audio track. */
function makeClip(file: string, silent: boolean): void {
  const args = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x568:rate=30:duration=15'];
  if (!silent)
    args.push(
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=15',
      '-c:a',
      'aac',
    );
  args.push('-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-y', file);
  tool('ffmpeg', args);
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'asm-test-'));
  const found = findTools();
  real = found !== undefined;
  toolDir = found ?? installFakeTools();
  savedPath = process.env['PATH'];
  process.env['PATH'] = `${toolDir}${delimiter}${savedPath ?? ''}`;
  bucket = await startTestBucket();
  testDb = await createTestDatabase({ label: 'task056asm', migrations: false });
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
  const stream = buildLogger({ level: 'debug', destination: sink });
  worker = await createWorkerApp(
    {
      DATABASE_URL: testDb.url,
      DATABASE_POOL_MAX: 8,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      WORKER_WATCHDOG_SECONDS: 180,
      WORKER_DRAIN_SECONDS: 5,
      WORKER_CONCURRENCY_PROVIDER: 4,
      WORKER_CONCURRENCY_SANITIZE: 1,
      WORKER_CONCURRENCY_DELETION: 1,
    },
    {
      logger: stream.logger,
      env: {
        ...kekMaps(),
        R2_ENDPOINT: bucket.endpoint,
        R2_BUCKET: bucket.bucket,
        R2_ACCESS_KEY_ID: bucket.accessKey,
        R2_SECRET_ACCESS_KEY: bucket.secretKey,
        MEDIA_MAX_PIXEL_DIMENSION: '300',
        MEDIA_MAX_PIXELS: '40000',
        MEDIA_UNATTACHED_TTL_HOURS: '24',
      },
      exit: () => undefined,
    },
  );
  storage = worker.context.get<StoragePort>(STORAGE_PORT, { strict: false });
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
  await bucket?.stop();
  if (savedPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = savedPath;
  rmSync(scratch, { recursive: true, force: true });
  if (!real) rmSync(toolDir, { recursive: true, force: true });
});

beforeEach(() => {
  lines.length = 0;
});

interface Fixture {
  owner: string;
  campaign: string;
  job: string;
  clips: string[];
  reuseHash: string;
}
interface Options {
  /** Row values of the assembly job. */
  state?: string;
  attempts?: number;
  /** SQL offset from now for `lease_until` and `updated_at`. */
  leaseUntil?: string;
  updatedAgo?: string;
  /** Clip positions (1 to 4) that are stored with these bytes instead of a real clip. */
  garbage?: number[];
  /** Positions whose object is missing from storage. */
  missing?: number[];
  /** Positions that are real clips without an audio track. */
  silent?: number[];
}

/** A campaign with four completed, stored clips and an assembly job over them, as API-070 leaves it. */
async function assembly(opts: Options = {}): Promise<Fixture> {
  const owner = randomUUID();
  const campaign = randomUUID();
  const brief = randomUUID();
  await pool.query(
    `insert into users (id, idp_subject, email, linked_via) values ($1, $2, $3, 'first_admin')`,
    [owner, `sub_${owner.slice(0, 20)}`, `${owner.slice(0, 12)}@example.test`],
  );
  await pool.query(
    `insert into campaigns (id, owner_id, product_name, product_description, segment_count) values ($1, $2, 'Calm Cap', 'A slow morning drink', 4)`,
    [campaign, owner],
  );
  await pool.query(
    `insert into briefs (id, campaign_id, owner_id, state, accepted_at) values ($1, $2, $3, 'accepted', now())`,
    [brief, campaign, owner],
  );
  const clips: string[] = [];
  for (let position = 1; position <= 4; position += 1) {
    const segment = randomUUID();
    const job = randomUUID();
    await pool.query(
      `insert into brief_segments (id, brief_id, position, dialogue, prompt, word_count) values ($1, $2, $3, 'A calm start.', 'A bright kitchen at dawn', 3)`,
      [segment, brief, position],
    );
    const key = `u/${owner}/c/${campaign}/clip/${job}.mp4`;
    if (!(opts.missing ?? []).includes(position)) {
      let body: Buffer;
      if ((opts.garbage ?? []).includes(position)) body = Buffer.from('BROKEN this is not a video');
      else if (real) {
        const file = join(scratch, `${job}.mp4`);
        makeClip(file, (opts.silent ?? []).includes(position));
        body = readFileSync(file);
      } else body = Buffer.from('fakeclip');
      await storage.put(key, body, 'video/mp4', 50_000_000);
    }
    await pool.query(
      `insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, campaign_id) values ($1, $2, 'clip', 'ready', $3, 100, 'video/mp4', $4)`,
      [job, owner, key, campaign],
    );
    await pool.query(
      `insert into video_jobs (id, owner_id, campaign_id, segment_id, segment_revision, provider_model, options, state, reuse_hash, deadline_at, provider_task_id, provider_completed_at, output_media_id)
       values ($1, $2, $3, $4, 1, 'm', '{"durationSeconds":15,"resolution":"1080p","aspectRatio":"9:16"}', 'completed', $5, now(), 'task-1', now(), $1)`,
      [job, owner, campaign, segment, randomBytes(32).toString('hex')],
    );
    clips.push(job);
  }
  const id = randomUUID();
  const reuseHash = randomBytes(32).toString('hex');
  await pool.query(
    `insert into assembly_jobs (id, owner_id, campaign_id, state, reuse_hash, render_day, attempts, lease_until, updated_at)
     values ($1, $2, $3, $4, $5, (now() at time zone 'utc')::date, $6, ${opts.leaseUntil === undefined ? 'null' : `now() + interval '${opts.leaseUntil}'`}, now() - interval '${opts.updatedAgo ?? '0 seconds'}')`,
    [id, owner, campaign, opts.state ?? 'pending', reuseHash, opts.attempts ?? 0],
  );
  for (const [index, videoJobId] of clips.entries()) {
    await pool.query(
      `insert into assembly_clips (assembly_job_id, position, video_job_id) values ($1, $2, $3)`,
      [id, index + 1, videoJobId],
    );
  }
  return { owner, campaign, job: id, clips, reuseHash };
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const row = async (id: string): Promise<Row> =>
  (await pool.query('select * from assembly_jobs where id = $1', [id])).rows[0] as Row;
async function until(
  id: string,
  done: (r: Row) => boolean,
  what: string,
  ms = 90_000,
): Promise<Row> {
  const deadline = Date.now() + ms;
  for (;;) {
    const r = await row(id);
    if (done(r)) return r;
    if (Date.now() > deadline)
      throw new Error(
        `assembly ${id}: ${what}; stayed ${String(r['state'])} (${String(r['cause_class'])})`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const finished = (id: string) =>
  until(id, (r) => r['state'] === 'done' || r['state'] === 'failed', 'did not finish');
const send = (id: string) => apiBoss.send('production.assembly-render', { jobId: id });
async function sweepNow(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const before = lines.filter((line) => line.includes('recovery sweep finished')).length;
    await worker.runtime.sweep();
    if (lines.filter((line) => line.includes('recovery sweep finished')).length > before) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the recovery sweep never ran');
}
const finals = async (campaign: string) =>
  (
    await pool.query(`select * from media_objects where campaign_id = $1 and kind = 'final'`, [
      campaign,
    ])
  ).rows as Row[];
const objects = async (owner: string, campaign: string) =>
  (await storage.list(`u/${owner}/c/${campaign}/final/`)).objects;
const leftovers = (id: string): boolean => existsSync(join(tmpdir(), `assembly-${id}`));

/** What ffprobe says about the stored final video (real tools only). */
async function probeStored(
  key: string,
): Promise<{ seconds: number; video: number; audio: number }> {
  const file = join(scratch, `probe-${randomUUID()}.mp4`);
  const body = await storage.get(key);
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  writeFileSync(file, Buffer.concat(chunks));
  const out = JSON.parse(
    tool('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_entries',
      'stream=codec_type:format=duration',
      file,
    ]),
  ) as { streams: { codec_type: string }[]; format: { duration: string } };
  return {
    seconds: Number(out.format.duration),
    video: out.streams.filter((s) => s.codec_type === 'video').length,
    audio: out.streams.filter((s) => s.codec_type === 'audio').length,
  };
}

describe('production.assembly-render, through the worker process', () => {
  it('renders four clips to one playable video, stores it under u/ and registers it (TC-ASM, REQ-011)', async () => {
    const f = await assembly({ silent: [3] });
    await send(f.job);
    const done = await finished(f.job);
    expect(done).toMatchObject({
      state: 'done',
      cause_class: null,
      cause_message: null,
      output_media_id: f.job,
      lease_until: null,
      attempts: 1,
    });
    const media = await finals(f.campaign);
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({
      id: f.job,
      owner_id: f.owner,
      state: 'ready',
      content_type: 'video/mp4',
      storage_key: `u/${f.owner}/c/${f.campaign}/final/${f.job}.mp4`,
    });
    const stored = await objects(f.owner, f.campaign);
    expect(stored).toHaveLength(1);
    expect(Number(media[0]?.['bytes'])).toBe(stored[0]?.bytes);
    expect(leftovers(f.job)).toBe(false);
    if (real) {
      const info = await probeStored(media[0]?.['storage_key'] as string);
      expect(info.seconds).toBeGreaterThan(59);
      expect(info.seconds).toBeLessThan(62);
      expect(info).toMatchObject({ video: 1, audio: 1 });
    }
    expect(lines.join('\n')).toContain('assembly render: done');
  });

  it('resumes a render whose worker was killed mid-way: the expired lease is taken over from fetching, with one output (kill-worker-mid-render)', async () => {
    const f = await assembly({
      state: 'rendering',
      attempts: 1,
      leaseUntil: '-2 minutes',
      updatedAgo: '5 minutes',
    });
    // What the dead run left behind: its working directory.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(tmpdir(), `assembly-${f.job}`), { recursive: true });
    writeFileSync(join(tmpdir(), `assembly-${f.job}`, 'final.mp4'), 'half a video');
    await sweepNow();
    const done = await finished(f.job);
    expect(done).toMatchObject({ state: 'done', attempts: 2, output_media_id: f.job });
    expect(await finals(f.campaign)).toHaveLength(1);
    expect(await objects(f.owner, f.campaign)).toHaveLength(1);
    expect(leftovers(f.job)).toBe(false);
  });

  it('does not take over a job whose lease is still running', async () => {
    const f = await assembly({ state: 'rendering', attempts: 1, leaseUntil: '5 minutes' });
    const outcome = await worker.context
      .get(AssemblyRenderJob, { strict: false })
      .run(f.job, { info: () => undefined, warn: () => undefined });
    expect(outcome).toBe('ignored');
    expect(await row(f.job)).toMatchObject({ state: 'rendering', attempts: 1 });
    await sweepNow();
    expect(await row(f.job)).toMatchObject({ state: 'rendering', attempts: 1 });
  });

  it('after a crash between the put and the registration, the resume registers the object that is there: one output', async () => {
    const f = await assembly({
      state: 'saving',
      attempts: 1,
      leaseUntil: '-1 minutes',
      updatedAgo: '5 minutes',
    });
    await storage.put(
      `u/${f.owner}/c/${f.campaign}/final/${f.job}.mp4`,
      Buffer.from('an earlier output'),
      'video/mp4',
      1_000_000,
    );
    await sweepNow();
    const done = await finished(f.job);
    expect(done).toMatchObject({ state: 'done', attempts: 2 });
    expect(await finals(f.campaign)).toHaveLength(1);
    expect(await objects(f.owner, f.campaign)).toHaveLength(1);
  });

  it('re-sends the message of a job that stayed pending, and renders it once', async () => {
    const f = await assembly({ state: 'pending', updatedAgo: '10 minutes' });
    await sweepNow();
    expect(await finished(f.job)).toMatchObject({ state: 'done', attempts: 1 });
    expect(await finals(f.campaign)).toHaveLength(1);
  });

  it('ends a job that used all its attempts as render_failed with its cause, and a new assembly of the same clips is then possible (TC-ASM)', async () => {
    const f = await assembly({
      state: 'rendering',
      attempts: 3,
      leaseUntil: '-1 minutes',
      updatedAgo: '5 minutes',
    });
    await sweepNow();
    expect(await until(f.job, (r) => r['state'] === 'failed', 'was not failed')).toMatchObject({
      cause_class: 'render_failed',
      cause_message: 'The render was interrupted too many times. Try assembling again.',
    });
    expect(await finals(f.campaign)).toHaveLength(0);
    // The reuse index ignores a failed job, so the same clips can be assembled again.
    await pool.query(
      `insert into assembly_jobs (id, owner_id, campaign_id, reuse_hash, render_day) values ($1, $2, $3, $4, (now() at time zone 'utc')::date)`,
      [randomUUID(), f.owner, f.campaign, f.reuseHash],
    );
  });

  it('fails with input_unavailable when a clip is gone from storage or cannot be read, naming no file', async () => {
    const gone = await assembly({ missing: [2] });
    await send(gone.job);
    expect(await finished(gone.job)).toMatchObject({
      state: 'failed',
      cause_class: 'input_unavailable',
      cause_message: 'One of the clips could not be read. Check the clips, then assemble again.',
    });
    const broken = await assembly({ garbage: [4] });
    await send(broken.job);
    expect(await finished(broken.job)).toMatchObject({
      state: 'failed',
      cause_class: 'input_unavailable',
    });
    expect(await finals(broken.campaign)).toHaveLength(0);
    expect(await objects(broken.owner, broken.campaign)).toHaveLength(0);
    expect(leftovers(broken.job)).toBe(false);
  });

  it('ends a job of a campaign that is being deleted as cancelled, without rendering', async () => {
    const f = await assembly();
    await pool.query(`update campaigns set state = 'deleting' where id = $1`, [f.campaign]);
    await send(f.job);
    expect(await finished(f.job)).toMatchObject({
      state: 'failed',
      cause_class: 'cancelled_campaign_deleted',
    });
    expect(await objects(f.owner, f.campaign)).toHaveLength(0);
  });

  it('ignores a job that is already done or failed', async () => {
    const f = await assembly({ state: 'done' });
    await send(f.job);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await row(f.job)).toMatchObject({ state: 'done', attempts: 0 });
  });
});
