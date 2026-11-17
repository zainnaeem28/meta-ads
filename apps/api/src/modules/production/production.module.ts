import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { DATABASE } from '../../platform/db/index.js';
import type { Database, DbTx } from '../../platform/db/index.js';
import { ASSEMBLY_CONFIG, AssemblyService } from './application/assembly.service.js';
import type { AssemblyConfig } from './application/assembly.service.js';
import { QcKeySession } from './application/qc-key-session.js';
import { AUDIO_EXTRACTOR, QC_CONFIG, QC_KEY_AUTH_REPORTER, QC_REPOSITORY, TRANSCRIBE_PORT } from './application/qc-ports.js';
import type { QcConfig } from './application/qc-ports.js';
import { QcRecovery } from './application/qc-recovery.js';
import { QC_RUN_QUEUE, QcRunJob } from './application/qc-run.job.js';
import { QcRunsService } from './application/qc-runs.service.js';
import { startFirstQc } from './application/qc-start.js';
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
  PRODUCTION_STORAGE,
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
import { FfmpegAudio } from './infrastructure/openai-transcribe/ffmpeg-audio.js';
import { OpenAiKeyAuthReporter } from './infrastructure/openai-transcribe/key-auth.reporter.js';
import { OpenAiTranscribe } from './infrastructure/openai-transcribe/openai-transcribe.js';
import { SqlQcRepository } from './infrastructure/openai-transcribe/qc.repository.js';
import { WaveSpeedKeyAuthReporter } from './infrastructure/wavespeed/key-auth.reporter.js';
import { SqlVideoWorkerRepository } from './infrastructure/wavespeed/video-worker.repository.js';
import { WaveSpeedVideoGen } from './infrastructure/wavespeed/wavespeed-video-gen.js';
import { VideoProgressReader } from './infrastructure/video-progress.reader.js';
import type { ProgressSnapshotShape } from './infrastructure/video-progress.reader.js';
import { AssemblyController } from './transport/assembly.controller.js';
import { QcController } from './transport/qc.controller.js';
import { VideoController } from './transport/video.controller.js';
import type { MediaService, StoragePort } from '../media/index.js';
import { BOSS } from '../../platform/jobs/boss.js';
import type { SweepRegistry } from '../../platform/jobs/sweep-registry.js';

export { ProviderCopyCleanup, QcRunJob, VideoCopyJob, VideoPollJob, VideoSubmitJob };

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

/** `ASSEMBLY_RENDERS_PER_USER_PER_DAY` (1 to 200, 20 by default), checked at start-up. */
export function assemblyConfigFrom(env: Env): AssemblyConfig {
  return {
    rendersPerDay: integer(env, 'ASSEMBLY_RENDERS_PER_USER_PER_DAY', 20, 1, 200),
    idempotencyTtlHours: videoConfigFrom(env).idempotencyTtlHours,
  };
}

/**
 * Production: the M0010 video and QC tables (TASK-052), the segment clip operations API-060 to API-064, the assembly API-070 and API-071 (M0011, TASK-055) and the campaign
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
        { provide: ASSEMBLY_CONFIG, useValue: assemblyConfigFrom(env) },
        VideoJobsService,
        QcRunsService,
        AssemblyService,
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
      controllers: [VideoController, QcController, AssemblyController],
      exports: [VideoJobsService, QcRunsService, AssemblyService, VideoProgressReader],
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
  /** Test seam: the origin of a local stand-in for the provider APIs (`https://api.wavespeed.ai`, and `https://api.openai.com` for the QC transcription); the hosts stay allow-listed. The product never sets it. */
  readonly baseUrl?: string;
}

