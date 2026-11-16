import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { DATABASE } from '../../platform/db/index.js';
import type { Database } from '../../platform/db/index.js';
import { RateLimiter } from '../../platform/rate-limit/index.js';
import { MediaService } from './application/media.service.js';
import { MEDIA_CONFIG, MEDIA_REPOSITORY } from './application/ports.js';
import type { MediaConfig } from './application/ports.js';
import { STORAGE_PORT } from './domain/storage.js';
import { DrizzleMediaRepository } from './infrastructure/media.repository.js';
import { DrizzleMediaMaintenance } from './infrastructure/media-maintenance.repository.js';
import { createStorage } from './infrastructure/s3-storage.js';
import type { S3StorageConfig } from './infrastructure/s3-storage.js';
import { SharpImageSanitizer } from './infrastructure/sharp-image-sanitizer.js';
import { IMAGE_SANITIZE_PORT } from './worker/image-sanitize.port.js';
import { MEDIA_MAINTENANCE_REPOSITORY, WORKER_MEDIA_CONFIG } from './worker/maintenance.js';
import type { JobLog, WorkerMediaConfig } from './worker/maintenance.js';
import { MediaDeletion } from './worker/media-deletion.js';
import { SANITIZE_QUEUE, SanitizeJob } from './worker/sanitize.job.js';
import { UNATTACHED_SWEEP_QUEUE, UnattachedSweep } from './worker/unattached-sweep.job.js';
import { MediaUploadService } from './transport/media-upload.service.js';
import { MediaController, MultipartSupport } from './transport/media.controller.js';

export { MediaDeletion, SanitizeJob, UnattachedSweep };

type Env = Readonly<Record<string, string | undefined>>;

const DEFAULTS = {
  STORAGE_QUOTA_BYTES: 21_474_836_480,
  MEDIA_MAX_UPLOAD_BYTES: 10_485_760,
  MEDIA_BROWSER_URL_TTL_SEC: 300,
  PROVIDER_FETCH_URL_TTL_SEC: 3600,
  MEDIA_MAX_PIXEL_DIMENSION: 8000,
  MEDIA_MAX_PIXELS: 40_000_000,
  MEDIA_UNATTACHED_TTL_HOURS: 24,
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

/** The worker's media settings, checked at start-up like the api's. */
export function workerMediaConfigFrom(env: Env): {
  readonly maxDimension: number;
  readonly maxPixels: number;
  readonly unattachedTtlHours: number;
} {
  return {
    maxDimension: integer(env, 'MEDIA_MAX_PIXEL_DIMENSION', 1, 65_535),
    maxPixels: integer(env, 'MEDIA_MAX_PIXELS', 1, 1_000_000_000),
    unattachedTtlHours: integer(env, 'MEDIA_UNATTACHED_TTL_HOURS', 1, 168),
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
 * Media (TASK-041, TASK-042): quota, upload, object registration and signed URLs over StoragePort, and API-030 to API-032. The R2
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
        { provide: RateLimiter, useFactory: (database: Database) => new RateLimiter(database.db), inject: [DATABASE] },
        MediaUploadService,
        MultipartSupport,
      ],
      controllers: [MediaController],
      exports: [MediaService, STORAGE_PORT],
    };
  }

  /**
   * The worker side (TASK-043): the `sharp` sanitizer (the only place an image is decoded), the `media.sanitize` job,
   * the hourly unattached sweep and the deletion helpers. Storage is the worker's own token B. Fails at construction
   * when a setting is missing or out of range.
   */
  static registerWorker(env: Env): DynamicModule {
    const { maxDimension, maxPixels, unattachedTtlHours } = workerMediaConfigFrom(env);
    const workerConfig: WorkerMediaConfig = { unattachedTtlHours };
    return {
      module: MediaModule,
      providers: [
        { provide: STORAGE_PORT, useValue: createStorage(storageConfigFrom(env)) },
        { provide: MEDIA_REPOSITORY, useClass: DrizzleMediaRepository },
        { provide: MEDIA_MAINTENANCE_REPOSITORY, useClass: DrizzleMediaMaintenance },
        { provide: IMAGE_SANITIZE_PORT, useValue: new SharpImageSanitizer({ maxDimension, maxPixels }) },
        { provide: WORKER_MEDIA_CONFIG, useValue: workerConfig },
        MediaDeletion,
        SanitizeJob,
        UnattachedSweep,
      ],
      exports: [MediaDeletion, SanitizeJob, UnattachedSweep],
    };
  }
}

/** The queue handlers of this module, resolved when a job arrives (the worker composition root binds them). */
export function mediaJobHandlers(resolve: {
  readonly sanitize: () => SanitizeJob;
  readonly sweep: () => UnattachedSweep;
}): Readonly<Record<string, (job: { id: string; data: unknown }, log: JobLog) => Promise<void>>> {
  return {
    [SANITIZE_QUEUE]: async (job, log) => {
      await resolve.sanitize().handle(job, log);
    },
    [UNATTACHED_SWEEP_QUEUE]: async (_job, log) => {
      const outcome = await resolve.sweep().run();
      log.info(
        { module: 'media', outcome: outcome.failed === 0 ? 'ok' : 'error' },
        `unattached-sweep: ${String(outcome.deleted)} deleted, ${String(outcome.failed)} failed`,
      );
      if (outcome.failed > 0) throw new Error(`unattached sweep left ${String(outcome.failed)} uploads for the next run`);
    },
  };
}
