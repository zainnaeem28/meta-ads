import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { StorageTooLarge, StorageUnavailable } from '../domain/storage.js';
import { MinioStorage, R2Storage, S3Storage, createStorage, flavourOf } from './s3-storage.js';

// No network here: presigning is local, and the failing calls go to a port nothing listens on.

const R2 = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
const CONFIG = { endpoint: R2, bucket: 'app', accessKeyId: 'AKID', secretAccessKey: 'SECRET' };

describe('adapter selection', () => {
  it('uses R2 for an account endpoint and MinIO for anything else', () => {
    expect(flavourOf(R2)).toBe('r2');
    expect(flavourOf('http://127.0.0.1:9000')).toBe('minio');
    expect(flavourOf('https://minio.internal:9000')).toBe('minio');
    expect(createStorage(CONFIG)).toBeInstanceOf(R2Storage);
    expect(createStorage({ ...CONFIG, endpoint: 'http://127.0.0.1:9000' })).toBeInstanceOf(MinioStorage);
    expect(new S3Storage(CONFIG).flavour).toBe('r2');
  });
});

describe('presignGet', () => {
  it('signs for region auto against the account endpoint, one key, with the disposition', async () => {
    const url = new URL(await new R2Storage(CONFIG).presignGet('u/o/media/m', 300, { type: 'attachment', filename: 'Pé "x".png' }));
    expect(url.origin).toBe(R2);
    expect(url.pathname).toBe('/app/u/o/media/m');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/auto/s3/aws4_request');
    expect(url.searchParams.get('response-content-disposition')).toBe(
      `attachment; filename="P_ _x_.png"; filename*=UTF-8''P%C3%A9%20%22x%22.png`,
    );
  });

  it('points at the public origin when one is configured, and leaves a bare type alone', async () => {
    const storage = new MinioStorage({ ...CONFIG, endpoint: 'http://minio:9000', publicOrigin: 'https://files.example.test' });
    const url = new URL(await storage.presignGet('q/o/m', 600, { type: 'inline' }));
    expect(url.origin).toBe('https://files.example.test');
    expect(url.searchParams.get('response-content-disposition')).toBe('inline');
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/us-east-1/s3/aws4_request');
  });

  it.each([0, -1, 1.5, 604_801, Number.NaN])('refuses a life of %s seconds', async (ttl) => {
    await expect(new R2Storage(CONFIG).presignGet('k', ttl, { type: 'inline' })).rejects.toThrow(RangeError);
  });
});

describe('put guards that need no server', () => {
  const storage = new MinioStorage({ ...CONFIG, endpoint: 'http://127.0.0.1:1' });

  it('refuses a body over maxBytes before sending anything', async () => {
    await expect(storage.put('k', Buffer.alloc(11), 'image/png', 10)).rejects.toBeInstanceOf(StorageTooLarge);
    await expect(storage.put('k', Readable.from([Buffer.alloc(6), 'abcdefg']), 'image/png', 10)).rejects.toBeInstanceOf(StorageTooLarge);
  });

  it('maps an unreachable store to StorageUnavailable on every operation', async () => {
    await expect(storage.put('k', Buffer.from('x'), 'image/png', 10)).rejects.toBeInstanceOf(StorageUnavailable);
    await expect(storage.get('k')).rejects.toBeInstanceOf(StorageUnavailable);
    await expect(storage.delete('k')).rejects.toBeInstanceOf(StorageUnavailable);
    await expect(storage.list('p/')).rejects.toBeInstanceOf(StorageUnavailable);
    await expect(storage.deletePrefix('p/', 10)).rejects.toBeInstanceOf(StorageUnavailable);
    await expect(storage.deletePrefix('', 10)).rejects.toThrow(TypeError);
  }, 30_000);
});
