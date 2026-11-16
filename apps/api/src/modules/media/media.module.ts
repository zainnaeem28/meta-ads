import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { MediaService } from './application/media.service.js';
import { MEDIA_CONFIG, MEDIA_REPOSITORY } from './application/ports.js';
import type { MediaConfig } from './application/ports.js';
import { STORAGE_PORT } from './domain/storage.js';
import { DrizzleMediaRepository } from './infrastructure/media.repository.js';
import { createStorage } from './infrastructure/s3-storage.js';
import type { S3StorageConfig } from './infrastructure/s3-storage.js';

type Env = Readonly<Record<string, string | undefined>>;

const DEFAULTS = {
  STORAGE_QUOTA_BYTES: 21_474_836_480,
  MEDIA_MAX_UPLOAD_BYTES: 10_485_760,
  MEDIA_BROWSER_URL_TTL_SEC: 300,
  PROVIDER_FETCH_URL_TTL_SEC: 3600,
} as const;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required for media`);
  return value;
}

function integer(env: Env, name: keyof typeof DEFAULTS, min: number, max: number): number {
  const text = env[name];
  const value = text === undefined || text === '' ? DEFAULTS[name] : Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${String(min)} to ${String(max)}`);
  }
  return value;
}

/** Reads and checks the media settings; a value outside its range stops the process at start-up (TC-MED-02). */
export function mediaConfigFrom(env: Env): MediaConfig {
  return {
    quotaBytes: integer(env, 'STORAGE_QUOTA_BYTES', 1, Number.MAX_SAFE_INTEGER),
    maxUploadBytes: integer(env, 'MEDIA_MAX_UPLOAD_BYTES', 1, 10_485_760),
    browserUrlTtlSec: integer(env, 'MEDIA_BROWSER_URL_TTL_SEC', 300, 900),
    providerFetchUrlTtlSec: integer(env, 'PROVIDER_FETCH_URL_TTL_SEC', 600, 7200),
  };
}

export function storageConfigFrom(env: Env): S3StorageConfig {
  return {
    endpoint: required(env, 'R2_ENDPOINT'),
    publicOrigin: env['STORAGE_PUBLIC_ORIGIN'] === '' ? undefined : env['STORAGE_PUBLIC_ORIGIN'],
    bucket: required(env, 'R2_BUCKET'),
    accessKeyId: required(env, 'R2_ACCESS_KEY_ID'),
    secretAccessKey: required(env, 'R2_SECRET_ACCESS_KEY'),
  };
}

/**
 * Media, part 1 (TASK-041): quota, upload skeleton, object registration and signed URLs over StoragePort. The R2
 * adapter (token A in the api, token B in the worker) or the MinIO adapter is chosen from `R2_ENDPOINT`. Fails at
 * construction, so the process does not start, when a setting is missing or out of range.
 */
@Module({})
export class MediaModule {
  static register(env: Env): DynamicModule {
    const config = mediaConfigFrom(env);
    const storage = createStorage(storageConfigFrom(env));
    return {
      module: MediaModule,
      providers: [
        MediaService,
        { provide: MEDIA_CONFIG, useValue: config },
        { provide: STORAGE_PORT, useValue: storage },
        { provide: MEDIA_REPOSITORY, useClass: DrizzleMediaRepository },
      ],
      exports: [MediaService, STORAGE_PORT],
    };
  }
}
