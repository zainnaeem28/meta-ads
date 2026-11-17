import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { AccountErasureJob } from './application/account-erasure.job.js';
import { ACCOUNT_ERASURE_QUEUE } from './application/account-erasure-steps.js';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_CURSOR_KEY,
  ACCOUNT_ERASURE_QUEUEING,
  ACCOUNT_HOLD_HOURS,
  ACCOUNT_IDENTITY,
  ACCOUNT_LIFECYCLE_REPOSITORY,
} from './application/account-lifecycle-ports.js';
import { AccountLifecycleService } from './application/account-lifecycle.service.js';
import { CampaignDeletionJob } from './application/campaign-deletion.job.js';
import {
  CAMPAIGN_BRIEF_TEXT_MODEL,
  CAMPAIGN_DELETION_CONFIG,
  CAMPAIGN_DELETION_QUEUEING,
  CAMPAIGN_DELETION_REPOSITORY,
  CAMPAIGN_ERASURE_LEDGER,
  CAMPAIGN_MEDIA_PURGE,
  CAMPAIGN_PROVIDER_TASKS,
} from './application/campaign-deletion-ports.js';
import type {
  CampaignDeletionConfig,
  CampaignMediaPurge,
  CampaignProviderTasks,
  JobLog,
} from './application/campaign-deletion-ports.js';
import { CampaignDeletionService } from './application/campaign-deletion.service.js';
import { CAMPAIGN_DELETION_QUEUE } from './domain/campaign-deletion.js';
import {
  IdentityAccountAdmin,
  IdentityProviderAccounts,
} from './infrastructure/account-identity.adapters.js';
import { PgBossAccountErasureQueueing } from './infrastructure/account-erasure.queueing.js';
import { DrizzleAccountLifecycleRepository } from './infrastructure/account-lifecycle.repository.js';
import { DrizzleCampaignDeletionRepository } from './infrastructure/campaign-deletion.repository.js';
import { PgBossCampaignDeletionQueueing } from './infrastructure/campaign-deletion.queueing.js';
import { S3ErasureLedger } from './infrastructure/campaign-erasure-ledger.js';
import { AccountLifecycleController } from './transport/account-lifecycle.controller.js';
import { CampaignDeletionController } from './transport/campaign-deletion.controller.js';

type Env = Readonly<Record<string, string | undefined>>;

const VERIFY_GRACE_SECONDS = 60;

