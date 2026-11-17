import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { DATABASE } from '../../platform/db/index.js';
import type { Database } from '../../platform/db/index.js';
import { VideoJobsService } from './application/video-jobs.service.js';
import { VIDEO_CONFIG } from './application/video-ports.js';
import type { VideoConfig } from './application/video-ports.js';
import { PROVIDER_COPY_CLEANUP_QUEUE, ProviderCopyCleanup } from './application/worker/provider-copy-cleanup.job.js';
import { KeySession } from './application/worker/key-session.js';
import {
  KEY_AUTH_REPORTER,
  KEY_AUTH_THRESHOLD,
  KEY_OPENER,
  PRODUCTION_MEDIA,
  SWEEP_REGISTRY,
  VIDEO_GEN_PORT,
  VIDEO_WORKER_CONFIG,
  VIDEO_WORKER_REPOSITORY,
} from './application/worker/ports.js';
import type { JobLog, KeyOpener, ProductionMedia, VideoWorkerConfig } from './application/worker/ports.js';
import { ProductionRecovery } from './application/worker/recovery.js';
import { COPY_QUEUE, VideoCopyJob } from './application/worker/video-copy.job.js';
import { POLL_QUEUE, VideoPollJob } from './application/worker/video-poll.job.js';
import { VIDEO_SUBMIT_QUEUE, VideoSubmitJob } from './application/worker/video-submit.job.js';
import { WaveSpeedKeyAuthReporter } from './infrastructure/wavespeed/key-auth.reporter.js';
import { SqlVideoWorkerRepository } from './infrastructure/wavespeed/video-worker.repository.js';
import { WaveSpeedVideoGen } from './infrastructure/wavespeed/wavespeed-video-gen.js';
import { VideoProgressReader } from './infrastructure/video-progress.reader.js';
import type { ProgressSnapshotShape } from './infrastructure/video-progress.reader.js';
import { VideoController } from './transport/video.controller.js';
import { STORAGE_PORT } from '../media/index.js';
import type { MediaService, StoragePort } from '../media/index.js';
import type { SweepRegistry } from '../../platform/jobs/sweep-registry.js';

export { ProviderCopyCleanup, VideoCopyJob, VideoPollJob, VideoSubmitJob };

type Env = Readonly<Record<string, string | undefined>>;

/** What the api composition root passes in: the usage module (the cap check and the reservation). */
export interface ProductionEdge {
  readonly usage: DynamicModule;
}

/** The port campaigns declares (TD-D12), without importing it: the same shape, bound once the database exists. */
export interface ProgressReaderShape {
  progressFor(ownerId: string, campaignIds: readonly string[]): Promise<ReadonlyMap<string, ProgressSnapshotShape>>;
  idsWithProgress(ownerId: string, progress: 'processing' | 'completed' | 'failed'): Promise<ReadonlySet<string>>;
}

/**
 * The reader campaigns is given at bootstrap before the database is open: it forwards to production's own reader, which
 * the production module binds when it is built. Until then no campaign has jobs.
 */
export function progressBridge(): { reader: ProgressReaderShape; bind: (reader: ProgressReaderShape) => void } {
  let target: ProgressReaderShape | undefined;
  return {
    reader: {
      progressFor: (ownerId, ids) => (target === undefined ? Promise.resolve(new Map()) : target.progressFor(ownerId, ids)),
      idsWithProgress: (ownerId, progress) => (target === undefined ? Promise.resolve(new Set()) : target.idsWithProgress(ownerId, progress)),
    },
    bind: (reader) => {
      target = reader;
    },
  };
}

