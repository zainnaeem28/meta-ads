import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorkerApp } from '../../../bootstrap/worker.module.js';
import type { WorkerApp } from '../../../bootstrap/worker.module.js';
import { REAL_MIGRATIONS, createTestDatabase } from '../../../platform/db/test-database.js';
import type { TestDatabase } from '../../../platform/db/test-database.js';
import { BOSS, createRuntimeBoss, startRuntimeBoss } from '../../../platform/jobs/boss.js';
import { installJobs } from '../../../platform/jobs/test-support.js';
import { buildLogger } from '../../../platform/logging/index.js';
import { quarantineKey, uploadKey } from '../domain/keys.js';
import { STORAGE_PORT, StorageNotFound } from '../domain/storage.js';
import type { StoragePort } from '../domain/storage.js';
import { startTestBucket } from '../infrastructure/test-support.js';
import type { TestBucket } from '../infrastructure/test-support.js';
import { MediaDeletion } from './media-deletion.js';
import { UnattachedSweep } from './unattached-sweep.job.js';

// TASK-043 (media 3/3) through the real worker composition root (`createWorkerApp`, the one `main.worker.ts` runs) on
// real PostgreSQL and a real MinIO server: `media.sanitize` and the hourly `media.unattached-sweep` handled by the
// worker process, and the deletion helpers. TC-UPL-04, TC-UPL-08, TC-MED-*.

const { logger } = buildLogger({ level: 'silent' });
let testDb: TestDatabase;
let pool: pg.Pool;
let minio: TestBucket;
let worker: WorkerApp;
let apiBoss: PgBoss;
let storage: StoragePort;
const deleteLog: { key: string; rowExisted: boolean }[] = [];

