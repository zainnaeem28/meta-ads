import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { campaigns } from '../../../database/schema/campaigns.js';
import { providerKeys } from '../../../database/schema/provider-keys.js';
import { thumbstopperJobs } from '../../../database/schema/production-thumb.js';
import { DATABASE, isUniqueViolation, lockXact } from '../../../platform/db/index.js';
import type { Database, DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { lookupRecord, withIdempotency } from '../../../platform/idempotency/index.js';
import { BOSS } from '../../../platform/jobs/boss.js';
import { enqueue } from '../../../platform/jobs/enqueue.js';
import { UsageService } from '../../usage/index.js';
import { CALLOUT_RULES, THUMB_CONFIG } from './thumb-ports.js';
import type { CalloutRules, ThumbConfig } from './thumb-ports.js';
import { checkCallout, thumbReuseHash } from './thumb-callout.js';

export const THUMB_SUBMIT_QUEUE = 'production.thumbstopper-submit';
const NOT_LIVE = ['failed', 'cancelled'];
const NON_TERMINAL = ['pending', 'submitting', 'submitted', 'processing'];

/** `Thumbstopper` of the contract (the `JobSummary` fields and the call-out). */
export interface ThumbRecord {
  readonly id: string;
  readonly state: string;
  readonly causeClass: string | null;
  readonly causeMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deadlineAt: string;
  readonly campaignId: string;
  readonly calloutText: string;
  readonly outputMediaId: string | null;
}

export interface ThumbOutcome {
  readonly job: ThumbRecord;
  readonly reused: boolean;
}

const COLUMNS = {
  id: thumbstopperJobs.id,
  state: thumbstopperJobs.state,
  causeClass: thumbstopperJobs.causeClass,
  causeMessage: thumbstopperJobs.causeMessage,
  createdAt: thumbstopperJobs.createdAt,
  updatedAt: thumbstopperJobs.updatedAt,
  deadlineAt: thumbstopperJobs.deadlineAt,
  campaignId: thumbstopperJobs.campaignId,
  calloutText: thumbstopperJobs.calloutText,
  outputMediaId: thumbstopperJobs.outputMediaId,
};

const notFound = (what: string): DomainError =>
  new DomainError('not_found', `This ${what} does not exist.`);

/**
 * API-075 and API-076 (REQ-022, ARCHITECTURE §5.5): generate the call-out image of a campaign on the owner's OpenAI key, or
 * read the latest one. A paid, job-creating call (SB-D14): the checks run in the order campaign, replay, claim rules, live
 * job reuse, key, spend cap, then the new row, its reservation and its queue message are written together. Owner-scoped in
 * the statement, so a foreign and a missing campaign both answer `not_found`.
 */
@Injectable()
export class ThumbService {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(BOSS) private readonly boss: Parameters<typeof enqueue>[0],
    @Inject(THUMB_CONFIG) private readonly config: ThumbConfig,
    @Inject(CALLOUT_RULES) private readonly rules: CalloutRules,
  ) {}

  async generate(
    ownerId: string,
    campaignId: string,
    calloutText: string,
    key: string,
    requestHash: Buffer,
  ): Promise<ThumbOutcome> {
    const model = this.config.imageModel;
    if (model === undefined) {
      throw new DomainError(
        'service_unavailable',
        'This service is not configured for image generation yet. Try again later.',
      );
    }
    const rules = await this.rules.activeRules();
    const run = (): Promise<ThumbOutcome> =>
      this.database.uow.run((tx) =>
        this.generateIn(tx, { ownerId, campaignId, calloutText, key, requestHash, model, rules }),
      );
    try {
      return await run();
    } catch (error) {
      // Two creators raced for the unique job row: the retry finds the winner's live job and reuses it.
      if (!isUniqueViolation(error, 'thumbstopper_jobs_reuse_uq')) throw error;
      return run();
    }
  }

  /** API-076: the newest job of the campaign, or null when it has none. */
  async latest(ownerId: string, campaignId: string): Promise<ThumbRecord | null> {
    return this.database.uow.run(async (tx) => {
      await this.assertCampaign(tx, ownerId, campaignId, false);
      const [job] = await tx
        .select(COLUMNS)
        .from(thumbstopperJobs)
        .where(
          and(eq(thumbstopperJobs.campaignId, campaignId), eq(thumbstopperJobs.ownerId, ownerId)),
        )
        .orderBy(desc(thumbstopperJobs.createdAt), desc(thumbstopperJobs.id))
        .limit(1);
      return job ?? null;
    });
  }

  /** Jobs in flight on the owner's OpenAI key (SB §4.2). */
  async inFlight(ownerId: string): Promise<number> {
    return this.database.uow.run(async (tx) => {
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(thumbstopperJobs)
        .where(
          and(eq(thumbstopperJobs.ownerId, ownerId), inArray(thumbstopperJobs.state, NON_TERMINAL)),
        );
      return row?.count ?? 0;
    });
  }

  /** Campaign deletion, suspension or removal (SB-D17), in the caller's transaction: every unfinished job becomes `cancelled`. */
  async cancel(tx: DbTx, ownerId: string, cause: string, campaignId?: string): Promise<number> {
    await lockXact(tx, 'spend', ownerId);
    const live = await tx
      .select({
        id: thumbstopperJobs.id,
        state: thumbstopperJobs.state,
        model: thumbstopperJobs.providerModel,
      })
      .from(thumbstopperJobs)
      .where(
        and(
          eq(thumbstopperJobs.ownerId, ownerId),
          inArray(thumbstopperJobs.state, NON_TERMINAL),
          campaignId === undefined ? undefined : eq(thumbstopperJobs.campaignId, campaignId),
        ),
      )
      .for('update');
    if (live.length > 0) {
      await tx
        .update(thumbstopperJobs)
        .set({
          state: 'cancelled',
          causeClass: cause,
          causeMessage: 'This image was cancelled.',
          updatedAt: sql`now()`,
        })
        .where(
          inArray(
            thumbstopperJobs.id,
            live.map((job) => job.id),
          ),
        );
    }
    for (const job of live) {
      // A call that may already have been sent has an unknown outcome and keeps its estimate counted (SB-D9).
      if (job.state === 'submitting') {
        await this.usage.convertUnconfirmed(tx, {
          ownerId,
          jobType: 'thumbstopper',
          jobId: job.id,
          callSeq: 1,
          call: { provider: 'openai', operation: job.model },
        });
      }
      await this.usage.release(tx, { ownerId, jobType: 'thumbstopper', jobId: job.id });
    }
    return live.length;
  }

  private async generateIn(
    tx: DbTx,
    input: {
      ownerId: string;
      campaignId: string;
      calloutText: string;
      key: string;
      requestHash: Buffer;
      model: string;
      rules: Awaited<ReturnType<CalloutRules['activeRules']>>;
    },
  ): Promise<ThumbOutcome> {
    const { ownerId, campaignId, calloutText, key, requestHash, model } = input;
    await this.assertCampaign(tx, ownerId, campaignId, true);
    const scope = { ownerId, operationId: 'API-075', key, requestHash } as const;
    const record = await lookupRecord(tx, scope);
    if (record !== undefined) {
      if (!record.requestHash.equals(requestHash)) {
        throw new DomainError(
          'idempotency_key_reused',
          'This request key was already used for a different request.',
        );
      }
      return { job: await this.byId(tx, ownerId, record.resourceId), reused: true };
    }
    const issues = checkCallout(input.rules, calloutText);
    if (issues.length > 0) {
      throw new DomainError(
        'open_claim_issues',
        'Change the call-out text so it passes the claim rules, then try again.',
        issues.map((issue) => ({
          field: 'calloutText',
          code: issue.ruleId,
          message: issue.message,
        })),
      );
    }
    const reuseHash = thumbReuseHash(campaignId, calloutText, model);
    const [reusable] = await tx
      .select({ id: thumbstopperJobs.id })
      .from(thumbstopperJobs)
      .where(
        and(
          eq(thumbstopperJobs.ownerId, ownerId),
          eq(thumbstopperJobs.reuseHash, reuseHash),
          notInArray(thumbstopperJobs.state, NOT_LIVE),
        ),
      );
    const outcome = await withIdempotency(
      tx,
      scope,
      {
        resourceType: 'thumbstopper_job',
        responseStatus: 202,
        ttlHours: this.config.idempotencyTtlHours,
        resourceId: reusable?.id,
      },
      async (id) => {
        if (reusable !== undefined) return { id: reusable.id, reused: true };
        await this.create(tx, { ownerId, campaignId, calloutText, model, reuseHash }, id);
        return { id, reused: false };
      },
    );
    const id = outcome.replayed ? outcome.resourceId : outcome.result.id;
    return {
      job: await this.byId(tx, ownerId, id),
      reused: outcome.replayed || outcome.result.reused,
    };
  }

  /** The owner's active campaign; a foreign, deleting or missing one is `not_found`. Locked for a write so deletion queues behind it. */
  private async assertCampaign(
    tx: DbTx,
    ownerId: string,
    campaignId: string,
    lock: boolean,
  ): Promise<void> {
    const query = tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.id, campaignId),
          eq(campaigns.ownerId, ownerId),
          eq(campaigns.state, 'active'),
        ),
      );
    const [campaign] = lock ? await query.for('share') : await query;
    if (campaign === undefined) throw notFound('campaign');
  }

  /** SB-D14 after the reuse lookup: lock, OpenAI key check (REQ-019), cap check with the reservation, the job, the queue message. */
  private async create(
    tx: DbTx,
    plan: {
      ownerId: string;
      campaignId: string;
      calloutText: string;
      model: string;
      reuseHash: string;
    },
    id: string,
  ): Promise<void> {
    await lockXact(tx, 'spend', plan.ownerId);
    const key = await this.openAiKey(tx, plan.ownerId);
    await this.usage.reserve(tx, {
      ownerId: plan.ownerId,
      jobType: 'thumbstopper',
      jobId: id,
      calls: [{ provider: 'openai', operation: plan.model }],
    });
    await tx.insert(thumbstopperJobs).values({
      id,
      ownerId: plan.ownerId,
      campaignId: plan.campaignId,
      calloutText: plan.calloutText,
      providerModel: plan.model,
      reuseHash: plan.reuseHash,
      keyId: key.id,
      keyVersion: key.version,
      deadlineAt: sql`now() + make_interval(mins => ${this.config.deadlineMinutes})`,
    });
    await enqueue(this.boss, tx, THUMB_SUBMIT_QUEUE, { jobId: id }, { singletonKey: id });
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

  private async byId(tx: DbTx, ownerId: string, id: string): Promise<ThumbRecord> {
    const [job] = await tx
      .select(COLUMNS)
      .from(thumbstopperJobs)
      .where(and(eq(thumbstopperJobs.id, id), eq(thumbstopperJobs.ownerId, ownerId)));
    if (job === undefined)
      throw new DomainError('not_found', 'This request no longer has a result.');
    return job;
  }
}