function optional(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const text = optional(env, name);
  const value = text === undefined ? fallback : Number(text);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${String(min)} to ${String(max)}`);
  return value;
}

/** The registry defaults for the clip settings; a setting that is present is checked, so a bad one stops the process. */
export function videoConfigFrom(env: Env): VideoConfig {
  return {
    modelI2v: optional(env, 'WAVESPEED_MODEL_I2V') ?? 'bytedance/seedance-2.0/image-to-video',
    modelT2v: optional(env, 'WAVESPEED_MODEL_T2V') ?? 'bytedance/seedance-2.0/text-to-video',
    transcribeModel: optional(env, 'OPENAI_TRANSCRIBE_MODEL') ?? 'gpt-transcribe',
    durationSeconds: integer(env, 'VIDEO_SEGMENT_SECONDS', 15, 1, 15),
    resolution: optional(env, 'VIDEO_RESOLUTION') ?? '1080p',
    aspectRatio: optional(env, 'VIDEO_ASPECT_RATIO') ?? '9:16',
    deadlineMinutes: integer(env, 'VIDEO_JOB_DEADLINE_MIN', 30, 5, 180),
    idempotencyTtlHours: integer(env, 'IDEMPOTENCY_TTL_HOURS', 24, 1, 24 * 365),
  };
}

/**
 * Production: the M0010 video and QC tables (TASK-052), the segment clip operations API-060 to API-063 and the campaign
 * progress reader. Needs the database, the job queue and the usage module.
 */
@Module({})
export class ProductionModule {
  static register(env: Env, edge: ProductionEdge, bind?: (reader: ProgressReaderShape) => void): DynamicModule {
    return {
      module: ProductionModule,
      imports: [edge.usage],
      providers: [
        { provide: VIDEO_CONFIG, useValue: videoConfigFrom(env) },
        VideoJobsService,
        {
          provide: VideoProgressReader,
          useFactory: (database: Database) => {
            const reader = new VideoProgressReader(database);
            bind?.(reader);
            return reader;
          },
          inject: [DATABASE],
        },
      ],
      controllers: [VideoController],
      exports: [VideoJobsService, VideoProgressReader],
    };
  }
}

/**
 * What the worker composition root passes in: the audit, egress and usage module instances (this module's only way to
 * the provider, the spend ledger and the trail), the key opener (bound to the unsealer by the worker root alone, layer
 * rule L3), the worker's own object storage and media service (resolved when first used, because the media module is
 * built beside this one) and the recovery-sweep registry the hooks join.
 */
export interface ProductionWorkerEdge {
  readonly audit: DynamicModule;
  readonly egress: DynamicModule;
  readonly usage: DynamicModule;
  readonly opener: KeyOpener;
  readonly storage: () => StoragePort;
  readonly media: () => Pick<MediaService, 'signedUrl' | 'registerObject'>;
  readonly registry: SweepRegistry;
  /** Test seam: a local stand-in for `https://api.wavespeed.ai` (the host stays allow-listed). The product never sets it. */
  readonly baseUrl?: string;
}

/** The media operations the worker needs, over the media module's public service. */
export function productionMediaOf(resolve: () => Pick<MediaService, 'signedUrl' | 'registerObject'>): ProductionMedia {
  return {
    referenceUrl: async (ownerId, mediaId) => (await resolve().signedUrl('provider-fetch', { ownerId, mediaId })).url,
    registerClip: async (tx, input) => {
      await resolve().registerObject(tx, {
        id: input.id,
        ownerId: input.ownerId,
        kind: 'clip',
        storageKey: input.storageKey,
        bytes: input.bytes,
        contentType: 'video/mp4',
        campaignId: input.campaignId,
      });
    },
  };
}

/** `KEY_AUTO_DISABLE_THRESHOLD`, 1 to 20, 5 by default (the same setting the api's key module reads). */
function authThreshold(env: Env): number {
  return integer(env, 'KEY_AUTO_DISABLE_THRESHOLD', 5, 1, 20);
}

