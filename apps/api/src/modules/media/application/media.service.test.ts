import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { quarantineKey, uploadKey } from '../domain/keys.js';
import {
  StorageKeyExists,
  StorageNotFound,
  StorageTooLarge,
  StorageUnavailable,
} from '../domain/storage.js';
import type { StoragePort } from '../domain/storage.js';
import { MediaService } from './media.service.js';
import type { MediaConfig, MediaRecord, MediaRepository, NewMedia } from './ports.js';

const A = '0197a1b2-0000-7000-8000-000000000001';
const B = '0197a1b2-0000-7000-8000-000000000002';
const M1 = '0197a1b2-0000-7000-8000-0000000000a1';
const CONFIG: MediaConfig = {
  quotaBytes: 1000,
  maxUploadBytes: 800,
  browserUrlTtlSec: 300,
  providerFetchUrlTtlSec: 3600,
};

class FakeRepository implements MediaRepository {
  rows = new Map<string, MediaRecord>();
  used = new Map<string, number>();
  locks = 0;
  async lockUsage(_tx: DbTx, ownerId: string): Promise<number> {
    this.locks++;
    return this.used.get(ownerId) ?? 0;
  }
  async usage(_tx: DbTx, ownerId: string): Promise<number> {
    return this.used.get(ownerId) ?? 0;
  }
  async addUsage(_tx: DbTx, ownerId: string, delta: number): Promise<void> {
    this.used.set(ownerId, (this.used.get(ownerId) ?? 0) + delta);
  }
  async insert(_tx: DbTx, media: NewMedia): Promise<void> {
    this.rows.set(media.id, { ...media, attachedAt: null, rejectReason: null, createdAt: new Date() });
  }
  async find(_tx: DbTx, id: string): Promise<MediaRecord | null> {
    return this.rows.get(id) ?? null;
  }
  async setBytes(_tx: DbTx, id: string, bytes: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, bytes });
  }
  async attach(_tx: DbTx, ownerId: string, id: string, campaignId: string | null): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.ownerId !== ownerId) return false;
    this.rows.set(id, { ...row, attachedAt: row.attachedAt ?? new Date(), campaignId: campaignId ?? row.campaignId });
    return true;
  }
  async remove(_tx: DbTx, id: string): Promise<MediaRecord | null> {
    const row = this.rows.get(id) ?? null;
    this.rows.delete(id);
    return row;
  }
}

function setup(storage: Partial<StoragePort> = {}) {
  const repository = new FakeRepository();
  const port: StoragePort = {
    put: vi.fn(async (_k, body, _t, max) => ({ bytes: Buffer.isBuffer(body) ? Math.min(body.length, max) : 0 })),
    get: vi.fn(),
    delete: vi.fn(),
    deletePrefix: vi.fn(),
    list: vi.fn(),
    presignGet: vi.fn(async (key, ttl) => `https://signed.test/${key}?ttl=${String(ttl)}`),
    ...storage,
  };
  const database = { uow: { run: async <T>(fn: (tx: DbTx) => Promise<T>) => fn({} as DbTx) } };
  const service = new MediaService(database as never, repository, port, CONFIG);
  return { service, repository, port };
}

async function code(promise: Promise<unknown>): Promise<DomainError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

const png = (n: number) => Buffer.alloc(n, 1);