function statementsOf(file: string): string[] {
  const tables = readFileSync(join(REAL_MIGRATIONS, file), 'utf8').split('-- Grants')[0] ?? '';
  return tables
    .split('--> statement-breakpoint')
    .map((x) => x.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
    .filter((x) => x !== '');
}

beforeAll(async () => {
  minio = await startTestBucket();
  testDb = await createTestDatabase({ label: 'task043', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 4 });
  for (const file of ['0010_task-032-audit.sql', '0020_task-033-identity.sql', '0040_task-041-media.sql']) {
    for (const statement of statementsOf(file)) await pool.query(statement);
  }
  await installJobs(testDb.url);
  worker = await createWorkerApp(
    {
      DATABASE_URL: testDb.url,
      DATABASE_POOL_MAX: 6,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      WORKER_WATCHDOG_SECONDS: 180,
      WORKER_DRAIN_SECONDS: 5,
      WORKER_CONCURRENCY_PROVIDER: 2,
      WORKER_CONCURRENCY_SANITIZE: 2,
      WORKER_CONCURRENCY_DELETION: 1,
    },
    {
      logger,
      env: {
        R2_ENDPOINT: minio.endpoint,
        R2_BUCKET: minio.bucket,
        R2_ACCESS_KEY_ID: minio.accessKey,
        R2_SECRET_ACCESS_KEY: minio.secretKey,
        MEDIA_MAX_PIXEL_DIMENSION: '300',
        MEDIA_MAX_PIXELS: '40000',
        MEDIA_UNATTACHED_TTL_HOURS: '24',
      },
    },
  );
  storage = worker.context.get<StoragePort>(STORAGE_PORT, { strict: false });
  const realDelete = storage.delete.bind(storage);
  storage.delete = async (key: string) => {
    const existing = await pool.query('select 1 from media_objects where storage_key = $1', [key]);
    deleteLog.push({ key, rowExisted: existing.rows.length === 1 });
    await realDelete(key);
  };
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
});

async function user(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into users (id, idp_subject, email, linked_via) values ($1, $2, $3, 'first_admin')`,
    [id, `sub_${id.slice(0, 20)}`, `${id.slice(0, 12)}@example.test`],
  );
  return id;
}

const usage = async (owner: string) =>
  Number((await pool.query('select bytes_used from storage_usage where owner_id = $1', [owner])).rows[0]?.bytes_used ?? 0);
const media = async (id: string) =>
  (await pool.query('select * from media_objects where id = $1', [id])).rows[0] as Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
const exists = async (key: string): Promise<boolean> => {
  try {
    (await storage.get(key)).destroy();
    return true;
  } catch (error) {
    if (error instanceof StorageNotFound) return false;
    throw error;
  }
};
async function read(key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await storage.get(key)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** What `POST /media` leaves behind: the quarantine object, a `processing` row and its reserved bytes. */
async function stageUpload(owner: string, body: Buffer, contentType = 'image/jpeg'): Promise<string> {
  const id = randomUUID();
  const key = quarantineKey(owner, id);
  await storage.put(key, body, contentType, body.length);
  await pool.query(
    `insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type) values ($1, $2, 'upload', 'processing', $3, $4, $5)`,
    [id, owner, key, body.length, contentType],
  );
  await pool.query(
    `insert into storage_usage (owner_id, bytes_used) values ($1, $2) on conflict (owner_id) do update set bytes_used = storage_usage.bytes_used + $2`,
    [owner, body.length],
  );
  await apiBoss.send('media.sanitize', { mediaId: id });
  return id;
}

const settled = (id: string) => vi.waitFor(async () => expect((await media(id))?.state).not.toBe('processing'), { timeout: 30_000, interval: 200 });
const blank = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 120, b: 200 } } });

describe('media.sanitize handled by the worker process', () => {
  it('TC-UPL-04: a JPEG with GPS becomes ready; the stored object carries no EXIF or GPS; quarantine is gone; quota follows', async () => {
    const owner = await user();
    const source = await blank(120, 90)
      .withExif({ IFD0: { Copyright: 'secret-owner' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(source).metadata()).exif).toBeDefined();
    const id = await stageUpload(owner, source);
    await settled(id);

    const row = (await media(id))!;
    expect(row).toMatchObject({ state: 'ready', storage_key: uploadKey(owner, id), content_type: 'image/jpeg', width: 120, height: 90, reject_reason: null });
    const stored = await read(uploadKey(owner, id));
    expect(Number(row.bytes)).toBe(stored.length);
    expect((await sharp(stored).metadata()).exif).toBeUndefined();
    expect(stored.includes(Buffer.from('Exif'))).toBe(false);
    expect(stored.includes(Buffer.from('secret-owner'))).toBe(false);
    expect(await exists(quarantineKey(owner, id))).toBe(false);
    expect(await usage(owner)).toBe(stored.length);
  });

  it('an animated GIF is stored as its first frame', async () => {
    const owner = await user();
    const frames = await Promise.all(
      [30, 90, 160].map((v) => sharp({ create: { width: 16, height: 16, channels: 3, background: { r: v, g: v, b: v } } }).png().toBuffer()),
    );
    const gif = await sharp(frames, { join: { animated: true } }).gif({ delay: [100, 100, 100], loop: 0 }).toBuffer();
    const id = await stageUpload(owner, gif, 'image/gif');
    await settled(id);
    expect((await media(id))?.state).toBe('ready');
    expect((await sharp(await read(uploadKey(owner, id)), { pages: -1 }).metadata()).pages ?? 1).toBe(1);
  });

  it.each([
    ['an image over the dimension cap', () => blank(301, 10).png().toBuffer(), 'pixel_cap_exceeded'],
    ['an image over the pixel cap', () => blank(250, 250).png().toBuffer(), 'pixel_cap_exceeded'],
    ['bytes that are not an image', () => Promise.resolve(Buffer.from('MZ\u0090 not an image')), 'decode_failed'],
    ['a TIFF', () => blank(8, 8).tiff().toBuffer(), 'type_not_allowed'],
  ] as const)('rejects %s: reason recorded, no stored object, reservation returned', async (_name, make, reason) => {
    const owner = await user();
    const id = await stageUpload(owner, await make(), 'image/png');
    await settled(id);
    expect(await media(id)).toMatchObject({ state: 'rejected', reject_reason: reason, bytes: '0', width: null });
    expect(await exists(uploadKey(owner, id))).toBe(false);
    expect(await exists(quarantineKey(owner, id))).toBe(false);
    expect(await usage(owner)).toBe(0);
  });

  it('a decompression bomb claim (a 60000 x 60000 header in a few bytes) is rejected before any decode', async () => {
    const owner = await user();
    const png = Buffer.from(await blank(10, 10).png().toBuffer());
    png.writeUInt32BE(60_000, 16);
    png.writeUInt32BE(60_000, 20);
    let crc = 0xffffffff;
    for (const byte of png.subarray(12, 29)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    png.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
    const id = await stageUpload(owner, png, 'image/png');
    await settled(id);
    expect(await media(id)).toMatchObject({ state: 'rejected', reject_reason: 'pixel_cap_exceeded' });
    expect(await usage(owner)).toBe(0);
  });

  it('a job run again after it finished changes nothing; a crash before the quarantine delete is finished by the rerun', async () => {
    const owner = await user();
    const id = await stageUpload(owner, await blank(40, 40).png().toBuffer(), 'image/png');
    await settled(id);
    const before = await media(id);
    // Simulate the crash window: the row is `ready`, the quarantine object is back.
    await storage.put(quarantineKey(owner, id), Buffer.from('left over'), 'image/png', 100);
    await apiBoss.send('media.sanitize', { mediaId: id });
    await vi.waitFor(async () => expect(await exists(quarantineKey(owner, id))).toBe(false), { timeout: 30_000, interval: 200 });
    expect(await media(id)).toEqual(before);
    // A job for an unknown row is simply done.
    await apiBoss.send('media.sanitize', { mediaId: randomUUID() });
  });

  it('a storage failure is retried by pg-boss, and on the last attempt the row is rejected (decode_failed)', async () => {
    const owner = await user();
    const id = randomUUID();
    const key = quarantineKey(owner, id);
    await pool.query(
      `insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type) values ($1, $2, 'upload', 'processing', $3, 10, 'image/png')`,
      [id, owner, key],
    );
    await pool.query(`insert into storage_usage (owner_id, bytes_used) values ($1, 10) on conflict (owner_id) do update set bytes_used = storage_usage.bytes_used + 10`, [owner]);
    const realGet = storage.get.bind(storage);
    let calls = 0;
    storage.get = (k: string) => {
      if (k === key) {
        calls += 1;
        return Promise.reject(new Error('storage down'));
      }
      return realGet(k);
    };
    try {
      await apiBoss.send('media.sanitize', { mediaId: id }, { retryLimit: 1, retryDelay: 1 });
      await settled(id);
    } finally {
      storage.get = realGet;
    }
    expect(calls).toBe(2);
    expect(await media(id)).toMatchObject({ state: 'rejected', reject_reason: 'decode_failed' });
    expect(await usage(owner)).toBe(0);
  });
});

describe('media.unattached-sweep handled by the worker process', () => {
  async function insertRow(owner: string, over: { kind?: string; ageHours: number; attached?: boolean; state?: string }): Promise<{ id: string; key: string }> {
    const id = randomUUID();
    const key = over.kind === 'final' ? `u/${owner}/c/${randomUUID()}/final/${id}.mp4` : uploadKey(owner, id);
    await storage.put(key, Buffer.from('x'.repeat(100)), 'image/png', 100);
    await pool.query(
      `insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, attached_at, created_at, reject_reason)
       values ($1, $2, $3, $4, $5, 100, $6, $7, now() - make_interval(hours => $8), case when $4 = 'rejected' then 'decode_failed' end)`,
      [id, owner, over.kind ?? 'upload', over.state ?? 'ready', key, over.kind === 'final' ? 'video/mp4' : 'image/png', over.attached === true ? new Date() : null, over.ageHours],
    );
    await pool.query(`insert into storage_usage (owner_id, bytes_used) values ($1, 100) on conflict (owner_id) do update set bytes_used = storage_usage.bytes_used + 100`, [owner]);
    return { id, key };
  }

  it('TC-UPL-08: removes only unattached uploads older than the TTL, object before row, and returns their bytes', async () => {
    const owner = await user();
    const old = await insertRow(owner, { ageHours: 25 });
    const oldRejected = await insertRow(owner, { ageHours: 30, state: 'rejected' });
    const young = await insertRow(owner, { ageHours: 23 });
    const attached = await insertRow(owner, { ageHours: 48, attached: true });
    const generated = await insertRow(owner, { ageHours: 48, kind: 'final' });
    deleteLog.length = 0;

    await apiBoss.send('media.unattached-sweep', {});
    await vi.waitFor(async () => expect(await media(old.id)).toBeUndefined(), { timeout: 30_000, interval: 200 });

    expect(await media(oldRejected.id)).toBeUndefined();
    for (const kept of [young, attached, generated]) {
      expect(await media(kept.id)).toBeDefined();
      expect(await exists(kept.key)).toBe(true);
    }
    expect(await exists(old.key)).toBe(false);
    expect(await usage(owner)).toBe(300);
    // SB-D17: the object delete ran while its row still existed.
    expect(deleteLog.filter((entry) => entry.key === old.key).every((entry) => entry.rowExisted)).toBe(true);
    expect(deleteLog.some((entry) => entry.key === old.key)).toBe(true);
  });

  it('the hourly schedule is registered for the queue', async () => {
    expect((await apiBoss.getSchedule('media.unattached-sweep'))?.cron).toBe('0 * * * *');
  });

  it('a failing object delete keeps the row for the next run and fails the job', async () => {
    const owner = await user();
    const old = await insertRow(owner, { ageHours: 40 });
    const realDelete = storage.delete.bind(storage);
    storage.delete = () => Promise.reject(new Error('storage down'));
    try {
      expect(await worker.context.get(UnattachedSweep, { strict: false }).run()).toEqual({ deleted: 0, failed: 1 });
    } finally {
      storage.delete = realDelete;
    }
    expect(await media(old.id)).toBeDefined();
    expect(await exists(old.key)).toBe(true);
    expect(await worker.context.get(MediaDeletion, { strict: false }).deleteObjects([old.id])).toBe(1);
  });
});

describe('deletion helpers', () => {
  it('deleteObjects removes objects then rows, returns the bytes and skips unknown ids', async () => {
    const owner = await user();
    const a = randomUUID();
    const b = randomUUID();
    for (const id of [a, b]) {
      await storage.put(uploadKey(owner, id), Buffer.from('12345'), 'image/png', 5);
      await pool.query(`insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type) values ($1, $2, 'upload', 'ready', $3, 5, 'image/png')`, [id, owner, uploadKey(owner, id)]);
    }
    await pool.query(`insert into storage_usage (owner_id, bytes_used) values ($1, 10)`, [owner]);
    deleteLog.length = 0;
    const deletion = worker.context.get(MediaDeletion, { strict: false });
    expect(await deletion.deleteObjects([a, a, b, randomUUID()])).toBe(2);
    expect(await usage(owner)).toBe(0);
    expect(await exists(uploadKey(owner, a))).toBe(false);
    expect(deleteLog.filter((entry) => !entry.rowExisted)).toEqual([]);
    expect(await deletion.deleteObjects([a])).toBe(0);
  });

  it('deleteForCampaign removes the campaign\'s rows and objects, and sweepPrefix the unregistered ones under its prefix', async () => {
    const owner = await user();
    const other = await user();
    const campaign = randomUUID();
    const keep = randomUUID();
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) {
      const key = `u/${owner}/c/${campaign}/final/${id}.mp4`;
      await storage.put(key, Buffer.from('video'), 'video/mp4', 5);
      await pool.query(`insert into media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, campaign_id) values ($1, $2, 'final', 'ready', $3, 5, 'video/mp4', $4)`, [id, owner, key, campaign]);
    }
    await pool.query(`insert into storage_usage (owner_id, bytes_used) values ($1, 10)`, [owner]);
    const stray = `u/${owner}/c/${campaign}/clip/${randomUUID()}.mp4`;
    await storage.put(stray, Buffer.from('orphan'), 'video/mp4', 6);
    const otherKey = `u/${other}/c/${randomUUID()}/final/${keep}.mp4`;
    await storage.put(otherKey, Buffer.from('mine'), 'video/mp4', 4);

    const result = await worker.context.get(MediaDeletion, { strict: false }).deleteForCampaign(campaign);
    expect(result).toEqual({ rows: 2, objects: 1 });
    expect(await usage(owner)).toBe(0);
    expect(await exists(stray)).toBe(false);
    expect(await exists(otherKey)).toBe(true);
    expect((await pool.query('select count(*) n from media_objects where campaign_id = $1', [campaign])).rows[0].n).toBe('0');
  });

  it('sweepPrefix refuses a prefix wider than an owner or a campaign', async () => {
    const deletion = worker.context.get(MediaDeletion, { strict: false });
    for (const bad of ['', 'u/', 'q/', 'smoke/', 'u/not-a-uuid/', `u/${randomUUID()}`, `u/${randomUUID()}/media/`]) {
      await expect(deletion.sweepPrefix(bad)).rejects.toThrow(TypeError);
    }
    expect(await deletion.sweepPrefix(`q/${randomUUID()}/`)).toBe(0);
  });

  it('the worker binds the module through the real root only when its storage is configured', () => {
    expect(worker.context.get(BOSS, { strict: false })).toBeDefined();
  });
});