/** The media operations the worker needs, over the media module's public service. */
export function productionMediaOf(
  resolve: () => Pick<MediaService, 'signedUrl' | 'registerObject'>,
  /** Runs in the transaction that completes the clip, after its object is registered: the clip's first QC (ARCHITECTURE §5.6). */
  afterClip?: (tx: DbTx, clip: { readonly ownerId: string; readonly videoJobId: string }) => Promise<void>,
): ProductionMedia {
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
      await afterClip?.(tx, { ownerId: input.ownerId, videoJobId: input.id });
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
  return {
    runningJobsPerUser: integer(env, 'RUNNING_JOBS_PER_USER', 5, 1, 20),
    pollIntervalSec: integer(env, 'POLL_INTERVAL_SEC', 5, 2, 3600),
    pollLeaseSec: integer(env, 'POLL_LEASE_SEC', 60, 2, 3600),
    submitOrphanAfterSec: integer(env, 'SUBMIT_ORPHAN_AFTER_SEC', 300, 1, 86_400),
    copyWindowHours: integer(env, 'PROVIDER_OUTPUT_COPY_WINDOW_HOURS', 24, 1, 72),
    outputMaxBytes: integer(env, 'PROVIDER_OUTPUT_MAX_BYTES', 209_715_200, 1, Number.MAX_SAFE_INTEGER),
  };
}

/** The QC settings, checked at start-up: `QC_MAX_WORD_ERROR_RATE` (0 to 1, 0.20 by default) and the clip's transcribe model. */
export function qcConfigFrom(env: Env, baseUrl?: string): QcConfig {
  const text = optional(env, 'QC_MAX_WORD_ERROR_RATE');
  const maxWordErrorRate = text === undefined ? 0.2 : Number(text);
  if (!Number.isFinite(maxWordErrorRate) || maxWordErrorRate < 0 || maxWordErrorRate > 1) throw new Error('QC_MAX_WORD_ERROR_RATE must be a number from 0 to 1');
  const video = videoConfigFrom(env);
  return {
    transcribeModel: video.transcribeModel,
    maxWordErrorRate,
    deadlineMinutes: 10,
    idempotencyTtlHours: video.idempotencyTtlHours,
    orphanAfterSec: videoWorkerConfigFrom(env).submitOrphanAfterSec,
    requeueAfterSec: 120,
    ...(baseUrl === undefined ? {} : { transcribeUrl: `${baseUrl}/v1/audio/transcriptions` }),
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

/** The worker side of production (TASK-053, TASK-054): the WaveSpeed adapter, the submit, poll and copy handlers, the hourly
 * provider-copy cleanup, the OpenAI transcription adapter with the QC run and the recovery-sweep hooks. Fails at construction, so the process does not start, when a
 * setting is out of range. */
@Module({})
export class ProductionWorkerModule {
  static register(env: Env, edge: ProductionWorkerEdge): DynamicModule {
    const config: VideoWorkerConfig = { ...videoWorkerConfigFrom(env), ...(edge.baseUrl === undefined ? {} : { baseUrl: edge.baseUrl }) };
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
        { provide: PRODUCTION_STORAGE, useValue: lazyStorage(edge.storage) },
        {
          provide: PRODUCTION_MEDIA,
          useFactory: (boss: Parameters<typeof startFirstQc>[0]) => productionMediaOf(edge.media, (tx, clip) => startFirstQc(boss, tx, clip).then(() => undefined)),
          inject: [BOSS],
        },
        { provide: QC_CONFIG, useValue: qcConfigFrom(env, edge.baseUrl) },
        { provide: QC_REPOSITORY, useClass: SqlQcRepository },
        { provide: QC_KEY_AUTH_REPORTER, useClass: OpenAiKeyAuthReporter },
        { provide: TRANSCRIBE_PORT, useClass: OpenAiTranscribe },
        { provide: AUDIO_EXTRACTOR, useValue: new FfmpegAudio() },
        { provide: SWEEP_REGISTRY, useValue: edge.registry },
        KeySession,
        VideoSubmitJob,
        VideoPollJob,
        VideoCopyJob,
        ProviderCopyCleanup,
        ProductionRecovery,
        QcKeySession,
        QcRunJob,
        QcRecovery,
      ],
      exports: [VideoSubmitJob, VideoPollJob, VideoCopyJob, ProviderCopyCleanup, QcRunJob],
    };
  }
}

/** The queue handlers of this module, resolved when a job arrives (the worker composition root binds them). */
export function productionJobHandlers(resolve: {
  readonly submit: () => VideoSubmitJob;
  readonly poll: () => VideoPollJob;
  readonly copy: () => VideoCopyJob;
  readonly cleanup: () => ProviderCopyCleanup;
  readonly qc: () => QcRunJob;
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
    [QC_RUN_QUEUE]: async (job, log) => {
      await resolve.qc().handle(job, log);
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