describe('upload', () => {
  it('reserves quota, inserts a processing row and puts to the quarantine key', async () => {
    const { service, repository, port } = setup();
    const result = await service.upload({ ownerId: A, body: png(500), declaredBytes: 500, contentType: 'image/png' });
    expect(result).toMatchObject({ state: 'processing', bytes: 500, storageKey: quarantineKey(A, result.id) });
    expect(repository.used.get(A)).toBe(500);
    expect(repository.rows.get(result.id)).toMatchObject({ kind: 'upload', state: 'processing', bytes: 500 });
    expect(port.put).toHaveBeenCalledWith(result.storageKey, expect.anything(), 'image/png', 500);
    await expect(service.quota(A)).resolves.toEqual({ usedBytes: 500, allowedBytes: 1000, remainingBytes: 500 });
  });

  it('refuses past the quota with the used and allowed amounts, before any put', async () => {
    const { service, repository, port } = setup();
    await service.upload({ ownerId: A, body: png(700), declaredBytes: 700, contentType: 'image/png' });
    await service.upload({ ownerId: A, body: png(299), declaredBytes: 299, contentType: 'image/png' });
    expect(repository.used.get(A)).toBe(999);
    const error = await code(service.upload({ ownerId: A, body: png(2), declaredBytes: 2, contentType: 'image/png' }));
    expect(error.code).toBe('storage_quota_reached');
    expect(error.details).toEqual([
      { field: 'usedBytes', code: 'used', message: '999' },
      { field: 'allowedBytes', code: 'allowed', message: '1000' },
    ]);
    expect(port.put).toHaveBeenCalledTimes(2);
    expect(repository.rows.size).toBe(2);
    // Another owner is unaffected.
    await service.upload({ ownerId: B, body: png(700), declaredBytes: 700, contentType: 'image/png' });
  });

  it('deletes the row and returns the reservation when the put fails (compensating transaction)', async () => {
    const seen: number[] = [];
    const repo = { current: undefined as FakeRepository | undefined };
    const { service, repository } = setup({
      put: vi.fn(async () => {
        seen.push(repo.current?.rows.size ?? -1);
        throw new StorageUnavailable('put');
      }),
    });
    repo.current = repository;
    const error = await code(service.upload({ ownerId: A, body: png(100), declaredBytes: 100, contentType: 'image/png' }));
    expect(error.code).toBe('service_unavailable');
    expect(seen).toEqual([1]); // the row existed when the put ran
    expect(repository.rows.size).toBe(0);
    expect(repository.used.get(A)).toBe(0);
  });

  it('keeps the original failure when the compensation itself fails', async () => {
    const { service, repository } = setup({ put: vi.fn(async () => { throw new StorageKeyExists(); }) });
    repository.remove = async () => { throw new Error('db down'); };
    expect((await code(service.upload({ ownerId: A, body: png(1), declaredBytes: 1, contentType: 'image/png' }))).code)
      .toBe('service_unavailable');
  });

  it('maps a body longer than announced to 413 and releases the reservation; other errors pass through', async () => {
    const { service, repository } = setup({ put: vi.fn(async () => { throw new StorageTooLarge(10); }) });
    expect((await code(service.upload({ ownerId: A, body: png(10), declaredBytes: 10, contentType: 'image/png' }))).code)
      .toBe('payload_too_large');
    expect(repository.used.get(A)).toBe(0);
    const odd = setup({ put: vi.fn(async () => { throw new TypeError('boom'); }) });
    await expect(odd.service.upload({ ownerId: A, body: png(10), declaredBytes: 10, contentType: 'image/png' }))
      .rejects.toThrow('boom');
  });

  it('keeps only the stored size when the file is smaller than the announced request', async () => {
    const { service, repository } = setup({ put: vi.fn(async () => ({ bytes: 300 })) });
    const { id } = await service.upload({ ownerId: A, body: Readable.from([png(300)]), declaredBytes: 400, contentType: 'image/gif' });
    expect(repository.rows.get(id)?.bytes).toBe(300);
    expect(repository.used.get(A)).toBe(300);
  });

  it.each([
    ['application/pdf', 100, 'unsupported_media_type'],
    ['image/svg+xml', 100, 'unsupported_media_type'],
    ['image/png', 0, 'validation_failed'],
    ['image/png', 1.5, 'validation_failed'],
    ['image/png', 801, 'payload_too_large'],
  ])('refuses %s of %s bytes with %s before touching storage', async (type, bytes, expected) => {
    const { service, repository, port } = setup();
    expect((await code(service.upload({ ownerId: A, body: png(1), declaredBytes: bytes, contentType: type }))).code).toBe(expected);
    expect(port.put).not.toHaveBeenCalled();
    expect(repository.rows.size).toBe(0);
  });
});

describe('registerObject, attach, unregisterObject', () => {
  const tx = {} as DbTx;
  const ready = (service: MediaService, id = M1) =>
    service.registerObject(tx, { id, ownerId: A, kind: 'upload', storageKey: uploadKey(A, id), bytes: 250, contentType: 'image/png', width: 10, height: 20 });

  it('records an object the caller stored and moves the quota with it', async () => {
    const { service, repository } = setup();
    await expect(ready(service)).resolves.toBe(M1);
    expect(repository.rows.get(M1)).toMatchObject({ state: 'ready', bytes: 250, width: 10, height: 20 });
    expect(repository.used.get(A)).toBe(250);
    const generated = await service.registerObject(tx, { ownerId: A, kind: 'clip', storageKey: uploadKey(A, M1) + 'x', bytes: 5, contentType: 'video/mp4', campaignId: B, state: 'processing' });
    expect(repository.rows.get(generated)).toMatchObject({ campaignId: B, state: 'processing' });
  });

  it('is not refused over quota (paid-for output) and rejects foreign keys and bad sizes', async () => {
    const { service, repository } = setup();
    await service.registerObject(tx, { ownerId: A, kind: 'final', storageKey: uploadKey(A, M1), bytes: 5000, contentType: 'video/mp4' });
    expect(repository.used.get(A)).toBe(5000);
    await expect(service.registerObject(tx, { ownerId: A, kind: 'final', storageKey: uploadKey(B, M1), bytes: 1, contentType: 'video/mp4' })).rejects.toThrow(TypeError);
    await expect(service.registerObject(tx, { ownerId: A, kind: 'final', storageKey: uploadKey(A, M1), bytes: -1, contentType: 'video/mp4' })).rejects.toThrow(TypeError);
  });

  it('attaches a ready upload once, and refuses processing, rejected, foreign and unknown ids', async () => {
    const { service, repository } = setup();
    await ready(service);
    await service.attach(tx, A, M1, B);
    const first = repository.rows.get(M1)?.attachedAt;
    expect(first).toBeInstanceOf(Date);
    await service.attach(tx, A, M1);
    expect(repository.rows.get(M1)?.attachedAt).toBe(first);
    expect(repository.rows.get(M1)?.campaignId).toBe(B);

    expect((await code(service.attach(tx, B, M1))).code).toBe('not_found');
    expect((await code(service.attach(tx, A, '0197a1b2-0000-7000-8000-0000000000ff'))).code).toBe('not_found');
    const row = repository.rows.get(M1) as MediaRecord;
    repository.rows.set(M1, { ...row, state: 'processing' });
    expect((await code(service.attach(tx, A, M1))).code).toBe('media_not_ready');
    repository.rows.set(M1, { ...row, state: 'rejected', rejectReason: 'decode_failed' });
    expect((await code(service.attach(tx, A, M1))).code).toBe('not_found');
  });

  it('unregisters a row and returns its bytes; a missing row changes nothing', async () => {
    const { service, repository } = setup();
    await ready(service);
    expect((await service.unregisterObject(tx, M1))?.storageKey).toBe(uploadKey(A, M1));
    expect(repository.used.get(A)).toBe(0);
    await expect(service.unregisterObject(tx, M1)).resolves.toBeNull();
    await ready(service);
    repository.rows.set(M1, { ...(repository.rows.get(M1) as MediaRecord), bytes: null });
    repository.used.set(A, 0);
    await service.unregisterObject(tx, M1);
    expect(repository.used.get(A)).toBe(0);
  });
});

