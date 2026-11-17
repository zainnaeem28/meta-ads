import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { DATABASE } from '../../platform/db/index.js';
import type { Database } from '../../platform/db/index.js';
import { VideoJobsService } from './application/video-jobs.service.js';
import { VIDEO_CONFIG } from './application/video-ports.js';
import type { VideoConfig } from './application/video-ports.js';
import { VideoProgressReader } from './infrastructure/video-progress.reader.js';
import type { ProgressSnapshotShape } from './infrastructure/video-progress.reader.js';
import { VideoController } from './transport/video.controller.js';

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