function optional(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const text = optional(env, name);
  const value = text === undefined ? fallback : Number(text);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${String(min)} to ${String(max)}`);
  return value;
}

/** The registry defaults for the deletion run; a setting that is present is checked, so a bad one stops the process. */
export function deletionConfigFrom(env: Env): CampaignDeletionConfig {
  return {
    retryLimit: integer(env, 'DELETION_RETRY_LIMIT', 10, 1, 50),
    jobDeadlineMinutes: integer(env, 'VIDEO_JOB_DEADLINE_MIN', 30, 5, 180),
    graceSeconds: VERIFY_GRACE_SECONDS,
  };
}

/** What the api composition root passes in: the audit trail (layer 1), the usage ledger (3) and production (6). */
export interface LifecycleEdge {
  readonly audit: DynamicModule;
  readonly usage: DynamicModule;
  readonly production: DynamicModule;
}

/** What the worker composition root passes in; the media helper and the provider cleanup are resolved when first used. */
export interface LifecycleWorkerEdge {
  readonly audit: DynamicModule;
  readonly media: () => CampaignMediaPurge;
  readonly providerTasks: (() => { run(log: JobLog): Promise<unknown> }) | undefined;
}

/**
 * Lifecycle (layer 7): campaign deletion, API-042 and the `lifecycle.campaign-deletion` run over `deletion_runs` (M0007,
 * TASK-058); account suspension, reinstatement and removal, API-101..103 and 105, and the `lifecycle.account-erasure`
 * run (TASK-059). Needs the database and the job queue.
 */
@Module({})
export class LifecycleModule {
  static register(env: Env, edge: LifecycleEdge): DynamicModule {
    return {
      module: LifecycleModule,
      imports: [edge.audit, edge.usage, edge.production],
      providers: [
        { provide: CAMPAIGN_DELETION_REPOSITORY, useClass: DrizzleCampaignDeletionRepository },
        { provide: CAMPAIGN_DELETION_QUEUEING, useClass: PgBossCampaignDeletionQueueing },
        {
          provide: CAMPAIGN_BRIEF_TEXT_MODEL,
          useValue: optional(env, 'OPENAI_TEXT_MODEL') ?? 'brief-text',
        },
        CampaignDeletionService,
        { provide: ACCOUNT_LIFECYCLE_REPOSITORY, useClass: DrizzleAccountLifecycleRepository },
        { provide: ACCOUNT_ADMIN, useClass: IdentityAccountAdmin },
        { provide: ACCOUNT_ERASURE_QUEUEING, useClass: PgBossAccountErasureQueueing },
        {
          provide: ACCOUNT_HOLD_HOURS,
          useValue: integer(env, 'ERASURE_HOLD_PERIOD_HOURS', 0, 0, 8760),
        },
        { provide: ACCOUNT_CURSOR_KEY, useValue: optional(env, 'CURSOR_SIGNING_KEY') },
        AccountLifecycleService,
      ],
      controllers: [CampaignDeletionController, AccountLifecycleController],
    };
  }

  /** The worker side: the run's handler on the worker's own storage token, the ledger token and the provider cleanup. */
  static registerWorker(env: Env, edge: LifecycleWorkerEdge): DynamicModule {
    const required = (name: string): string => {
      const value = optional(env, name);
      if (value === undefined) throw new Error(`${name} is required for the campaign deletion run`);
      return value;
    };
    const ledger = new S3ErasureLedger({
      endpoint: required('R2_ENDPOINT'),
      bucket: required('R2_LEDGER_BUCKET'),
      accessKeyId: required('R2_LEDGER_ACCESS_KEY_ID'),
      secretAccessKey: required('R2_LEDGER_SECRET_ACCESS_KEY'),
    });
    const lazyMedia: CampaignMediaPurge = {
      deleteForCampaign: (id) => edge.media().deleteForCampaign(id),
      sweepPrefix: (prefix) => edge.media().sweepPrefix(prefix),
    };
    const providerTasks: CampaignProviderTasks = {
      deleteFinishedTasks: async (log) => {
        // The hourly cleanup's own pass: finished tasks of cancelled or completed clips are deleted, running ones wait.
        if (edge.providerTasks !== undefined) await edge.providerTasks().run(log);
      },
    };
    return {
      module: LifecycleModule,
      imports: [edge.audit],
      providers: [
        { provide: CAMPAIGN_DELETION_REPOSITORY, useClass: DrizzleCampaignDeletionRepository },
        { provide: CAMPAIGN_DELETION_QUEUEING, useClass: PgBossCampaignDeletionQueueing },
        { provide: CAMPAIGN_DELETION_CONFIG, useValue: deletionConfigFrom(env) },
        { provide: CAMPAIGN_ERASURE_LEDGER, useValue: ledger },
        { provide: CAMPAIGN_MEDIA_PURGE, useValue: lazyMedia },
        { provide: CAMPAIGN_PROVIDER_TASKS, useValue: providerTasks },
        CampaignDeletionJob,
        { provide: ACCOUNT_LIFECYCLE_REPOSITORY, useClass: DrizzleAccountLifecycleRepository },
        { provide: ACCOUNT_IDENTITY, useClass: IdentityProviderAccounts },
        { provide: ACCOUNT_ERASURE_QUEUEING, useClass: PgBossAccountErasureQueueing },
        AccountErasureJob,
      ],
      exports: [CampaignDeletionJob, AccountErasureJob],
    };
  }
}

/** The queue handlers of this module, resolved when a job arrives (the worker composition root binds them). */
export function lifecycleJobHandlers(resolve: {
  readonly campaignDeletion: () => CampaignDeletionJob;
  readonly accountErasure: () => AccountErasureJob;
}): Readonly<Record<string, (job: { id: string; data: unknown }, log: JobLog) => Promise<void>>> {
  return {
    [CAMPAIGN_DELETION_QUEUE]: async (job, log) => {
      await resolve.campaignDeletion().handle(job, log);
    },
    [ACCOUNT_ERASURE_QUEUE]: async (job, log) => {
      await resolve.accountErasure().handle(job, log);
    },
  };
}

export { AccountErasureJob, CampaignDeletionJob };
