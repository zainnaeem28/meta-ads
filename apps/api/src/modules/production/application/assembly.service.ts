import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { assemblyClips, assemblyJobs } from '../../../database/schema/production-assembly.js';
import { briefSegments } from '../../../database/schema/brief.js';
import { campaigns } from '../../../database/schema/campaigns.js';
import { thumbstopperJobs } from '../../../database/schema/production-thumb.js';
import { qcRuns, videoJobs } from '../../../database/schema/production.js';
import { DATABASE, isUniqueViolation, lockXact } from '../../../platform/db/index.js';
import type { Database, DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { lookupRecord, withIdempotency } from '../../../platform/idempotency/index.js';
import { BOSS } from '../../../platform/jobs/boss.js';
import { enqueue } from '../../../platform/jobs/enqueue.js';

export const ASSEMBLY_RENDER_QUEUE = 'production.assembly-render';
export const ASSEMBLY_CONFIG = Symbol('ASSEMBLY_CONFIG');

/** `ASSEMBLY_RENDERS_PER_USER_PER_DAY` and the idempotency record lifetime. */
export interface AssemblyConfig {
  readonly rendersPerDay: number;
  readonly idempotencyTtlHours: number;
}

export interface AssemblyCreateInput {
  readonly clips: readonly string[];
  readonly thumbstopperJobId: string | null;
  readonly qcOverride: readonly string[];
}

export interface AssemblyRecord {
  readonly id: string;
  readonly campaignId: string;
  readonly state: string;
  readonly causeClass: string | null;
  readonly causeMessage: string | null;
  readonly thumbstopperJobId: string | null;
  readonly outputMediaId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly clips: readonly {
    position: number;
    videoJobId: string;
    outOfDate: boolean;
    qcOverrideConfirmed: boolean;
  }[];
  /** Any clip is out of date (SB-D11), derived at read. */
  readonly outOfDate: boolean;
}

export interface AssemblyOutcome {
  readonly assembly: AssemblyRecord;
  readonly reused: boolean;
}

/** SHA-256 hex of what makes two assemblies the same work: the clips in order and the opening frame (SB-D11). */
export function assemblyReuseHash(
  clips: readonly string[],
  thumbstopperJobId: string | null,
): string {
  return createHash('sha256')
    .update(JSON.stringify(['assembly', clips, thumbstopperJobId ?? '']))
    .digest('hex');
}

/** A latest QC result that needs the user's explicit confirmation before the clip is assembled (REQ-010, TD-D36). */
const NEEDS_CONFIRMATION = ['failed', 'skipped'];

const notFound = (what: string): DomainError =>
  new DomainError('not_found', `This ${what} does not exist.`);

/**
 * Production's assembly (REQ-011, NFR-11, ARCHITECTURE §2.6 and §5.7): create one from up to four completed clips (API-070)
 * and read it (API-071). Every method runs in its own transaction and is owner-scoped in the statement, so a foreign and a
 * missing ID both answer `not_found`. The render itself is the worker's.
 */
@Injectable()
export class AssemblyService {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(BOSS) private readonly boss: Parameters<typeof enqueue>[0],
    @Inject(ASSEMBLY_CONFIG) private readonly config: AssemblyConfig,
  ) {}

  /** API-070: reuse the matching assembly that is not `failed`, or count a new render against the day and queue it. */
  async create(
    ownerId: string,
    campaignId: string,
    input: AssemblyCreateInput,
    key: string,
    requestHash: Buffer,
  ): Promise<AssemblyOutcome> {
    const run = (): Promise<AssemblyOutcome> =>
      this.database.uow.run((tx) =>
        this.createIn(tx, ownerId, campaignId, input, key, requestHash),
      );
    try {
      return await run();
    } catch (error) {
      // A concurrent creator of the same work won the reuse index; the second try reuses its assembly.
      if (!isUniqueViolation(error, 'assembly_jobs_reuse_uq')) throw error;
      return run();
    }
  }

  /** API-071: one assembly with its clips, the out-of-date flag derived now. */
  async get(ownerId: string, assemblyId: string): Promise<AssemblyRecord> {
    return this.database.uow.run(async (tx) => {
      const [row] = await tx
        .select({ id: assemblyJobs.id })
        .from(assemblyJobs)
        .innerJoin(campaigns, eq(campaigns.id, assemblyJobs.campaignId))
        .where(
          and(
            eq(assemblyJobs.id, assemblyId),
            eq(assemblyJobs.ownerId, ownerId),
            eq(campaigns.state, 'active'),
          ),
        );
      if (row === undefined) throw notFound('assembly');
      return this.record(tx, ownerId, assemblyId);
    });
  }

  private async createIn(
    tx: DbTx,
    ownerId: string,
    campaignId: string,
    input: AssemblyCreateInput,
    key: string,
    requestHash: Buffer,
  ): Promise<AssemblyOutcome> {
    const [campaign] = await tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.id, campaignId),
          eq(campaigns.ownerId, ownerId),
          eq(campaigns.state, 'active'),
        ),
      )
      .for('share');
    if (campaign === undefined) throw notFound('campaign');
    const scope = { ownerId, operationId: 'API-070', key, requestHash };
    const recorded = await lookupRecord(tx, scope);
    if (recorded !== undefined) {
      if (!recorded.requestHash.equals(requestHash)) {
        throw new DomainError(
          'idempotency_key_reused',
          'This request key was already used for a different request.',
        );
      }
      return { assembly: await this.record(tx, ownerId, recorded.resourceId), reused: true };
    }
    if (input.thumbstopperJobId !== null) {
      // Own, this campaign's and completed with its image; a foreign, missing or unfinished one is `not_found`.
      const [thumb] = await tx
        .select({ id: thumbstopperJobs.id })
        .from(thumbstopperJobs)
        .where(
          and(
            eq(thumbstopperJobs.id, input.thumbstopperJobId),
            eq(thumbstopperJobs.ownerId, ownerId),
            eq(thumbstopperJobs.campaignId, campaignId),
            eq(thumbstopperJobs.state, 'completed'),
            sql`${thumbstopperJobs.outputMediaId} is not null`,
          ),
        );
      if (thumb === undefined) throw notFound('thumbstopper');
    }
    await lockXact(tx, 'render-day', ownerId);
    const confirmed = await this.checkClips(tx, ownerId, campaignId, input);
    const reuseHash = assemblyReuseHash(input.clips, input.thumbstopperJobId);
    const [reusable] = await tx
      .select({ id: assemblyJobs.id })
      .from(assemblyJobs)
      .where(
        and(
          eq(assemblyJobs.campaignId, campaignId),
          eq(assemblyJobs.reuseHash, reuseHash),
          ne(assemblyJobs.state, 'failed'),
        ),
      );
    if (reusable === undefined) await this.assertUnderDailyLimit(tx, ownerId);
    const outcome = await withIdempotency(
      tx,
      scope,
      {
        resourceType: 'assembly_job',
        responseStatus: 202,
        ttlHours: this.config.idempotencyTtlHours,
        resourceId: reusable?.id,
      },
      async (id) => {
        if (reusable !== undefined) return { id: reusable.id, reused: true };
        await tx.insert(assemblyJobs).values({
          id,
          ownerId,
          campaignId,
          reuseHash,
          thumbstopperJobId: input.thumbstopperJobId,
          renderDay: sql`(now() at time zone 'utc')::date`,
        });
        await tx.insert(assemblyClips).values(
          input.clips.map((videoJobId, index) => ({
            assemblyJobId: id,
            position: index + 1,
            videoJobId,
            qcOverrideConfirmed: confirmed.has(videoJobId),
          })),
        );
        await enqueue(this.boss, tx, ASSEMBLY_RENDER_QUEUE, { jobId: id });
        return { id, reused: false };
      },
    );
    const id = outcome.replayed ? outcome.resourceId : outcome.result.id;
    const reused = outcome.replayed || outcome.result.reused;
    return { assembly: await this.record(tx, ownerId, id), reused };
  }

  /**
   * Every clip is a completed clip of this campaign (a foreign, missing or unfinished one is `clip_not_completed`, naming
   * it), and a clip whose latest QC, read in this transaction, is `failed` or `skipped` is in `qcOverride`. Returns the
   * clips whose confirmation is recorded: only those that need it (TD-D35); `pending` and `passed` need none (TD-D36).
   */
  private async checkClips(
    tx: DbTx,
    ownerId: string,
    campaignId: string,
    input: AssemblyCreateInput,
  ): Promise<ReadonlySet<string>> {
    const done = await tx
      .select({ id: videoJobs.id })
      .from(videoJobs)
      .where(
        and(
          inArray(videoJobs.id, [...input.clips]),
          eq(videoJobs.ownerId, ownerId),
          eq(videoJobs.campaignId, campaignId),
          eq(videoJobs.state, 'completed'),
          sql`${videoJobs.outputMediaId} is not null`,
        ),
      );
    const completed = new Set(done.map((row) => row.id));
    const missing = input.clips.flatMap((id, index) => (completed.has(id) ? [] : [{ id, index }]));
    if (missing.length > 0) {
      throw new DomainError(
        'clip_not_completed',
        'Every clip must be a finished clip of this campaign before it is assembled.',
        missing.map(({ index }) => ({
          field: `clips[${String(index)}]`,
          code: 'clip_not_completed',
          message: 'This clip is not a completed clip of this campaign.',
        })),
      );
    }
    const latest = await tx
      .selectDistinctOn([qcRuns.videoJobId], {
        videoJobId: qcRuns.videoJobId,
        qcState: qcRuns.qcState,
      })
      .from(qcRuns)
      .where(inArray(qcRuns.videoJobId, [...input.clips]))
      .orderBy(qcRuns.videoJobId, desc(qcRuns.createdAt), desc(qcRuns.id));
    const flagged = new Set(
      latest.filter((run) => NEEDS_CONFIRMATION.includes(run.qcState)).map((run) => run.videoJobId),
    );
    const override = new Set(input.qcOverride);
    const unconfirmed = input.clips.flatMap((id, index) =>
      flagged.has(id) && !override.has(id) ? [{ id, index }] : [],
    );
    if (unconfirmed.length > 0) {
      throw new DomainError(
        'qc_confirmation_required',
        'Confirm the clips whose audio check failed or was skipped before they are assembled.',
        unconfirmed.map(({ index }) => ({
          field: `clips[${String(index)}]`,
          code: 'qc_confirmation_required',
          message: 'The latest audio check of this clip failed or was skipped.',
        })),
      );
    }
    return new Set(input.clips.filter((id) => flagged.has(id) && override.has(id)));
  }

  /** Only a new row counts toward the day (UTC, NFR-11); the `render-day:` lock makes the count and the insert one step. */
  private async assertUnderDailyLimit(tx: DbTx, ownerId: string): Promise<void> {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(assemblyJobs)
      .where(
        and(
          eq(assemblyJobs.ownerId, ownerId),
          sql`${assemblyJobs.renderDay} = (now() at time zone 'utc')::date`,
        ),
      );
    if ((row?.count ?? 0) >= this.config.rendersPerDay) {
      throw new DomainError(
        'assembly_daily_limit',
        `You've reached today's limit of ${String(this.config.rendersPerDay)} renders. It resets at 00:00 UTC.`,
      );
    }
  }

  /** One assembly with its clips; each clip is out of date when its segment moved on or a newer clip of it completed. */
  private async record(tx: DbTx, ownerId: string, id: string): Promise<AssemblyRecord> {
    const [job] = await tx
      .select()
      .from(assemblyJobs)
      .where(and(eq(assemblyJobs.id, id), eq(assemblyJobs.ownerId, ownerId)));
    if (job === undefined)
      throw new DomainError('not_found', 'This request no longer has a result.');
    const clips = await tx
      .select({
        position: assemblyClips.position,
        videoJobId: assemblyClips.videoJobId,
        qcOverrideConfirmed: assemblyClips.qcOverrideConfirmed,
        segmentRevision: videoJobs.segmentRevision,
        currentRevision: briefSegments.revision,
        newerCompleted: sql<boolean>`exists (
          select 1 from video_jobs newer
          where newer.segment_id = ${videoJobs.segmentId} and newer.state = 'completed'
            and (newer.created_at, newer.id) > (${videoJobs.createdAt}, ${videoJobs.id})
        )`,
      })
      .from(assemblyClips)
      .innerJoin(videoJobs, eq(videoJobs.id, assemblyClips.videoJobId))
      .innerJoin(briefSegments, eq(briefSegments.id, videoJobs.segmentId))
      .where(eq(assemblyClips.assemblyJobId, id))
      .orderBy(asc(assemblyClips.position));
    const view = clips.map((clip) => ({
      position: clip.position,
      videoJobId: clip.videoJobId,
      qcOverrideConfirmed: clip.qcOverrideConfirmed,
      outOfDate: clip.segmentRevision < clip.currentRevision || clip.newerCompleted,
    }));
    return {
      id: job.id,
      campaignId: job.campaignId,
      state: job.state,
      causeClass: job.causeClass,
      causeMessage: job.causeMessage,
      thumbstopperJobId: job.thumbstopperJobId,
      outputMediaId: job.outputMediaId,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      clips: view,
      outOfDate: view.some((clip) => clip.outOfDate),
    };
  }
}
