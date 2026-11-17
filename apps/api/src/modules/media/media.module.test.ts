import { describe, expect, it } from 'vitest';
import { mediaConfigFrom, storageConfigFrom } from './media.module.js';

const STORE = {
  R2_ENDPOINT: 'http://127.0.0.1:9000',
  R2_BUCKET: 'app',
  R2_ACCESS_KEY_ID: 'id',
  R2_SECRET_ACCESS_KEY: 'secret',
};

describe('media settings', () => {
  it('uses the registry defaults: 20 GB, 10 MiB, 5 min browser URL, 60 min provider URL', () => {
    expect(mediaConfigFrom({})).toEqual({
      quotaBytes: 21_474_836_480,
      maxUploadBytes: 10_485_760,
      browserUrlTtlSec: 300,
      providerFetchUrlTtlSec: 3600,
    });
    expect(mediaConfigFrom({ STORAGE_QUOTA_BYTES: '' }).quotaBytes).toBe(21_474_836_480);
  });

  it('accepts a browser URL life of 5 and 15 minutes and refuses 16 (TC-MED-02)', () => {
    expect(mediaConfigFrom({ MEDIA_BROWSER_URL_TTL_SEC: '300' }).browserUrlTtlSec).toBe(300);
    expect(mediaConfigFrom({ MEDIA_BROWSER_URL_TTL_SEC: '900' }).browserUrlTtlSec).toBe(900);
    expect(() => mediaConfigFrom({ MEDIA_BROWSER_URL_TTL_SEC: '960' })).toThrow(
      'MEDIA_BROWSER_URL_TTL_SEC',
    );
    expect(() => mediaConfigFrom({ MEDIA_BROWSER_URL_TTL_SEC: '299' })).toThrow(
      'MEDIA_BROWSER_URL_TTL_SEC',
    );
    expect(() => mediaConfigFrom({ MEDIA_BROWSER_URL_TTL_SEC: 'abc' })).toThrow(
      'MEDIA_BROWSER_URL_TTL_SEC',
    );
  });

  it('bounds the other values', () => {
    expect(() => mediaConfigFrom({ PROVIDER_FETCH_URL_TTL_SEC: '599' })).toThrow(
      'PROVIDER_FETCH_URL_TTL_SEC',
    );
    expect(() => mediaConfigFrom({ STORAGE_QUOTA_BYTES: '0' })).toThrow('STORAGE_QUOTA_BYTES');
    expect(() => mediaConfigFrom({ MEDIA_MAX_UPLOAD_BYTES: '10485761' })).toThrow(
      'MEDIA_MAX_UPLOAD_BYTES',
    );
  });

  it('needs the endpoint, bucket and token, and names only the missing key', () => {
    expect(storageConfigFrom({ ...STORE, STORAGE_PUBLIC_ORIGIN: '' })).toMatchObject({
      endpoint: STORE.R2_ENDPOINT,
      publicOrigin: undefined,
    });
    expect(
      storageConfigFrom({ ...STORE, STORAGE_PUBLIC_ORIGIN: 'https://files.example.test' })
        .publicOrigin,
    ).toBe('https://files.example.test');
    for (const key of Object.keys(STORE)) {
      const rest: Record<string, string> = { ...STORE };
      delete rest[key];
      expect(() => storageConfigFrom(rest)).toThrow(new RegExp(`^${key} is required`));
    }
  });
});
