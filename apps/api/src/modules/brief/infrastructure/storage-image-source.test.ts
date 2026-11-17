import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { StoragePort } from '../../media/index.js';
import { StorageImageSource } from './storage-image-source.js';

const storageOf = (stream: () => Promise<Readable>): (() => StoragePort) => () => ({ get: stream }) as unknown as StoragePort;

describe('StorageImageSource', () => {
  it('reads the whole sanitized object, resolving storage when the first image is read', async () => {
    let resolved = 0;
    const source = new StorageImageSource(() => {
      resolved += 1;
      return storageOf(async () => Readable.from([Buffer.from([1, 2]), new Uint8Array([3])]))();
    });
    expect(resolved).toBe(0);
    expect([...(await source.read('u/o/media/1'))]).toEqual([1, 2, 3]);
    expect(resolved).toBe(1);
  });

  it('refuses an object longer than an upload can be', async () => {
    const big = Readable.from([Buffer.alloc(6_000_000), Buffer.alloc(6_000_000)]);
    await expect(new StorageImageSource(storageOf(async () => big)).read('k')).rejects.toThrow(RangeError);
  });

  it('passes a storage failure on', async () => {
    await expect(new StorageImageSource(storageOf(() => Promise.reject(new Error('down')))).read('k')).rejects.toThrow('down');
  });
});
