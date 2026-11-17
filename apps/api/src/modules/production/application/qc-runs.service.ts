import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { campaigns } from '../../../database/schema/campaigns.js';
import { providerKeys } from '../../../database/schema/provider-keys.js';
import { qcRuns, videoJobs } from '../../../database/schema/production.js';
import { DATABASE, isUniqueViolation, lockXact } from '../../../platform/db/index.js';
import type { Database, DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { lookupRecord, withIdempotency } from '../../../platform/idempotency/index.js';
import { BOSS } from '../../../platform/jobs/boss.js';
import { enqueue } from '../../../platform/jobs/enqueue.js';
import { UsageService } from '../../usage/index.js';
import { QC_DEADLINE_MINUTES, qcReuseHash } from './qc-start.js';
import { QC_RUN_QUEUE } from './qc-run.job.js';
import type { QcRecord, VideoConfig } from './video-ports.js';
import { VIDEO_CONFIG } from './video-ports.js';

const NON_TERMINAL = ['pending', 'submitting', 'submitted', 'processing'];

export interface QcRunOutcome {
  readonly run: QcRecord;
  readonly reused: boolean;
}

const RUN_COLUMNS = {
  id: qcRuns.id,
  videoJobId: qcRuns.videoJobId,
  qcState: qcRuns.qcState,
  reason: qcRuns.reason,
  state: qcRuns.state,
  causeClass: qcRuns.causeClass,
  causeMessage: qcRuns.causeMessage,
  createdAt: qcRuns.createdAt,
  updatedAt: qcRuns.updatedAt,
  deadlineAt: qcRuns.deadlineAt,
};

/**
 * API-064 (REQ-010, ARCHITECTURE §5.6): check the audio of a completed clip again. A paid, job-creating call (SB-D14): the
 * checks run in the order replay, clip completed, live run reuse, key, spend cap, then the new `qc_runs` row, its
 * reservation and its queue message are written together. The earlier runs stay as history. Owner-scoped in the statement,
 * so a foreign and a missing clip both answer `not_found`.
 */
@Injectable()
export class QcRunsService {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(BOSS) private readonly boss: Parameters<typeof enqueue>[0],
    @Inject(VIDEO_CONFIG) private readonly config: VideoConfig,
  ) {}

  async rerun(
    ownerId: string,
    videoJobId: string,
    key: string,
    requestHash: Buffer,
  ): Promise<QcRunOutcome> {
    try {
      return await this.database.uow.run((tx) =>
        this.rerunIn(tx, ownerId, videoJobId, key, requestHash),
      );
    } catch (error) {
      // Two creators raced for the unique run row: the retry finds the winner's live run and reuses it.
      if (!isUniqueViolation(error, 'qc_runs_reuse_uq')) throw error;
      return this.database.uow.run((tx) => this.rerunIn(tx, ownerId, videoJobId, key, requestHash));
    }
  }

  private async rerunIn(
    tx: DbTx,
    ownerId: string,
    videoJobId: string,
    key: string,
    requestHash: Buffer,
  ): Promise<QcRunOutcome> {
    const [job] = await tx
      .select({ state: videoJobs.state })
      .from(videoJobs)
      .innerJoin(campaigns, eq(campaigns.id, videoJobs.campaignId))
      .where(
        and(
          eq(videoJobs.id, videoJobId),
          eq(videoJobs.ownerId, ownerId),
          eq(campaigns.state, 'active'),
        ),
      )
      .for('update', { of: videoJobs });
    if (job === undefined) throw new DomainError('not_found', 'This video job does not exist.');
    const scope = { ownerId, operationId: 'API-064', key, requestHash } as const;
    const record = await lookupRecord(tx, scope);
    if (record !== undefined) {
      if (!record.requestHash.equals(requestHash)) {
        throw new DomainError(
          'idempotency_key_reused',
          'This request key was already used for a different request.',
        );
      }
      return { run: await this.runById(tx, ownerId, record.resourceId), reused: true };
    }
    if (job.state !== 'completed') {
      throw new DomainError('clip_not_completed', 'Only a finished clip can be checked.', [
        {
          field: 'videoJobId',
          code: 'clip_not_completed',
          message: 'This clip is not finished yet.',
        },
      ]);
    }
    const [live] = await tx
      .select({ id: qcRuns.id })
      .from(qcRuns)
      .where(and(eq(qcRuns.videoJobId, videoJobId), inArray(qcRuns.state, NON_TERMINAL)));
    const outcome = await withIdempotency(
      tx,
      scope,
      {
        resourceType: 'qc_run',
        responseStatus: 202,
        ttlHours: this.config.idempotencyTtlHours,
        resourceId: live?.id,
      },
      async (id) => {
        if (live !== undefined) return { id: live.id, reused: true };
        await this.create(tx, ownerId, videoJobId, id);
        return { id, reused: false };
      },
    );
    const id = outcome.replayed ? outcome.resourceId : outcome.result.id;
    const reused = outcome.replayed || outcome.result.reused;
    return { run: await this.runById(tx, ownerId, id), reused };
  }

  /** The key check of REQ-019, the cap check with the reservation, the run and its queue message: before any paid call. */
  private async create(tx: DbTx, ownerId: string, videoJobId: string, id: string): Promise<void> {
    await lockXact(tx, 'spend', ownerId);
    const key = await this.openAiKey(tx, ownerId);
    await this.usage.reserve(tx, {
      ownerId,
      jobType: 'qc',
      jobId: id,
      calls: [{ provider: 'openai', operation: this.config.transcribeModel }],
    });
    await tx.insert(qcRuns).values({
      id,
      ownerId,
      videoJobId,
      reuseHash: qcReuseHash(videoJobId, id),
      keyId: key.id,
      keyVersion: key.version,
      deadlineAt: sql`now() + make_interval(mins => ${QC_DEADLINE_MINUTES})`,
    });
    await enqueue(this.boss, tx, QC_RUN_QUEUE, { runId: id }, { singletonKey: id });
  }

  private async openAiKey(tx: DbTx, ownerId: string): Promise<{ id: string; version: number }> {
    const [key] = await tx
      .select({ id: providerKeys.id, status: providerKeys.status, version: providerKeys.version })
      .from(providerKeys)
      .where(and(eq(providerKeys.ownerId, ownerId), eq(providerKeys.provider, 'openai')));
    if (key === undefined) {
      throw new DomainError('key_missing', 'Add your OpenAI key in Settings, then try again.', [
        {
          field: 'openaiKey',
          code: 'missing',
          message: 'No OpenAI key is stored for your account.',
        },
      ]);
    }
    if (key.status === 'disabled') {
      throw new DomainError(
        'key_disabled',
        'Your OpenAI key is disabled. Enter it again in Settings, then try again.',
        [
          {
            field: 'openaiKey',
            code: 'disabled',
            message: 'Your OpenAI key was disabled after repeated authentication failures.',
          },
        ],
      );
    }
    return key;
  }

  private async runById(tx: DbTx, ownerId: string, id: string): Promise<QcRecord> {
    const [run] = await tx
      .select(RUN_COLUMNS)
      .from(qcRuns)
      .where(and(eq(qcRuns.id, id), eq(qcRuns.ownerId, ownerId)));
    if (run === undefined)
      throw new DomainError('not_found', 'This request no longer has a result.');
    return run;
  }
}
