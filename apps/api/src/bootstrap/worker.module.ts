import 'reflect-metadata';
import { Inject, Injectable, Module } from '@nestjs/common';
import type { DynamicModule, INestApplicationContext, OnApplicationBootstrap } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Logger } from 'pino';
import type { PgBoss } from 'pg-boss';
import type { ProcessConfig } from '../platform/config/index.js';
import { DATABASE, DatabaseModule, dbConfigOf } from '../platform/db/index.js';
import type { Database, DbTx } from '../platform/db/index.js';
import { BOSS, JobsModule } from '../platform/jobs/boss.js';
import type { RuntimeBoss } from '../platform/jobs/boss.js';
import { Heartbeat } from '../platform/jobs/heartbeat.js';
import { SWEEP_QUEUE, runRecoverySweep, sweepLockOf } from '../platform/jobs/sweep.js';
import { sweepRegistry } from '../platform/jobs/sweep-registry.js';
import type { SweepRegistry } from '../platform/jobs/sweep-registry.js';
import { EXIT_WATCHDOG, Watchdog } from '../platform/jobs/watchdog.js';
import { EgressModule } from '../platform/egress/index.js';
import type { EgressModuleConfig } from '../platform/egress/index.js';
import { AuditModule } from '../modules/audit/index.js';
import { BriefGenerationJob, BriefModule, ImageAnalysisJob, briefJobHandlers } from '../modules/brief/brief.module.js';
import { MediaService, STORAGE_PORT } from '../modules/media/index.js';
import type { StoragePort } from '../modules/media/index.js';
import { MEDIA_REPOSITORY } from '../modules/media/application/ports.js';
import type { MediaRepository } from '../modules/media/application/ports.js';
import { mediaConfigFrom } from '../modules/media/media.module.js';
import { ProductionWorkerModule, ProviderCopyCleanup, VideoCopyJob, VideoPollJob, VideoSubmitJob, productionJobHandlers } from '../modules/production/production.module.js';
import { UsageModule } from '../modules/usage/usage.module.js';
import { IdentityModule, InvitationJobs, identityJobHandlers } from '../modules/identity/index.js';
import { MediaModule, SanitizeJob, UnattachedSweep, mediaJobHandlers } from '../modules/media/media.module.js';
import { KeyUnsealer } from '../modules/provider-keys/infrastructure/key-unsealer.js';
import { ProviderKeysModule } from '../modules/provider-keys/provider-keys.module.js';
import { runLoggedJob } from '../platform/logging/index.js';

/**
 * The worker composition root (ARCHITECTURE §5.11, ADR-012): used by `main.worker.ts` and by the tests that must reach
 * the real wiring. This is the one file that may bind the provider-key unsealer (layer rule L3); no module that does
 * so exists yet, the unsealer is bound below from `KEK_PRIVATE_KEYS`.
 */

/** The cron table (ARCHITECTURE §5.11). A queue is scheduled only when its owning ticket registered a handler. */
export const EVERY_MINUTE = '* * * * *';
export const HOURLY = '0 * * * *';
export const CRON_SCHEDULES: readonly { readonly queue: string; readonly cron: string }[] = [
  { queue: SWEEP_QUEUE, cron: EVERY_MINUTE },
  { queue: 'media.unattached-sweep', cron: HOURLY },
  { queue: 'identity.expire-invitations', cron: HOURLY },
  { queue: 'production.provider-copy-cleanup', cron: HOURLY },
  { queue: 'platform.cleanup', cron: HOURLY },
];

export interface WorkerJob {
  readonly id: string;
  readonly name: string;
  readonly data: unknown;
}

/** A queue's handler, registered by the module that owns the queue. It throws to fail the job. */
export type JobHandler = (job: WorkerJob, log: Logger) => Promise<void>;

export type WorkerConfig = Partial<Pick<ProcessConfig, keyof EgressModuleConfig>> &
  Pick<
  ProcessConfig,
  | 'DATABASE_URL'
  | 'DATABASE_POOL_MAX'
  | 'DATABASE_ACQUIRE_TIMEOUT_MS'
  | 'WORKER_WATCHDOG_SECONDS'
  | 'WORKER_DRAIN_SECONDS'
  | 'WORKER_CONCURRENCY_PROVIDER'
  | 'WORKER_CONCURRENCY_SANITIZE'
  | 'WORKER_CONCURRENCY_DELETION'
  | 'HEARTBEAT_URL_WORKER'
>;

export interface WorkerOptions {
  readonly logger: Logger;
  /** Queue name to handler; each owning ticket contributes its own. */
  readonly handlers?: Readonly<Record<string, JobHandler>>;
  readonly registry?: SweepRegistry;
  /** The environment the key custody reads (`KEK_*`); `process.env` by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Replaces `process.exit` (tests). */
  readonly exit?: (code: number) => void;
  /** Replaces the egress module instance (tests point the OpenAI host at a local server); the product never sets it. */
  readonly egress?: DynamicModule;
  /** Replaces the WaveSpeed API origin with a local server's (tests); the product never sets it. */
  readonly wavespeedBaseUrl?: string;
  /** Replaces the OpenAI chat completions URL with a local server's (tests); the product never sets it. */
  readonly openAiChatUrl?: string;
}

