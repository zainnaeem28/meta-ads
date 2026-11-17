import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageKeyExists, StorageNotFound, StorageTooLarge } from '../domain/storage.js';
import type { StoragePort } from '../domain/storage.js';
import { MinioStorage, R2Storage } from './s3-storage.js';
import { startTestBucket } from './test-support.js';
import type { TestBucket } from './test-support.js';

// StoragePort adapter contract (ARCHITECTURE §1.3, TC-MED-01..05) on a real MinIO server. The same suite is the
// R2 contract run (TC-MED-30, owner item G-1): it runs against R2 only when R2_CONTRACT_* is set in a deployment
// environment, and is otherwise recorded NOT_RUN; nothing waits for it.

const body = async (stream: Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
};

let minio: TestBucket;
let storage: StoragePort;
let anonymous: string;
const run = Date.now().toString(36);

beforeAll(async () => {
  minio = await startTestBucket();
  storage = new MinioStorage({
    endpoint: minio.endpoint,
    bucket: minio.bucket,
    accessKeyId: minio.accessKey,
    secretAccessKey: minio.secretKey,
  });
  anonymous = `${minio.endpoint}/${minio.bucket}`;
}, 120_000);

afterAll(async () => {
  await minio?.stop();
});

describe('MinIO adapter contract', () => {
  it('puts conditionally: a second put to a taken key fails and the first bytes stay', async () => {
    const key = `q/${run}/cond`;
    await expect(storage.put(key, Buffer.from('first'), 'image/png', 100)).resolves.toEqual({
      bytes: 5,
    });
    await expect(
      storage.put(key, Readable.from(['second']), 'image/png', 100),
    ).rejects.toBeInstanceOf(StorageKeyExists);
    expect(await body(await storage.get(key))).toBe('first');
  });

  it('stores nothing when the body is over maxBytes', async () => {
    const key = `q/${run}/big`;
    await expect(
      storage.put(key, Readable.from([Buffer.alloc(30)]), 'image/png', 20),
    ).rejects.toBeInstanceOf(StorageTooLarge);
    await expect(storage.get(key)).rejects.toBeInstanceOf(StorageNotFound);
  });

  it('gets and deletes; delete of a missing key is not an error', async () => {
    const key = `q/${run}/del`;
    await storage.put(key, Buffer.from('bye'), 'image/png', 10);
    await storage.delete(key);
    await expect(storage.get(key)).rejects.toBeInstanceOf(StorageNotFound);
    await expect(storage.delete(key)).resolves.toBeUndefined();
  });

  it('deletes a prefix in batches and leaves a sibling prefix alone', async () => {
    for (let i = 0; i < 25; i++)
      await storage.put(`u/${run}-a/media/${String(i)}`, Buffer.from('x'), 'image/png', 10);
    await storage.put(`u/${run}-b/media/keep`, Buffer.from('y'), 'image/png', 10);
    await expect(storage.deletePrefix(`u/${run}-a/`, 10)).resolves.toBe(25);
    expect((await storage.list(`u/${run}-a/`)).objects).toEqual([]);
    expect((await storage.list(`u/${run}-b/`)).objects.map((o) => o.key)).toEqual([
      `u/${run}-b/media/keep`,
    ]);
    await expect(storage.deletePrefix(`u/${run}-a/`, 10)).resolves.toBe(0);
  });

  it('lists a prefix page by page with sizes', async () => {
    for (const n of ['1', '2', '3'])
      await storage.put(`smoke/${run}/${n}`, Buffer.alloc(Number(n), 1), 'image/png', 10);
    const first = await storage.list(`smoke/${run}/`);
    expect(first.objects.map((o) => [o.key, o.bytes])).toEqual([
      [`smoke/${run}/1`, 1],
      [`smoke/${run}/2`, 2],
      [`smoke/${run}/3`, 3],
    ]);
    expect(first.nextCursor).toBeUndefined();
  });

  it('presigns a GET with the disposition for exactly one object (TC-MED-04)', async () => {
    const key = `u/${run}-c/media/one`;
    await storage.put(key, Buffer.from('payload'), 'image/png', 100);
    await storage.put(`u/${run}-c/media/two`, Buffer.from('other'), 'image/png', 100);
    const url = await storage.presignGet(key, 60, { type: 'attachment', filename: 'photo.png' });
    const ok = await fetch(url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-disposition')).toBe(
      `attachment; filename="photo.png"; filename*=UTF-8''photo.png`,
    );
    expect(await ok.text()).toBe('payload');
    // The signature covers this key only: the sibling, the prefix and a bucket listing are refused.
    const sibling = new URL(url);
    sibling.pathname = sibling.pathname.replace('/one', '/two');
    expect((await fetch(sibling)).status).toBe(403);
    const listing = new URL(url);
    listing.pathname = `/${minio.bucket}`;
    listing.searchParams.set('list-type', '2');
    expect((await fetch(listing)).status).toBe(403);
    // Read only: the URL cannot write or delete.
    expect((await fetch(url, { method: 'PUT', body: 'x' })).status).toBe(403);
    expect((await fetch(url, { method: 'DELETE' })).status).toBe(403);
  });

  it('refuses a URL after its life ends (TC-MED-02)', async () => {
    const key = `u/${run}-d/media/short`;
    await storage.put(key, Buffer.from('soon gone'), 'image/png', 100);
    const url = await storage.presignGet(key, 2, { type: 'inline' });
    expect((await fetch(url)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect((await fetch(url)).status).toBe(403);
  });

  it('denies anonymous read of a guessed path and anonymous listing (TC-MED-01, TC-MED-05)', async () => {
    const key = `u/${run}-e/media/secret`;
    await storage.put(key, Buffer.from('private'), 'image/png', 100);
    expect((await fetch(`${anonymous}/${key}`)).status).toBe(403);
    expect((await fetch(`${anonymous}?list-type=2&prefix=u/`)).status).toBe(403);
    // MinIO may close the connection on an unsigned upload before answering; a refused write is either way.
    const write = await fetch(`${anonymous}/${key}`, { method: 'PUT', body: 'x' }).then(
      (r) => r.status,
      () => 403,
    );
    expect(write).toBe(403);
    expect(await body(await storage.get(key))).toBe('private');
  });
});

const r2 = process.env['R2_CONTRACT_ENDPOINT'];
describe.skipIf(r2 === undefined)('R2 adapter contract (TC-MED-30)', () => {
  it('puts, presigns, reads and deletes on a smoke key', async () => {
    const real = new R2Storage({
      endpoint: r2 ?? '',
      bucket: process.env['R2_CONTRACT_BUCKET'] ?? '',
      accessKeyId: process.env['R2_CONTRACT_ACCESS_KEY_ID'] ?? '',
      secretAccessKey: process.env['R2_CONTRACT_SECRET_ACCESS_KEY'] ?? '',
    });
    const key = `smoke/${run}`;
    await real.put(key, Buffer.from('r2'), 'image/png', 10);
    await expect(real.put(key, Buffer.from('r2'), 'image/png', 10)).rejects.toBeInstanceOf(
      StorageKeyExists,
    );
    const url = await real.presignGet(key, 60, { type: 'inline' });
    expect(await (await fetch(url)).text()).toBe('r2');
    await real.delete(key);
  });
});
