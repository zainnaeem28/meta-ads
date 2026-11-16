import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiApp } from '../../bootstrap/api.module.js';
import { REAL_MIGRATIONS, adminUrl, createTestDatabase } from '../../platform/db/test-database.js';
import type { TestDatabase } from '../../platform/db/test-database.js';
import { DomainError } from '../../platform/http/domain-error.js';
import { DATABASE, isUniqueViolation } from '../../platform/db/index.js';
import type { Database } from '../../platform/db/index.js';
import { createHttpLogging } from '../../platform/logging/index.js';
import { MediaService, STORAGE_PORT } from './index.js';
import type { StoragePort } from './index.js';
import { StorageUnavailable } from './domain/storage.js';
import { startTestBucket } from './infrastructure/test-support.js';
import type { TestBucket } from './infrastructure/test-support.js';

// TASK-041 (media 1/3) on real PostgreSQL and a real MinIO server: M0005 applied as written, its grants, and the
// quota, upload, compensation, signed-URL and ownership behaviour reached through the real api composition root
// (`createApiApp`, the one `main.api.ts` runs): the MediaModule is wired there from the environment.

const U1 = '0197a1b2-0000-7000-8000-000000000001';
const U2 = '0197a1b2-0000-7000-8000-000000000002';
const U3 = '0197a1b2-0000-7000-8000-000000000003';
const UNKNOWN = '0197a1b2-0000-7000-8000-0000000000ee';
const QUOTA = 1000;

let testDb: TestDatabase;
let pool: pg.Pool;
let minio: TestBucket;
let apiApp: Awaited<ReturnType<typeof createApiApp>>['app'];
let media: MediaService;
let storage: StoragePort;
let database: Database;
const roleNames = { api: '', worker: '' };
const rolePasswords = { api: '', worker: '' };
const savedEnv: Record<string, string | undefined> = {};

const png = (n: number): Buffer => Buffer.alloc(n, 7);
const roleUrl = (role: 'api' | 'worker'): string => {
  const url = new URL(testDb.url);
  url.username = roleNames[role];
  url.password = rolePasswords[role];
  return url.toString();
};

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function tryQuery(url: string, sql: string, params: unknown[] = []) {
  try {
    return { ok: true as const, rows: (await withClient(url, (c) => c.query(sql, params))).rows as Record<string, unknown>[] };
  } catch (error) {
    return { ok: false as const, code: (error as { code?: string }).code ?? 'none' };
  }
}

/** A migration's statements (`tables` before `-- Grants`, `grants` after it), roles renamed to this run's. */
function statementsOf(file: string, part: 'tables' | 'grants'): string[] {
  const text = readFileSync(join(REAL_MIGRATIONS, file), 'utf8');
  const [tables = '', grants = ''] = text.split('-- Grants');
  const body = part === 'tables' ? tables : grants.slice(grants.indexOf('\n'));
  return body
    .split('--> statement-breakpoint')
    .map((x) =>
      x
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .replace(/\bapp_api\b/g, roleNames.api)
        .replace(/\bapp_worker\b/g, roleNames.worker)
        .trim(),
    )
    .filter((x) => x !== '');
}

const usage = async (owner: string): Promise<number> =>
  Number((await pool.query('SELECT bytes_used FROM storage_usage WHERE owner_id = $1', [owner])).rows[0]?.bytes_used ?? 0);
const rowCount = async (owner: string): Promise<number> =>
  Number((await pool.query('SELECT count(*) AS n FROM media_objects WHERE owner_id = $1', [owner])).rows[0]?.n);
const makeReady = (id: string) => pool.query(`UPDATE media_objects SET state = 'ready' WHERE id = $1`, [id]);

