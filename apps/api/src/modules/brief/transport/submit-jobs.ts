import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import { briefJobs } from '../../../database/schema/brief.js';
import { providerKeys } from '../../../database/schema/provider-keys.js';
import { DATABASE, isUniqueViolation, lockXact } from '../../../platform/db/index.js';
import type { Database, DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { lookupRecord, withIdempotency } from '../../../platform/idempotency/index.js';
import type { IdempotencyScope, StoredResource } from '../../../platform/idempotency/index.js';
import { BOSS } from '../../../platform/jobs/boss.js';
import { enqueue } from '../../../platform/jobs/enqueue.js';
import { newId } from '../../../platform/shared-kernel/index.js';
import { UsageService } from '../../usage/index.js';
import type { BillableCall, JobType } from '../../usage/index.js';

/** The models the api prices a reservation with (`OPENAI_TEXT_MODEL`, `OPENAI_VISION_MODEL`), read once at start-up. */
export const BRIEF_JOB_MODELS = Symbol('BRIEF_JOB_MODELS');
export const JOB_IDEMPOTENCY_TTL = Symbol('JOB_IDEMPOTENCY_TTL');

export interface BriefJobModels {
  readonly text: string | undefined;
  readonly vision: string | undefined;
}

export type JobKind = 'brief_generation' | 'image_analysis';

/** What the job-creating rule (SB-D14) needs to make, find or replay one brief job. */
export interface JobSpec {
  readonly ownerId: string;
  readonly operationId: 'API-024' | 'API-035' | 'API-053';
  readonly key: string;
  readonly requestHash: Buffer;
  readonly kind: JobKind;
  readonly campaignId?: string;
  readonly mediaId?: string;
  readonly generationSeq: number;
  /** The `(owner, reuse_hash)` identity of the work: one live job per piece of work (`brief_jobs_reuse_uq`). */
  readonly reuseHash: string;
  /** What the idempotency record stands for; API-024 stores the campaign, the others the job. */
  readonly resource: { readonly type: 'campaign' | 'brief_job'; readonly id?: string };
}

export interface JobRow {
  readonly id: string;
  readonly state: string;
  readonly causeClass: string | null;
  readonly causeMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deadlineAt: string;
}

export interface JobOutcome {
  readonly job: JobRow;
  readonly reused: boolean;
}

const JOB_COLUMNS = {
  id: briefJobs.id,
  state: briefJobs.state,
  causeClass: briefJobs.causeClass,
  causeMessage: briefJobs.causeMessage,
  createdAt: briefJobs.createdAt,
  updatedAt: briefJobs.updatedAt,
  deadlineAt: briefJobs.deadlineAt,
};

const QUEUES = {
  brief_generation: 'brief.generate',
  image_analysis: 'brief.analyze-image',
} as const;
const DEADLINE_MINUTES = 10;
const NOT_LIVE = ['failed', 'cancelled'];

/** SHA-256 of the work a job does, as 64 hex characters (the `reuse_hash` column). */
export function reuseHashOf(kind: JobKind, subjectId: string, generationSeq = 0): string {
  return createHash('sha256')
    .update(`${kind}\n${subjectId}\n${String(generationSeq)}`)
    .digest('hex');
}

/**
 * The job-creating use case of ARCHITECTURE §2.6 and SB-D14, run inside the caller's transaction: the idempotency record,
 * the reuse lookup, the owner's `spend:` lock, the key check, the cap check, the job with its reservation and the
 * `send({db})` on the same transaction, so the job exists only when the whole commit does.
 */
@Injectable()
export class BriefJobCreator {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(BOSS) private readonly boss: Parameters<typeof enqueue>[0],
    @Inject(BRIEF_JOB_MODELS) private readonly models: BriefJobModels,
    @Inject(JOB_IDEMPOTENCY_TTL) private readonly ttlHours: number,
  ) {}

  /** Runs `body` as one transaction, once more when a concurrent creator won the reuse index (the retry then reuses its job). */
  async inTransaction<T>(body: (tx: DbTx) => Promise<T>): Promise<T> {
    try {
      return await this.database.uow.run(body);
    } catch (error) {
      if (!isUniqueViolation(error, 'brief_jobs_reuse_uq')) throw error;
      return this.database.uow.run(body);
    }
  }

  /** The idempotency scope of one request. */
  scope(spec: Pick<JobSpec, 'ownerId' | 'operationId' | 'key' | 'requestHash'>): IdempotencyScope {
    return {
      ownerId: spec.ownerId,
      operationId: spec.operationId,
      key: spec.key,
      requestHash: spec.requestHash,
    };
  }

  /**
   * One job per `(owner, operation, key)` and one per piece of work: a repeated key replays the stored job, a second key for
   * the same work reuses the live job; neither writes a second job or reservation.
   */
  async createOrReuse(tx: DbTx, spec: JobSpec, prepare?: () => Promise<void>): Promise<JobOutcome> {
    const reusable = await this.findReusable(tx, spec.ownerId, spec.reuseHash);
    const stored: Omit<StoredResource, 'resourceId'> = {
      resourceType: spec.resource.type,
      responseStatus: 202,
    };
    const outcome = await withIdempotency(
      tx,
      this.scope(spec),
      { ...stored, ttlHours: this.ttlHours, resourceId: spec.resource.id ?? reusable?.id },
      async (resourceId) => {
        if (reusable !== undefined) return { job: reusable, reused: true };
        // What the job hangs on (the campaign and brief of a submit) is written first, in this transaction.
        if (prepare !== undefined) await prepare();
        // The record's own ID is the job's when it stands for the job.
        return {
          job: await this.create(
            tx,
            spec,
            spec.resource.type === 'brief_job' ? resourceId : newId(),
          ),
          reused: false,
        };
      },
    );
    if (!outcome.replayed) return outcome.result;
    const job = await this.replayedJob(tx, spec, outcome.resourceId);
    return { job, reused: true };
  }

  /**
   * A submit of a draft that already has its campaign: the stored campaign and job come back and nothing is created, even
   * when the earlier job has since failed. The key is recorded so that a later request with it replays the same way.
   */
  async replay(tx: DbTx, spec: JobSpec): Promise<JobOutcome> {
    const campaignId = spec.resource.id;
    if (campaignId === undefined) throw new TypeError('a replay needs the stored campaign');
    const stored = {
      resourceType: spec.resource.type,
      responseStatus: 202,
      ttlHours: this.ttlHours,
      resourceId: campaignId,
    };
    await withIdempotency(tx, this.scope(spec), stored, () => Promise.resolve(undefined));
    return { job: await this.replayedJob(tx, spec, campaignId), reused: true };
  }

  /** The outcome stored under the request's key, when the key is already recorded (409 when it was used for another request). */
  async replayIfRecorded(tx: DbTx, spec: JobSpec): Promise<JobOutcome | undefined> {
    const record = await lookupRecord(tx, spec);
    if (record === undefined) return undefined;
    if (!record.requestHash.equals(spec.requestHash)) {
      throw new DomainError(
        'idempotency_key_reused',
        'This request key was already used for a different request.',
      );
    }
    return { job: await this.replayedJob(tx, spec, record.resourceId), reused: true };
  }

  /** The newest live job of a piece of work, if any. */
  async findReusable(tx: DbTx, ownerId: string, reuseHash: string): Promise<JobRow | undefined> {
    const rows = await tx
      .select(JOB_COLUMNS)
      .from(briefJobs)
      .where(
        and(
          eq(briefJobs.ownerId, ownerId),
          eq(briefJobs.reuseHash, reuseHash),
          notInArray(briefJobs.state, NOT_LIVE),
        ),
      );
    return rows[0];
  }

  /** The job a replayed record stands for: the job itself, or the newest generation job of the campaign it created. */
  private async replayedJob(tx: DbTx, spec: JobSpec, resourceId: string): Promise<JobRow> {
    const where =
      spec.resource.type === 'brief_job'
        ? and(eq(briefJobs.id, resourceId), eq(briefJobs.ownerId, spec.ownerId))
        : and(
            eq(briefJobs.campaignId, resourceId),
            eq(briefJobs.ownerId, spec.ownerId),
            eq(briefJobs.kind, 'brief_generation'),
          );
    const rows = await tx
      .select(JOB_COLUMNS)
      .from(briefJobs)
      .where(where)
      .orderBy(desc(briefJobs.createdAt), desc(briefJobs.id))
      .limit(1);
    const row = rows[0];
    if (row === undefined)
      throw new DomainError('not_found', 'This request no longer has a result.');
    return row;
  }

  private calls(kind: JobKind): { jobType: JobType; calls: BillableCall[] } {
    const model = kind === 'brief_generation' ? this.models.text : this.models.vision;
    if (model === undefined) {
      throw new DomainError(
        'service_unavailable',
        'This service is not configured for AI generation yet. Try again later.',
      );
    }
    const call: BillableCall = { provider: 'openai', operation: model };
    // A brief generation may make two calls (the second shortens long segments), both reserved up front (§5.3).
    return kind === 'brief_generation'
      ? { jobType: 'brief_generation', calls: [call, call] }
      : { jobType: 'image_analysis', calls: [call] };
  }

  /** SB-D14 after the reuse lookup: lock, key check, cap check, job and reservation, then the queue message. */
  private async create(tx: DbTx, spec: JobSpec, id: string): Promise<JobRow> {
    const { jobType, calls } = this.calls(spec.kind);
    await lockXact(tx, 'spend', spec.ownerId);
    const key = await this.openAiKey(tx, spec.ownerId);
    await this.usage.reserve(tx, { ownerId: spec.ownerId, jobType, jobId: id, calls });
    const [row] = await tx
      .insert(briefJobs)
      .values({
        id,
        ownerId: spec.ownerId,
        kind: spec.kind,
        campaignId: spec.campaignId ?? null,
        mediaId: spec.mediaId ?? null,
        generationSeq: spec.generationSeq,
        reuseHash: spec.reuseHash,
        keyId: key.id,
        keyVersion: key.version,
        deadlineAt: sql`now() + make_interval(mins => ${DEADLINE_MINUTES})`,
      })
      .returning(JOB_COLUMNS);
    if (row === undefined) throw new Error('brief job insert returned no row');
    await enqueue(this.boss, tx, QUEUES[spec.kind], { jobId: id });
    return row;
  }

  /** The key check of REQ-019: no key, or a disabled one, is refused with the name of the missing setting. */
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
}