const DEFAULT_DRAIN_SEC = 25;
const DEFAULT_WATCHDOG_SEC = 180;
const OPTIONS = Symbol('WORKER_OPTIONS');
const CONFIG = Symbol('WORKER_CONFIG');

function concurrencyOf(queue: string, config: WorkerConfig): number {
  if (queue.startsWith('brief.') || queue.startsWith('production.') || queue.startsWith('video.')) {
    return config.WORKER_CONCURRENCY_PROVIDER ?? 20;
  }
  if (queue.startsWith('media.')) return config.WORKER_CONCURRENCY_SANITIZE ?? 2;
  if (queue.startsWith('lifecycle.')) return config.WORKER_CONCURRENCY_DELETION ?? 2;
  return 1;
}

@Injectable()
export class WorkerRuntime implements OnApplicationBootstrap {
  readonly watchdog: Watchdog;
  readonly heartbeat: Heartbeat;
  private readonly registry: SweepRegistry;
  private draining = false;

  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(OPTIONS) private readonly options: WorkerOptions,
    @Inject(CONFIG) private readonly config: WorkerConfig,
  ) {
    const log = options.logger;
    this.registry = options.registry ?? sweepRegistry;
    this.watchdog = new Watchdog({
      limitSec: config.WORKER_WATCHDOG_SECONDS ?? DEFAULT_WATCHDOG_SEC,
      exit: options.exit ?? ((code) => process.exit(code)),
      onStall: (kind, stalledSec) =>
        log.error(
          { module: 'worker', outcome: 'error', durationMs: stalledSec * 1000 },
          `watchdog: ${kind} stalled for ${String(stalledSec)} s, exiting ${String(EXIT_WATCHDOG)}`,
        ),
    });
    this.heartbeat = new Heartbeat({ log, pingUrl: config.HEARTBEAT_URL_WORKER });
  }

  /** A transaction on the application pool, for handlers and sweep hooks. */
  unitOfWork<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return this.database.uow.run(fn);
  }

  /** The boss is started and checked (`JobsLifecycle`) before this runs. */
  async onApplicationBootstrap(): Promise<void> {
    const log = this.options.logger;
    const handlers: Record<string, JobHandler> = { ...this.options.handlers };
    for (const [queue, handler] of Object.entries(handlers)) {
      await this.work(queue, handler);
    }
    await this.work(SWEEP_QUEUE, async () => {
      await this.sweep();
    });
    for (const { queue, cron } of CRON_SCHEDULES) {
      if (queue === SWEEP_QUEUE || handlers[queue] !== undefined) {
        await this.boss.schedule(queue, cron);
      }
    }
    this.watchdog.start();
    this.heartbeat.start();
    // Settle whatever a previous worker left behind without waiting for the first cron tick. Not awaited: a sweep
    // that hangs must be caught by the watchdog, not hold the start-up.
    void this.sweep().catch(() => {
      log.warn({ module: 'worker', outcome: 'error' }, 'start-up recovery sweep failed');
    });
    log.info({ module: 'worker', outcome: 'ok' }, 'worker started');
  }

  /** One sweep tick: the watchdog counts it as progress only when it completed (run, or skipped on the lock). */
  async sweep(): Promise<void> {
    await runRecoverySweep({
      registry: this.registry,
      inTx: (fn) => this.unitOfWork(fn),
      log: this.options.logger,
      acquire: sweepLockOf(this.database.pool),
    });
    this.watchdog.sweepDone();
  }

  private async work(queue: string, handler: JobHandler): Promise<void> {
    await this.boss.work<unknown>(
      queue,
      { localConcurrency: concurrencyOf(queue, this.config), batchSize: 1 },
      async (jobs) => {
        for (const job of jobs) {
          const envelope = { id: job.id, name: queue, data: job.data as never };
          await runLoggedJob(this.options.logger, envelope, (log) =>
            handler({ id: job.id, name: queue, data: job.data }, log),
          );
        }
      },
    );
  }

  /**
   * SIGTERM path: stop taking jobs and wait up to WORKER_DRAIN_SECONDS for those in hand. A job still running at the
   * end of the window is left to pg-boss's expiry and the recovery sweep, never retried by this process.
   */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.heartbeat.stop();
    this.watchdog.stop();
    const windowMs = (this.config.WORKER_DRAIN_SECONDS ?? DEFAULT_DRAIN_SEC) * 1000;
    await (this.boss as RuntimeBoss).stop({ graceful: true, timeout: windowMs, close: false });
    this.options.logger.info({ module: 'worker', outcome: 'ok' }, 'worker drained');
  }
}

export interface WorkerApp {
  readonly context: INestApplicationContext;
  readonly runtime: WorkerRuntime;
}

