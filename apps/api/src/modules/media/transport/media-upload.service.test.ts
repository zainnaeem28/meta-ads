import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '../../../platform/http/domain-error.js';
import { MediaUploadService } from './media-upload.service.js';
import { UploadTooLarge } from './sniff.js';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const result = { id: 'm1', state: 'processing' as const, bytes: png.length, storageKey: 'q/u1/m1' };

function build(overrides: { upload?: ReturnType<typeof vi.fn>; send?: ReturnType<typeof vi.fn> } = {}) {
  const media = {
    upload: overrides.upload ?? vi.fn(() => Promise.resolve(result)),
    unregisterObject: vi.fn(() => Promise.resolve(null)),
  };
  const boss = { send: overrides.send ?? vi.fn(() => Promise.resolve('job')) };
  const database = { uow: { run: vi.fn((fn: (tx: unknown) => unknown) => Promise.resolve(fn({ execute: vi.fn(() => Promise.resolve({ rows: [] })) }))) } };
  const storage = { delete: vi.fn(() => Promise.resolve()) };
  const config = { maxUploadBytes: 1000 } as never;
  const service = new MediaUploadService(media as never, database as never, boss as never, storage as never, config);
  return { service, media, boss, database, storage };
}

describe('MediaUploadService', () => {
  it('stores the sniffed type, caps the reservation at the limit and queues media.sanitize', async () => {
    const { service, media, boss } = build();
    expect(service.maxUploadBytes).toBe(1000);
    expect(await service.upload('u1', Readable.from([png]), 5000)).toBe(result);
    expect(media.upload).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'u1', contentType: 'image/png', declaredBytes: 1000 }));
    expect(boss.send).toHaveBeenCalledWith('media.sanitize', { mediaId: 'm1' }, expect.anything());
  });

  it('reserves the announced size when it is below the cap and the cap when nothing was announced', async () => {
    const a = build();
    await a.service.upload('u1', Readable.from([png]), 400);
    expect(a.media.upload).toHaveBeenCalledWith(expect.objectContaining({ declaredBytes: 400 }));
    const b = build();
    await b.service.upload('u1', Readable.from([png]), undefined);
    expect(b.media.upload).toHaveBeenCalledWith(expect.objectContaining({ declaredBytes: 1000 }));
  });

  it('refuses an unrecognised body with 415 before anything is stored', async () => {
    const { service, media } = build();
    const error = await service.upload('u1', Readable.from([Buffer.from('<svg/>')]), 10).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('unsupported_media_type');
    expect(media.upload).not.toHaveBeenCalled();
  });

  it('turns the stream cap into 413 and passes other storage errors through', async () => {
    const { service } = build({ upload: vi.fn(() => Promise.reject(new UploadTooLarge())) });
    const error = await service.upload('u1', Readable.from([png]), 10).catch((e: unknown) => e);
    expect((error as DomainError).code).toBe('payload_too_large');
    const wrapped = build({ upload: vi.fn(() => Promise.reject(new Error('x', { cause: new UploadTooLarge() }))) });
    expect(((await wrapped.service.upload('u1', Readable.from([png]), 10).catch((e: unknown) => e)) as DomainError).code).toBe('payload_too_large');
    const other = new DomainError('storage_quota_reached', 'full');
    const quota = build({ upload: vi.fn(() => Promise.reject(other)) });
    await expect(quota.service.upload('u1', Readable.from([png]), 10)).rejects.toBe(other);
  });

  it('removes the row and the object when the job cannot be queued, and still reports the failure', async () => {
    const failure = new Error('queue down');
    const { service, media, storage } = build({ send: vi.fn(() => Promise.reject(failure)) });
    await expect(service.upload('u1', Readable.from([png]), 100)).rejects.toBe(failure);
    expect(media.unregisterObject).toHaveBeenCalled();
    expect(storage.delete).toHaveBeenCalledWith('q/u1/m1');
  });

  it('keeps the original failure when the clean-up itself fails', async () => {
    const failure = new Error('queue down');
    const { service, storage } = build({ send: vi.fn(() => Promise.reject(failure)) });
    storage.delete.mockRejectedValueOnce(new Error('storage down') as never);
    await expect(service.upload('u1', Readable.from([png]), 100)).rejects.toBe(failure);
  });
});