/** The worker's settings, checked at start-up: one out of range stops the process naming the variable (TC-PCA-07). */
export function videoWorkerConfigFrom(env: Env): VideoWorkerConfig {
  videoConfigFrom(env); // VIDEO_JOB_DEADLINE_MIN and the clip options
  const baseUrl = optional(env, 'WAVESPEED_BASE_URL');
  return {
    runningJobsPerUser: integer(env, 'RUNNING_JOBS_PER_USER', 5, 1, 20),
    pollIntervalSec: integer(env, 'POLL_INTERVAL_SEC', 5, 2, 3600),
    pollLeaseSec: integer(env, 'POLL_LEASE_SEC', 60, 2, 3600),
    submitOrphanAfterSec: integer(env, 'SUBMIT_ORPHAN_AFTER_SEC', 300, 1, 86_400),
    copyWindowHours: integer(env, 'PROVIDER_OUTPUT_COPY_WINDOW_HOURS', 24, 1, 72),
    outputMaxBytes: integer(env, 'PROVIDER_OUTPUT_MAX_BYTES', 209_715_200, 1, Number.MAX_SAFE_INTEGER),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
}

/** Object storage resolved on first use: the media module that owns it is built beside this one. */
function lazyStorage(resolve: () => StoragePort): StoragePort {
  return {
    put: (key, body, contentType, maxBytes) => resolve().put(key, body, contentType, maxBytes),
    get: (key) => resolve().get(key),
    delete: (key) => resolve().delete(key),
    deletePrefix: (prefix, batch) => resolve().deletePrefix(prefix, batch),
    list: (prefix, cursor) => resolve().list(prefix, cursor),
    presignGet: (key, ttlSec, disposition) => resolve().presignGet(key, ttlSec, disposition),
  };
}

/** The worker side of production (TASK-053): the WaveSpeed adapter, the submit, poll and copy handlers, the hourly
 * provider-copy cleanup and the recovery-sweep hooks. Fails at construction, so the process does not start, when a
 * setting is out of range. */
@Module({})
export class ProductionWorkerModule {
  static register(env: Env, edge: ProductionWorkerEdge): DynamicModule {
    const config = videoWorkerConfigFrom(env);
    return {
      module: ProductionWorkerModule,
      imports: [edge.audit, edge.egress, edge.usage],
      providers: [
        { provide: VIDEO_WORKER_CONFIG, useValue: config },
        { provide: KEY_AUTH_THRESHOLD, useValue: authThreshold(env) },
        { provide: VIDEO_WORKER_REPOSITORY, useClass: SqlVideoWorkerRepository },
        { provide: KEY_OPENER, useValue: edge.opener },
        { provide: KEY_AUTH_REPORTER, useClass: WaveSpeedKeyAuthReporter },
        { provide: VIDEO_GEN_PORT, useClass: WaveSpeedVideoGen },
        { provide: STORAGE_PORT, useValue: lazyStorage(edge.storage) },
        { provide: PRODUCTION_MEDIA, useValue: productionMediaOf(edge.media) },
        { provide: SWEEP_REGISTRY, useValue: edge.registry },
        KeySession,
        VideoSubmitJob,
        VideoPollJob,
        VideoCopyJob,
        ProviderCopyCleanup,
        ProductionRecovery,
      ],
      exports: [VideoSubmitJob, VideoPollJob, VideoCopyJob, ProviderCopyCleanup],
    };
  }
}

/** The queue handlers of this module, resolved when a job arrives (the worker composition root binds them). */
export function productionJobHandlers(resolve: {
  readonly submit: () => VideoSubmitJob;
  readonly poll: () => VideoPollJob;
  readonly copy: () => VideoCopyJob;
  readonly cleanup: () => ProviderCopyCleanup;
}): Readonly<Record<string, (job: { id: string; data: unknown }, log: JobLog) => Promise<void>>> {
  return {
    [VIDEO_SUBMIT_QUEUE]: async (job, log) => {
      await resolve.submit().handle(job, log);
    },
    [POLL_QUEUE]: async (job, log) => {
      await resolve.poll().handle(job, log);
    },
    [COPY_QUEUE]: async (job, log) => {
      await resolve.copy().handle(job, log);
    },
    [PROVIDER_COPY_CLEANUP_QUEUE]: async (_job, log) => {
      const outcome = await resolve.cleanup().run(log);
      log.info(
        { module: 'production', outcome: outcome.failed === 0 ? 'ok' : 'error' },
        `provider-copy-cleanup: ${String(outcome.deleted)} deleted, ${String(outcome.waiting)} waiting, ${String(outcome.failed)} failed`,
      );
    },
  };
}