/** The composition root: database, pg-boss (worker role: supervises and schedules), audit and the runtime. */
export async function createWorkerApp(config: WorkerConfig, options: WorkerOptions): Promise<WorkerApp> {
  const env = options.env ?? process.env;
  // Provider-key custody (REQ-015/016): the seal port and the one unsealer binding in the product. Unreadable or
  // non-RSA-3072 maps stop the start-up here.
  const keys = env['KEK_PUBLIC_KEYS'] === undefined ? [] : [ProviderKeysModule.register(env, 'worker')];
  const keyUnsealer = env['KEK_PRIVATE_KEYS'] === undefined ? undefined : KeyUnsealer.fromEnv(env);
  const unsealer = keyUnsealer === undefined ? [] : [{ provide: KeyUnsealer, useValue: keyUnsealer }];
  // Media (TASK-043): the sanitize job, the hourly sweep and the deletion helpers, on the worker's own storage token.
  const media = env['R2_ENDPOINT'] === undefined ? [] : [MediaModule.registerWorker(env)];
  // Brief (TASK-049): `brief.generate` and `brief.analyze-image` over the OpenAI adapter. Needs the key custody (the
  // unsealer), the two OpenAI models and the object storage; the spend ledger and egress it runs on come with it.
  const audit = AuditModule.register(options.logger);
  const briefEnabled =
    keyUnsealer !== undefined &&
    media.length > 0 &&
    env['OPENAI_TEXT_MODEL'] !== undefined &&
    env['OPENAI_VISION_MODEL'] !== undefined;
  // Production (TASK-053): the WaveSpeed clip jobs. Like brief it needs the key custody and the object storage.
  const productionEnabled = keyUnsealer !== undefined && media.length > 0;
  // One usage module instance serves both, so the start-up price check runs once.
  const usage = briefEnabled || productionEnabled ? UsageModule.register(env) : undefined;
  const brief = briefEnabled
    ? [
        BriefModule.registerWorker(env, {
          audit,
          egress: options.egress ?? EgressModule.register(config),
          usage: usage as DynamicModule,
          opener: keyUnsealer,
          storage: () => context.get<StoragePort>(STORAGE_PORT, { strict: false }),
          ...(options.openAiChatUrl === undefined ? {} : { chatUrl: options.openAiChatUrl }),
        }),
      ]
    : [];
  const production =
    productionEnabled
      ? [
          ProductionWorkerModule.register(env, {
            audit,
            egress: options.egress ?? EgressModule.register(config),
            usage: usage as DynamicModule,
            opener: keyUnsealer,
            storage: () => context.get<StoragePort>(STORAGE_PORT, { strict: false }),
            media: () => mediaService(),
            registry: options.registry ?? sweepRegistry,
            ...(options.wavespeedBaseUrl === undefined ? {} : { baseUrl: options.wavespeedBaseUrl }),
          }),
        ]
      : [];
  // The media module's public service for the clip copy (signed reference URL, object registration), built on the worker's
  // own repository and storage; the media worker module does not carry it.
  let media$: MediaService | undefined;
  const mediaService = (): MediaService => {
    media$ ??= new MediaService(
      context.get(DATABASE, { strict: false }),
      context.get<MediaRepository>(MEDIA_REPOSITORY, { strict: false }),
      context.get<StoragePort>(STORAGE_PORT, { strict: false }),
      mediaConfigFrom(env),
    );
    return media$;
  };
  // Queue handlers of the modules (the owning module's jobs); a handler a caller passes for the same queue wins.
  const moduleHandlers = identityJobHandlers(() => context.get(InvitationJobs, { strict: false }));
  const merged: WorkerOptions = {
    ...options,
    handlers: {
      ...(moduleHandlers as Record<string, JobHandler>),
      ...(media.length === 0
        ? {}
        : mediaJobHandlers({
            sanitize: () => context.get(SanitizeJob, { strict: false }),
            sweep: () => context.get(UnattachedSweep, { strict: false }),
          })),
      ...(brief.length === 0
        ? {}
        : briefJobHandlers({
            generate: () => context.get(BriefGenerationJob, { strict: false }),
            analyze: () => context.get(ImageAnalysisJob, { strict: false }),
          })),
      ...(production.length === 0
        ? {}
        : productionJobHandlers({
            submit: () => context.get(VideoSubmitJob, { strict: false }),
            poll: () => context.get(VideoPollJob, { strict: false }),
            copy: () => context.get(VideoCopyJob, { strict: false }),
            cleanup: () => context.get(ProviderCopyCleanup, { strict: false }),
          })),
      ...options.handlers,
    },
  };
  @Module({
    imports: [
      DatabaseModule.forRoot(dbConfigOf(config)),
      JobsModule.forRoot({ DATABASE_URL: dbConfigOf(config).DATABASE_URL, role: 'worker' }),
      audit,
      IdentityModule.registerWorker(env),
      ...keys,
      ...media,
      ...brief,
      ...production,
    ],
    providers: [
      ...unsealer,
      { provide: OPTIONS, useValue: merged },
      { provide: CONFIG, useValue: config },
      WorkerRuntime,
    ],
  })
  class WorkerModule {}
  const context: INestApplicationContext = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  return { context, runtime: context.get(WorkerRuntime) };
}