describe('signedUrl', () => {
  const tx = {} as DbTx;
  async function withReady() {
    const s = setup();
    await s.service.registerObject(tx, { id: M1, ownerId: A, kind: 'upload', storageKey: uploadKey(A, M1), bytes: 10, contentType: 'image/png' });
    return s;
  }

  it('signs one object after an ownership check: browser 300 s, provider-fetch 3600 s', async () => {
    const { service, port } = await withReady();
    await expect(service.signedUrl('browser', { ownerId: A, mediaId: M1 })).resolves.toEqual({
      url: `https://signed.test/${uploadKey(A, M1)}?ttl=300`,
      expiresInSec: 300,
    });
    expect(port.presignGet).toHaveBeenLastCalledWith(uploadKey(A, M1), 300, { type: 'inline' });
    const fetch = await service.signedUrl('provider-fetch', { ownerId: A, mediaId: M1, disposition: { type: 'attachment', filename: 'a.png' } });
    expect(fetch.expiresInSec).toBe(3600);
    expect(port.presignGet).toHaveBeenLastCalledWith(uploadKey(A, M1), 3600, { type: 'attachment', filename: 'a.png' });
  });

  it('gives a foreign and a never-existing id the same 404, and signs nothing', async () => {
    const { service, port } = await withReady();
    const foreign = await code(service.signedUrl('browser', { ownerId: B, mediaId: M1 }));
    const missing = await code(service.signedUrl('browser', { ownerId: B, mediaId: '0197a1b2-0000-7000-8000-0000000000ee' }));
    expect(foreign.code).toBe('not_found');
    expect({ code: foreign.code, message: foreign.safeMessage }).toEqual({ code: missing.code, message: missing.safeMessage });
    expect(port.presignGet).not.toHaveBeenCalled();
  });

  it('never signs a processing or rejected object', async () => {
    const { service, repository, port } = await withReady();
    const row = repository.rows.get(M1) as MediaRecord;
    repository.rows.set(M1, { ...row, state: 'processing' });
    expect((await code(service.signedUrl('provider-fetch', { ownerId: A, mediaId: M1 }))).code).toBe('media_not_ready');
    repository.rows.set(M1, { ...row, state: 'rejected', rejectReason: 'type_not_allowed' });
    expect((await code(service.signedUrl('browser', { ownerId: A, mediaId: M1 }))).code).toBe('not_found');
    expect(port.presignGet).not.toHaveBeenCalled();
  });

  it('maps a storage outage to 503 and passes other errors through', async () => {
    const down = setup({ presignGet: vi.fn(async () => { throw new StorageUnavailable('presign'); }) });
    await down.service.registerObject(tx, { id: M1, ownerId: A, kind: 'upload', storageKey: uploadKey(A, M1), bytes: 1, contentType: 'image/png' });
    expect((await code(down.service.signedUrl('browser', { ownerId: A, mediaId: M1 }))).code).toBe('service_unavailable');
    const gone = setup({ presignGet: vi.fn(async () => { throw new StorageNotFound(); }) });
    await gone.service.registerObject(tx, { id: M1, ownerId: A, kind: 'upload', storageKey: uploadKey(A, M1), bytes: 1, contentType: 'image/png' });
    expect((await code(gone.service.signedUrl('browser', { ownerId: A, mediaId: M1 }))).code).toBe('service_unavailable');
    const odd = setup({ presignGet: vi.fn(async () => { throw new RangeError('x'); }) });
    await odd.service.registerObject(tx, { id: M1, ownerId: A, kind: 'upload', storageKey: uploadKey(A, M1), bytes: 1, contentType: 'image/png' });
    await expect(odd.service.signedUrl('browser', { ownerId: A, mediaId: M1 })).rejects.toThrow(RangeError);
  });
});