async function denial(promise: Promise<unknown>): Promise<DomainError> {
  const error: unknown = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

beforeAll(async () => {
  minio = await startTestBucket();
  testDb = await createTestDatabase({ label: 'task041', migrations: false });
  pool = new pg.Pool({ connectionString: testDb.url, max: 3 });
  const suffix = randomBytes(4).toString('hex');
  for (const role of ['api', 'worker'] as const) {
    roleNames[role] = `app_${role}_t041_${suffix}`;
    rolePasswords[role] = randomBytes(12).toString('hex');
    await withClient(adminUrl(), (c) =>
      c.query(`CREATE ROLE "${roleNames[role]}" LOGIN NOSUPERUSER PASSWORD '${rolePasswords[role]}'`),
    );
  }
  const platform = readFileSync(join(REAL_MIGRATIONS, '0001_task-025-platform.sql'), 'utf8');
  for (const statement of platform.split('-- Grants')[0]?.split('--> statement-breakpoint') ?? []) {
    if (/^\s*CREATE (TABLE|INDEX|UNIQUE INDEX) "?(idempotency_records|rate_limit_buckets)/.test(statement)) {
      await pool.query(statement);
    }
  }
  for (const file of ['0010_task-032-audit.sql', '0020_task-033-identity.sql', '0040_task-041-media.sql']) {
    for (const statement of statementsOf(file, 'tables')) await pool.query(statement);
  }
  for (const statement of statementsOf('0040_task-041-media.sql', 'grants')) await pool.query(statement);
  await pool.query(`GRANT USAGE ON SCHEMA public TO "${roleNames.api}", "${roleNames.worker}"`);
  const { installJobs } = await import('../../platform/jobs/test-support.js');
  await installJobs(testDb.url);
  for (const [n, id] of [['1', U1], ['2', U2], ['3', U3]] as const) {
    await pool.query(
      `INSERT INTO users (id, idp_subject, email, linked_via) VALUES ($1, $2, $3, 'first_admin')`,
      [id, `sub_${n}`, `u${n}@example.test`],
    );
  }
  const env: Record<string, string | undefined> = {
    KEK_PUBLIC_KEYS: undefined,
    KEK_PRIVATE_KEYS: undefined,
    R2_ENDPOINT: minio.endpoint,
    R2_BUCKET: minio.bucket,
    R2_ACCESS_KEY_ID: minio.accessKey,
    R2_SECRET_ACCESS_KEY: minio.secretKey,
    STORAGE_PUBLIC_ORIGIN: minio.endpoint,
    STORAGE_QUOTA_BYTES: String(QUOTA),
    MEDIA_MAX_UPLOAD_BYTES: undefined,
    MEDIA_BROWSER_URL_TTL_SEC: undefined,
    PROVIDER_FETCH_URL_TTL_SEC: undefined,
  };
  for (const [name, value] of Object.entries(env)) {
    savedEnv[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  ({ app: apiApp } = await createApiApp(
    {
      WEB_ORIGIN: 'http://localhost:3000',
      APP_ENV: 'development',
      DATABASE_URL: testDb.url,
      DATABASE_POOL_MAX: 6,
      DATABASE_ACQUIRE_TIMEOUT_MS: 5000,
      RATE_LIMIT_IP_KEY: 'r'.repeat(40),
    },
    createHttpLogging({ level: 'silent' }),
  ));
  media = apiApp.get(MediaService, { strict: false });
  storage = apiApp.get<StoragePort>(STORAGE_PORT, { strict: false });
  database = apiApp.get<Database>(DATABASE, { strict: false });
}, 300_000);

afterAll(async () => {
  await apiApp?.close();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await pool?.end();
  await testDb?.drop();
  for (const name of Object.values(roleNames)) {
    if (name !== '') await withClient(adminUrl(), (c) => c.query(`DROP ROLE IF EXISTS "${name}"`)).catch(() => undefined);
  }
  await minio?.stop();
});

describe('M0005 as written', () => {
  it('has the dictionary constraints: state and reject pairing, kind, content type, sizes, unique key', async () => {
    const insert = (over: Record<string, unknown>) => {
      const row = { id: crypto.randomUUID(), kind: 'upload', state: 'processing', key: `k/${crypto.randomUUID()}`, bytes: 1, type: 'image/png', w: 1, h: 1, reason: null, ...over };
      return tryQuery(
        testDb.url,
        `INSERT INTO media_objects (id, owner_id, kind, state, storage_key, bytes, content_type, width, height, reject_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [row.id, U1, row.kind, row.state, row.key, row.bytes, row.type, row.w, row.h, row.reason],
      );
    };
    expect((await insert({})).ok).toBe(true);
    expect((await insert({ state: 'rejected', reason: 'decode_failed' })).ok).toBe(true);
    for (const bad of [
      { state: 'rejected' }, // rejected without a reason
      { reason: 'decode_failed' }, // a reason on a non-rejected row
      { state: 'rejected', reason: 'made_up' },
      { kind: 'avatar' },
      { state: 'queued' },
      { type: 'image/svg+xml' },
      { bytes: -1 },
      { w: 0 },
      { h: -3 },
    ]) {
      const r = await insert(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(!r.ok && r.code).toBe('23514');
    }
    const key = `k/${crypto.randomUUID()}`;
    expect((await insert({ key })).ok).toBe(true);
    const dup = await insert({ key });
    expect(!dup.ok && dup.code).toBe('23505');
    const negative = await tryQuery(testDb.url, 'INSERT INTO storage_usage (owner_id, bytes_used) VALUES ($1, -1)', [U2]);
    expect(!negative.ok && negative.code).toBe('23514');
    await pool.query('DELETE FROM media_objects WHERE owner_id = $1', [U1]);
  });

  it('cascades from users and grants both runtime roles the two tables but not TRUNCATE or DDL', async () => {
    await pool.query(`INSERT INTO users (id, idp_subject, email, linked_via) VALUES ($1, 'sub_gone', 'gone@example.test', 'first_admin')`, ['0197a1b2-0000-7000-8000-0000000000a9']);
    await pool.query(`INSERT INTO storage_usage (owner_id, bytes_used) VALUES ($1, 5)`, ['0197a1b2-0000-7000-8000-0000000000a9']);
    await pool.query('DELETE FROM users WHERE id = $1', ['0197a1b2-0000-7000-8000-0000000000a9']);
    expect(await usage('0197a1b2-0000-7000-8000-0000000000a9')).toBe(0);
    for (const role of ['api', 'worker'] as const) {
      const url = roleUrl(role);
      expect((await tryQuery(url, 'SELECT count(*) FROM media_objects')).ok).toBe(true);
      expect((await tryQuery(url, 'UPDATE storage_usage SET bytes_used = bytes_used')).ok).toBe(true);
      expect((await tryQuery(url, 'DELETE FROM media_objects WHERE false')).ok).toBe(true);
      for (const statement of ['TRUNCATE media_objects', 'TRUNCATE storage_usage', 'ALTER TABLE media_objects ADD COLUMN x int']) {
        const r = await tryQuery(url, statement);
        expect(!r.ok && r.code, statement).toBe('42501');
      }
    }
  });
});

describe('through the real api composition root', () => {
  it('wires the media service and the storage port from the environment', () => {
    expect(media).toBeInstanceOf(MediaService);
    expect(storage).toBeDefined();
  });

  it('refuses to start when the browser URL life is out of range (TC-MED-02)', async () => {
    process.env['MEDIA_BROWSER_URL_TTL_SEC'] = '960';
    try {
      await expect(
        createApiApp(
          { WEB_ORIGIN: 'http://localhost:3000', APP_ENV: 'development', DATABASE_URL: testDb.url, DATABASE_POOL_MAX: 2, DATABASE_ACQUIRE_TIMEOUT_MS: 5000, RATE_LIMIT_IP_KEY: 'r'.repeat(40) },
          createHttpLogging({ level: 'silent' }),
        ),
      ).rejects.toThrow('MEDIA_BROWSER_URL_TTL_SEC');
    } finally {
      delete process.env['MEDIA_BROWSER_URL_TTL_SEC'];
    }
  });

  it('counts the quota before the put and refuses past it with used and allowed (TC-MED-03)', async () => {
    const first = await media.upload({ ownerId: U1, body: png(600), declaredBytes: 600, contentType: 'image/png' });
    const second = await media.upload({ ownerId: U1, body: png(399), declaredBytes: 399, contentType: 'image/jpeg' });
    expect(await usage(U1)).toBe(999);
    await expect(media.quota(U1)).resolves.toEqual({ usedBytes: 999, allowedBytes: QUOTA, remainingBytes: 1 });
    const refused = await denial(media.upload({ ownerId: U1, body: png(2), declaredBytes: 2, contentType: 'image/png' }));
    expect(refused.code).toBe('storage_quota_reached');
    expect(refused.details).toEqual([
      { field: 'usedBytes', code: 'used', message: '999' },
      { field: 'allowedBytes', code: 'allowed', message: String(QUOTA) },
    ]);
    // Nothing was stored for the refused upload, and the first two are in the quarantine prefix of their owner.
    expect(await rowCount(U1)).toBe(2);
    const listed = (await storage.list(`q/${U1}/`)).objects;
    expect(listed.map((o) => o.key).sort()).toEqual([first.storageKey, second.storageKey].sort());
    // Quota is per owner.
    await media.upload({ ownerId: U2, body: png(900), declaredBytes: 900, contentType: 'image/png' });
    // The stored bytes are the quarantine object, not a path the client chose.
    expect(first.storageKey).toBe(`q/${U1}/${first.id}`);
    await pool.query('SELECT 1');
  });

  it('serialises concurrent uploads of one owner on the usage lock: the quota is never passed', async () => {
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => media.upload({ ownerId: U3, body: png(600), declaredBytes: 600, contentType: 'image/png' })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused.map((r) => (r.reason as DomainError).code)).toEqual(['storage_quota_reached', 'storage_quota_reached']);
    expect(await usage(U3)).toBe(600);
    expect(await rowCount(U3)).toBe(1);
    await pool.query('DELETE FROM media_objects WHERE owner_id = $1', [U3]);
    await pool.query('UPDATE storage_usage SET bytes_used = 0 WHERE owner_id = $1', [U3]);
    await storage.deletePrefix(`q/${U3}/`, 100);
  });

  it('deletes the row and returns the reservation when the put fails after the row exists', async () => {
    const before = await usage(U3);
    let rowsDuringPut = -1;
    const put = vi.spyOn(storage, 'put').mockImplementationOnce(async () => {
      rowsDuringPut = await rowCount(U3);
      throw new StorageUnavailable('put');
    });
    const error = await denial(media.upload({ ownerId: U3, body: png(300), declaredBytes: 300, contentType: 'image/png' }));
    put.mockRestore();
    expect(error.code).toBe('service_unavailable');
    expect(rowsDuringPut).toBe(1); // the row was committed before the put
    expect(await rowCount(U3)).toBe(0); // and removed by the compensating transaction
    expect(await usage(U3)).toBe(before);
    expect((await storage.list(`q/${U3}/`)).objects).toEqual([]);
  });

  it('keeps only the stored size when the file is smaller than the announced request', async () => {
    const { id, bytes } = await media.upload({ ownerId: U3, body: png(300), declaredBytes: 400, contentType: 'image/webp' });
    expect(bytes).toBe(300);
    expect(await usage(U3)).toBe(300);
    expect(Number((await pool.query('SELECT bytes FROM media_objects WHERE id = $1', [id])).rows[0]?.bytes)).toBe(300);
    await media.upload({ ownerId: U3, body: png(300), declaredBytes: 300, contentType: 'image/png' });
    expect(await usage(U3)).toBe(600);
  });

  it('a foreign and a never-existing media id give the same 404 and no URL (TC-MED-01, TC-UPL-07)', async () => {
    const { id } = await media.upload({ ownerId: U2, body: png(10), declaredBytes: 10, contentType: 'image/png' });
    await makeReady(id);
    const foreign = await denial(media.signedUrl('browser', { ownerId: U1, mediaId: id }));
    const missing = await denial(media.signedUrl('browser', { ownerId: U1, mediaId: UNKNOWN }));
    expect({ code: foreign.code, message: foreign.safeMessage, details: foreign.details }).toEqual({
      code: 'not_found',
      message: missing.safeMessage,
      details: missing.details,
    });
    expect((await denial(media.signedUrl('provider-fetch', { ownerId: U1, mediaId: id }))).code).toBe('not_found');
    expect((await denial(database.uow.run((tx) => media.attach(tx, U1, id)))).code).toBe('not_found');
    // The raw bucket path of the same object is no way in either: anonymous reads and listings are refused.
    const key = `q/${U2}/${id}`;
    expect((await fetch(`${minio.endpoint}/${minio.bucket}/${key}`)).status).toBe(403);
    expect((await fetch(`${minio.endpoint}/${minio.bucket}?list-type=2&prefix=q/`)).status).toBe(403);
  });

  it('signs a ready object for the browser (5 min) and the provider (60 min), for that object only (TC-MED-02, 04)', async () => {
    const { id, storageKey } = await media.upload({ ownerId: U2, body: Buffer.from('signed-bytes'), declaredBytes: 12, contentType: 'image/png' });
    await makeReady(id);
    const other = await media.upload({ ownerId: U2, body: Buffer.from('sibling'), declaredBytes: 7, contentType: 'image/png' });
    await makeReady(other.id);

    const browser = await media.signedUrl('browser', { ownerId: U2, mediaId: id, disposition: { type: 'attachment', filename: 'shot.png' } });
    expect(browser.expiresInSec).toBe(300);
    expect(new URL(browser.url).searchParams.get('X-Amz-Expires')).toBe('300');
    const res = await fetch(browser.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment; filename="shot.png"');
    expect(await res.text()).toBe('signed-bytes');

    const provider = await media.signedUrl('provider-fetch', { ownerId: U2, mediaId: id });
    expect(provider.expiresInSec).toBe(3600);
    expect(new URL(provider.url).searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(new URL(provider.url).pathname).toBe(`/${minio.bucket}/${storageKey}`);
    const sibling = new URL(provider.url);
    sibling.pathname = `/${minio.bucket}/q/${U2}/${other.id}`;
    expect((await fetch(sibling)).status).toBe(403);
  });

  it('holds back an object that is still processing and one that was rejected', async () => {
    const { id } = await media.upload({ ownerId: U2, body: png(5), declaredBytes: 5, contentType: 'image/png' });
    expect((await denial(media.signedUrl('provider-fetch', { ownerId: U2, mediaId: id }))).code).toBe('media_not_ready');
    expect((await denial(database.uow.run((tx) => media.attach(tx, U2, id)))).code).toBe('media_not_ready');
    await pool.query(`UPDATE media_objects SET state = 'rejected', reject_reason = 'decode_failed' WHERE id = $1`, [id]);
    expect((await denial(media.signedUrl('browser', { ownerId: U2, mediaId: id }))).code).toBe('not_found');
  });

  it('attaches once, registers worker outputs with their quota, and unregisters them', async () => {
    const { id } = await media.upload({ ownerId: U1, body: png(1), declaredBytes: 1, contentType: 'image/gif' }).catch(async () => {
      await pool.query('UPDATE storage_usage SET bytes_used = 0 WHERE owner_id = $1', [U1]);
      return media.upload({ ownerId: U1, body: png(1), declaredBytes: 1, contentType: 'image/gif' });
    });
    await makeReady(id);
    const attachedAt = async () => (await pool.query('SELECT attached_at FROM media_objects WHERE id = $1', [id])).rows[0]?.attached_at as Date | null;
    expect(await attachedAt()).toBeNull();
    await database.uow.run((tx) => media.attach(tx, U1, id));
    const first = await attachedAt();
    expect(first).toBeInstanceOf(Date);
    await database.uow.run((tx) => media.attach(tx, U1, id));
    expect(await attachedAt()).toEqual(first);

    const before = await usage(U2);
    const campaign = '0197a1b2-0000-7000-8000-0000000000c1';
    const clipId = await database.uow.run((tx) =>
      media.registerObject(tx, { ownerId: U2, kind: 'clip', storageKey: `u/${U2}/c/${campaign}/clip/${crypto.randomUUID()}.mp4`, bytes: 5000, contentType: 'video/mp4', campaignId: campaign, width: 720, height: 1280 }),
    );
    expect(await usage(U2)).toBe(before + 5000); // paid-for output is recorded even past the quota
    await expect(media.quota(U2)).resolves.toMatchObject({ usedBytes: before + 5000, remainingBytes: 0 });
    const dup = await database.uow.run((tx) => media.registerObject(tx, { ownerId: U2, kind: 'clip', storageKey: `u/${U2}/x`, bytes: 1, contentType: 'video/mp4' }).then(() => media.registerObject(tx, { ownerId: U2, kind: 'clip', storageKey: `u/${U2}/x`, bytes: 1, contentType: 'video/mp4' }))).catch((e: unknown) => e);
    expect(isUniqueViolation(dup, 'media_objects_storage_key_uq')).toBe(true); // one row per object key
    const removed = await database.uow.run((tx) => media.unregisterObject(tx, clipId));
    expect(removed?.bytes).toBe(5000);
    expect(await usage(U2)).toBe(before);
  });
});
