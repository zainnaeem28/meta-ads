import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { briefSegments, briefs } from '../../../database/schema/brief.js';
import { campaigns } from '../../../database/schema/campaigns.js';
import { mediaObjects } from '../../../database/schema/media.js';
import { providerKeys } from '../../../database/schema/provider-keys.js';
import { qcRuns, videoJobs } from '../../../database/schema/production.js';
import { DATABASE, isUniqueViolation, lockXact } from '../../../platform/db/index.js';
import type { Database, DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { lookupRecord, withIdempotency } from '../../../platform/idempotency/index.js';
import { BOSS } from '../../../platform/jobs/boss.js';
import { enqueue } from '../../../platform/jobs/enqueue.js';
import { UsageService } from '../../usage/index.js';
import { isRetryable, videoReuseHash } from '../domain/video-job.js';
import type { VideoOptions } from '../domain/video-job.js';
import { VIDEO_CONFIG } from './video-ports.js';
import type {
  CancelCause,
  JobRecord,
  JobStats,
  JobStatsWindow,
  QcRecord,
  SegmentJobsEntry,
  VideoConfig,
  VideoJobOutcome,
  VideoJobRecord,
} from './video-ports.js';

export const VIDEO_SUBMIT_QUEUE = 'production.video-submit';
const QC_HISTORY_LIMIT = 20;
const NOT_LIVE = ['failed', 'cancelled'];
const NON_TERMINAL = ['pending', 'submitting', 'submitted', 'processing'];

const notFound = (what: string): DomainError =>
  new DomainError('not_found', `This ${what} does not exist.`);

/** What the job-creating rule (SB-D14) needs to make, find or replay one clip. */
interface Plan {
  readonly ownerId: string;
  readonly operationId: 'API-060' | 'API-063';
  readonly key: string;
  readonly requestHash: Buffer;
  readonly campaignId: string;
  readonly segmentId: string;
  readonly segmentRevision: number;
  readonly referenceMediaId: string | null;
  readonly providerModel: string;
  readonly options: VideoOptions;
  readonly reuseHash: string;
}

interface SegmentRow {
  readonly id: string;
  readonly position: number;
  readonly state: string;
  readonly revision: number;
  readonly prompt: string;
  readonly dialogue: string;
  readonly briefState: string;
  readonly productMediaId: string | null;
}

const JOB_COLUMNS = {
  id: videoJobs.id,
  state: videoJobs.state,
  causeClass: videoJobs.causeClass,
  causeMessage: videoJobs.causeMessage,
  createdAt: videoJobs.createdAt,
  updatedAt: videoJobs.updatedAt,
  deadlineAt: videoJobs.deadlineAt,
  campaignId: videoJobs.campaignId,
  segmentId: videoJobs.segmentId,
  segmentRevision: videoJobs.segmentRevision,
  outputMediaId: videoJobs.outputMediaId,
  segmentPosition: briefSegments.position,
  currentRevision: briefSegments.revision,
};

/**
 * Production's video jobs (REQ-009, ARCHITECTURE §5.5): generate a clip for a segment of an accepted brief (API-060), read
 * the clips and their QC (API-061, API-062) and retry a failed one (API-063). Every method runs in its own transaction
 * and is owner-scoped in the statement, so a foreign and a missing ID both answer `not_found`. The brief and its segments
 * are read through the shared schema and never written (SB-D11).
 */
@Injectable()
export class VideoJobsService {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(BOSS) private readonly boss: Parameters<typeof enqueue>[0],
    @Inject(VIDEO_CONFIG) private readonly config: VideoConfig,
  ) {}

  /** API-060: reuse the live clip of the same work, or create one (SB-D14) and queue it. */
  async generateSegment(
    ownerId: string,
    campaignId: string,
    position: number,
    useProductImage: boolean,
    key: string,
    requestHash: Buffer,
  ): Promise<VideoJobOutcome> {
    return this.inTransaction(async (tx) => {
      const segment = await this.lockedSegment(tx, ownerId, campaignId, position);
      const base = { ownerId, operationId: 'API-060', key, requestHash } as const;
      const replay = await this.replayIfRecorded(tx, base);
      if (replay !== undefined) return replay;
      this.assertProducible(segment);
      const reference = useProductImage
        ? await this.readyReference(tx, ownerId, segment.productMediaId)
        : null;
      return this.createOrReuse(tx, this.plan(base, campaignId, segment, reference));
    });
  }

  /** API-063: a failed or cancelled clip is made again as a new row, from the segment's current text. */
  async retry(
    ownerId: string,
    videoJobId: string,
    key: string,
    requestHash: Buffer,
  ): Promise<VideoJobOutcome> {
    return this.inTransaction(async (tx) => {
      const [original] = await tx
        .select({
          campaignId: videoJobs.campaignId,
          segmentId: videoJobs.segmentId,
          state: videoJobs.state,
          referenceMediaId: videoJobs.referenceMediaId,
          position: briefSegments.position,
        })
        .from(videoJobs)
        .innerJoin(briefSegments, eq(briefSegments.id, videoJobs.segmentId))
        .innerJoin(campaigns, eq(campaigns.id, videoJobs.campaignId))
        .where(
          and(
            eq(videoJobs.id, videoJobId),
            eq(videoJobs.ownerId, ownerId),
            eq(campaigns.state, 'active'),
          ),
        );
      if (original === undefined) throw notFound('video job');
      const segment = await this.lockedSegment(tx, ownerId, original.campaignId, original.position);
      const base = { ownerId, operationId: 'API-063', key, requestHash } as const;
      const replay = await this.replayIfRecorded(tx, base);
      if (replay !== undefined) return replay;
      if (!isRetryable(original.state)) {
        throw new DomainError(
          'state_conflict',
          'Only a clip that failed or was cancelled can be tried again.',
        );
      }
      this.assertProducible(segment);
      // The reference is kept when its image still exists and is ready; the deletion of an image clears the column.
      const reference = await this.readyReference(tx, ownerId, original.referenceMediaId);
      return this.createOrReuse(tx, this.plan(base, original.campaignId, segment, reference));
    });
  }

  /** API-062: one clip with its QC history. */
  async get(ownerId: string, videoJobId: string): Promise<VideoJobRecord> {
    return this.database.uow.run(async (tx) => {
      const rows = await tx
        .select(JOB_COLUMNS)
        .from(videoJobs)
        .innerJoin(briefSegments, eq(briefSegments.id, videoJobs.segmentId))
        .innerJoin(campaigns, eq(campaigns.id, videoJobs.campaignId))
        .where(
          and(
            eq(videoJobs.id, videoJobId),
            eq(videoJobs.ownerId, ownerId),
            eq(campaigns.state, 'active'),
          ),
        );
      const [job] = await this.withQc(tx, rows);
      if (job === undefined) throw notFound('video job');
      return job;
    });
  }

  /** API-061: one entry per segment position with its latest clip, whose QC and out-of-date flag are derived now. */
  async listForCampaign(ownerId: string, campaignId: string): Promise<SegmentJobsEntry[]> {
    return this.database.uow.run(async (tx) => {
      const segments = await tx
        .select({
          id: briefSegments.id,
          position: briefSegments.position,
          state: briefSegments.state,
          revision: briefSegments.revision,
        })
        .from(campaigns)
        .innerJoin(briefs, eq(briefs.campaignId, campaigns.id))
        .innerJoin(briefSegments, eq(briefSegments.briefId, briefs.id))
        .where(
          and(
            eq(campaigns.id, campaignId),
            eq(campaigns.ownerId, ownerId),
            eq(campaigns.state, 'active'),
          ),
        )
        .orderBy(asc(briefSegments.position));
      if (segments.length === 0) {
        const [owned] = await tx
          .select({ id: campaigns.id })
          .from(campaigns)
          .where(
            and(
              eq(campaigns.id, campaignId),
              eq(campaigns.ownerId, ownerId),
              eq(campaigns.state, 'active'),
            ),
          );
        if (owned === undefined) throw notFound('campaign');
        return [];
      }
      const latest = await tx
        .selectDistinctOn([videoJobs.segmentId], JOB_COLUMNS)
        .from(videoJobs)
        .innerJoin(briefSegments, eq(briefSegments.id, videoJobs.segmentId))
        .where(and(eq(videoJobs.campaignId, campaignId), eq(videoJobs.ownerId, ownerId)))
        .orderBy(videoJobs.segmentId, desc(videoJobs.createdAt), desc(videoJobs.id));
      const jobs = await this.withQc(tx, latest);
      return segments.map((segment) => ({
        position: segment.position,
        segmentState: segment.state as 'active' | 'retired',
        segmentRevision: segment.revision,
        latestJob: jobs.find((job) => job.segmentId === segment.id) ?? null,
      }));
    });
  }

  /** Jobs in flight on the owner's key of a provider: clips for WaveSpeed, QC runs for OpenAI (SB §4.2). */
  async inFlightForKey(ownerId: string, provider: 'openai' | 'wavespeed'): Promise<number> {
    return this.database.uow.run(async (tx) => {
      const table = provider === 'wavespeed' ? videoJobs : qcRuns;
      const [row] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(table)
        .where(and(eq(table.ownerId, ownerId), inArray(table.state, NON_TERMINAL)));
      return row?.count ?? 0;
    });
  }

  /** Campaign deletion step 1 (SB-D17), in the caller's transaction: every unfinished clip and QC run becomes `cancelled`. */
  async cancelForCampaign(tx: DbTx, ownerId: string, campaignId: string): Promise<number> {
    return this.cancel(
      tx,
      ownerId,
      'cancelled_campaign_deleted',
      eq(videoJobs.campaignId, campaignId),
    );
  }

  /** Account suspension or removal (SB-D16), in the caller's transaction. */
  async cancelForOwner(
    tx: DbTx,
    ownerId: string,
    cause: Exclude<CancelCause, 'cancelled_campaign_deleted'>,
  ): Promise<number> {
    return this.cancel(tx, ownerId, cause, undefined);
  }

  /** Counts of the clips and QC runs created or ended since `since`, for the internal metrics window (API-903). */
  async jobStats(since: Date): Promise<JobStats> {
    return this.database.uow.run(async (tx) => {
      const [video] = await tx
        .select({
          created: sql<number>`count(*) filter (where ${videoJobs.createdAt} >= ${since.toISOString()}::timestamptz)::int`,
          completed: sql<number>`count(*) filter (where ${videoJobs.state} = 'completed')::int`,
          failed: sql<number>`count(*) filter (where ${videoJobs.state} = 'failed')::int`,
          cancelled: sql<number>`count(*) filter (where ${videoJobs.state} = 'cancelled')::int`,
        })
        .from(videoJobs)
        .where(sql`${videoJobs.updatedAt} >= ${since.toISOString()}::timestamptz`);
      const [qc] = await tx
        .select({ created: sql<number>`count(*)::int` })
        .from(qcRuns)
        .where(sql`${qcRuns.createdAt} >= ${since.toISOString()}::timestamptz`);
      return {
        windowStart: since.toISOString(),
        videoCreated: video?.created ?? 0,
        videoCompleted: video?.completed ?? 0,
        videoFailed: video?.failed ?? 0,
        videoCancelled: video?.cancelled ?? 0,
        qcCreated: qc?.created ?? 0,
      };
    });
  }

  /**
   * Counts of clips and QC runs in the half-open window [from, to), each counter by its own event time: created by
   * `created_at`, completed/failed/cancelled by the row's last change (`updated_at`, when it entered the terminal state).
   * `ownerId` scopes every counter to one tenant; without it the counts are platform-wide, like `jobStats`.
   */
  async jobStatsWindow(from: Date, to: Date, ownerId?: string): Promise<JobStatsWindow> {
    const f = from.toISOString();
    const t = to.toISOString();
    return this.database.uow.run(async (tx) => {
      const videoOwner = ownerId === undefined ? sql`true` : sql`${videoJobs.ownerId} = ${ownerId}`;
      const qcOwner = ownerId === undefined ? sql`true` : sql`${qcRuns.ownerId} = ${ownerId}`;
      const inWindow = (column: unknown) =>
        sql`${column} >= ${f}::timestamptz and ${column} < ${t}::timestamptz`;
      const [video] = await tx
        .select({
          created: sql<number>`count(*) filter (where ${inWindow(videoJobs.createdAt)})::int`,
          completed: sql<number>`count(*) filter (where ${videoJobs.state} = 'completed' and ${inWindow(videoJobs.updatedAt)})::int`,
          failed: sql<number>`count(*) filter (where ${videoJobs.state} = 'failed' and ${inWindow(videoJobs.updatedAt)})::int`,
          cancelled: sql<number>`count(*) filter (where ${videoJobs.state} = 'cancelled' and ${inWindow(videoJobs.updatedAt)})::int`,
        })
        .from(videoJobs)
        .where(videoOwner);
      const [qc] = await tx
        .select({
          created: sql<number>`count(*) filter (where ${inWindow(qcRuns.createdAt)})::int`,
        })
        .from(qcRuns)
        .where(qcOwner);
      return {
        windowStart: f,
        windowEnd: t,
        videoCreated: video?.created ?? 0,
        videoCompleted: video?.completed ?? 0,
        videoFailed: video?.failed ?? 0,
        videoCancelled: video?.cancelled ?? 0,
        qcCreated: qc?.created ?? 0,
      };
    });
  }

  /** One transaction, run once more when a concurrent creator won the reuse index (the retry then reuses its job). */
  private async inTransaction<T>(body: (tx: DbTx) => Promise<T>): Promise<T> {
    try {
      return await this.database.uow.run(body);
    } catch (error) {
      if (!isUniqueViolation(error, 'video_jobs_reuse_uq')) throw error;
      return this.database.uow.run(body);
    }
  }

  /**
   * The owner's active campaign, its brief row locked (so an edit cannot move the segment under this request) and the
   * segment at `position`. A foreign, deleting or missing campaign and a position with no segment are `not_found`.
   */
  private async lockedSegment(
    tx: DbTx,
    ownerId: string,
    campaignId: string,
    position: number,
  ): Promise<SegmentRow> {
    const [brief] = await tx
      .select({ id: briefs.id, state: briefs.state, productMediaId: campaigns.productMediaId })
      .from(briefs)
      .innerJoin(campaigns, eq(campaigns.id, briefs.campaignId))
      .where(
        and(
          eq(briefs.campaignId, campaignId),
          eq(briefs.ownerId, ownerId),
          eq(campaigns.state, 'active'),
        ),
      )
      .for('update', { of: briefs });
    if (brief === undefined) throw notFound('campaign');
    const [segment] = await tx
      .select()
      .from(briefSegments)
      .where(and(eq(briefSegments.briefId, brief.id), eq(briefSegments.position, position)));
    if (segment === undefined) throw notFound('segment');
    return {
      id: segment.id,
      position: segment.position,
      state: segment.state,
      revision: segment.revision,
      prompt: segment.prompt,
      dialogue: segment.dialogue,
      briefState: brief.state,
      productMediaId: brief.productMediaId,
    };
  }

  /** Only reviewed copy reaches production (SB-D11): the brief is `accepted` and the segment is not retired. */
  private assertProducible(segment: SegmentRow): void {
    if (segment.briefState !== 'accepted') {
      throw new DomainError('brief_not_accepted', 'Accept the brief before you generate clips.');
    }
    if (segment.state !== 'active') {
      throw new DomainError('brief_not_accepted', 'This segment is no longer part of the brief.');
    }
  }

  /** The owner's product image when it is `ready`; a missing or unfinished one means a clip without a reference. */
  private async readyReference(
    tx: DbTx,
    ownerId: string,
    mediaId: string | null,
  ): Promise<string | null> {
    if (mediaId === null) return null;
    const [media] = await tx
      .select({ id: mediaObjects.id })
      .from(mediaObjects)
      .where(
        and(
          eq(mediaObjects.id, mediaId),
          eq(mediaObjects.ownerId, ownerId),
          eq(mediaObjects.state, 'ready'),
        ),
      );
    return media?.id ?? null;
  }

  private plan(
    base: Pick<Plan, 'ownerId' | 'operationId' | 'key' | 'requestHash'>,
    campaignId: string,
    segment: SegmentRow,
    referenceMediaId: string | null,
  ): Plan {
    const options: VideoOptions = {
      durationSeconds: this.config.durationSeconds,
      resolution: this.config.resolution,
      aspectRatio: this.config.aspectRatio,
    };
    return {
      ...base,
      campaignId,
      segmentId: segment.id,
      segmentRevision: segment.revision,
      referenceMediaId,
      providerModel: referenceMediaId === null ? this.config.modelT2v : this.config.modelI2v,
      options,
      reuseHash: videoReuseHash({
        segmentId: segment.id,
        prompt: segment.prompt,
        dialogue: segment.dialogue,
        referenceMediaId,
        options,
      }),
    };
  }

  /** A request whose key is already recorded replays its job, before any state is looked at (409 for another request). */
  private async replayIfRecorded(
    tx: DbTx,
    scope: Pick<Plan, 'ownerId' | 'operationId' | 'key' | 'requestHash'>,
  ): Promise<VideoJobOutcome | undefined> {
    const record = await lookupRecord(tx, scope);
    if (record === undefined) return undefined;
    if (!record.requestHash.equals(scope.requestHash)) {
      throw new DomainError(
        'idempotency_key_reused',
        'This request key was already used for a different request.',
      );
    }
    return { job: await this.jobById(tx, scope.ownerId, record.resourceId), reused: true };
  }

  /** One clip per `(owner, operation, key)` and one live clip per piece of work; neither writes a second job or reservation. */
  private async createOrReuse(tx: DbTx, plan: Plan): Promise<VideoJobOutcome> {
    const [reusable] = await tx
      .select({ id: videoJobs.id })
      .from(videoJobs)
      .where(
        and(
          eq(videoJobs.ownerId, plan.ownerId),
          eq(videoJobs.reuseHash, plan.reuseHash),
          notInArray(videoJobs.state, NOT_LIVE),
        ),
      );
    const outcome = await withIdempotency(
      tx,
      {
        ownerId: plan.ownerId,
        operationId: plan.operationId,
        key: plan.key,
        requestHash: plan.requestHash,
      },
      {
        resourceType: 'video_job',
        responseStatus: 202,
        ttlHours: this.config.idempotencyTtlHours,
        resourceId: reusable?.id,
      },
      async (id) => {
        if (reusable !== undefined) return { id: reusable.id, reused: true };
        await this.create(tx, plan, id);
        return { id, reused: false };
      },
    );
    const id = outcome.replayed ? outcome.resourceId : outcome.result.id;
    const reused = outcome.replayed || outcome.result.reused;
    return { job: await this.jobById(tx, plan.ownerId, id), reused };
  }

  /** SB-D14 after the reuse lookup: lock, WaveSpeed key check, cap check with the reservation, the job, the queue message. */
  private async create(tx: DbTx, plan: Plan, id: string): Promise<void> {
    await lockXact(tx, 'spend', plan.ownerId);
    const key = await this.wavespeedKey(tx, plan.ownerId);
    // The clip and its first QC are reserved together, so a completed clip always gets its first check (§5.5).
    await this.usage.reserve(tx, {
      ownerId: plan.ownerId,
      jobType: 'video',
      jobId: id,
      calls: [
        { provider: 'wavespeed', operation: plan.providerModel },
        { provider: 'openai', operation: this.config.transcribeModel },
      ],
    });
    await tx.insert(videoJobs).values({
      id,
      ownerId: plan.ownerId,
      campaignId: plan.campaignId,
      segmentId: plan.segmentId,
      segmentRevision: plan.segmentRevision,
      referenceMediaId: plan.referenceMediaId,
      providerModel: plan.providerModel,
      options: plan.options,
      reuseHash: plan.reuseHash,
      keyId: key.id,
      keyVersion: key.version,
      deadlineAt: sql`now() + make_interval(mins => ${this.config.deadlineMinutes})`,
    });
    await enqueue(this.boss, tx, VIDEO_SUBMIT_QUEUE, { jobId: id });
  }

  /** The key check of REQ-019: no key, or a disabled one, is refused with the name of the missing setting. */
  private async wavespeedKey(tx: DbTx, ownerId: string): Promise<{ id: string; version: number }> {
    const [key] = await tx
      .select({ id: providerKeys.id, status: providerKeys.status, version: providerKeys.version })
      .from(providerKeys)
      .where(and(eq(providerKeys.ownerId, ownerId), eq(providerKeys.provider, 'wavespeed')));
    if (key === undefined) {
      throw new DomainError('key_missing', 'Add your WaveSpeed key in Settings, then try again.', [
        {
          field: 'wavespeedKey',
          code: 'missing',
          message: 'No WaveSpeed key is stored for your account.',
        },
      ]);
    }
    if (key.status === 'disabled') {
      throw new DomainError(
        'key_disabled',
        'Your WaveSpeed key is disabled. Enter it again in Settings, then try again.',
        [
          {
            field: 'wavespeedKey',
            code: 'disabled',
            message: 'Your WaveSpeed key was disabled after repeated authentication failures.',
          },
        ],
      );
    }
    return key;
  }

  private async jobById(tx: DbTx, ownerId: string, id: string): Promise<VideoJobRecord> {
    const rows = await tx
      .select(JOB_COLUMNS)
      .from(videoJobs)
      .innerJoin(briefSegments, eq(briefSegments.id, videoJobs.segmentId))
      .where(and(eq(videoJobs.id, id), eq(videoJobs.ownerId, ownerId)));
    const [job] = await this.withQc(tx, rows);
    if (job === undefined)
      throw new DomainError('not_found', 'This request no longer has a result.');
    return job;
  }

  /** Adds each clip's QC history (newest first, at most 20) and the derived position/out-of-date inputs. */
  private async withQc(
    tx: DbTx,
    rows: readonly (JobRecord & {
      campaignId: string;
      segmentId: string;
      segmentRevision: number;
      outputMediaId: string | null;
      segmentPosition: number;
      currentRevision: number;
    })[],
  ): Promise<VideoJobRecord[]> {
    if (rows.length === 0) return [];
    const runs = await tx
      .select({
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
      })
      .from(qcRuns)
      .where(
        inArray(
          qcRuns.videoJobId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(desc(qcRuns.createdAt), desc(qcRuns.id));
    return rows.map((row) => {
      const history: QcRecord[] = runs
        .filter((run) => run.videoJobId === row.id)
        .slice(0, QC_HISTORY_LIMIT);
      return { ...row, latestQc: history[0] ?? null, qcHistory: history };
    });
  }

  private async cancel(
    tx: DbTx,
    ownerId: string,
    cause: CancelCause,
    scope: ReturnType<typeof eq> | undefined,
  ): Promise<number> {
    await lockXact(tx, 'spend', ownerId);
    const live = await tx
      .select({ id: videoJobs.id, state: videoJobs.state, model: videoJobs.providerModel })
      .from(videoJobs)
      .where(and(eq(videoJobs.ownerId, ownerId), inArray(videoJobs.state, NON_TERMINAL), scope))
      .for('update');
    if (live.length > 0) {
      await tx
        .update(videoJobs)
        .set({
          state: 'cancelled',
          causeClass: cause,
          causeMessage: 'This clip was cancelled.',
          updatedAt: sql`now()`,
        })
        .where(
          inArray(
            videoJobs.id,
            live.map((job) => job.id),
          ),
        );
    }
    for (const job of live) {
      // A call that may already have been sent has an unknown outcome and keeps its estimate counted (SB-D9); whatever
      // is left of the reservation (the QC part, or all of it before the submit) is released.
      if (job.state === 'submitting') {
        await this.usage.convertUnconfirmed(tx, {
          ownerId,
          jobType: 'video',
          jobId: job.id,
          callSeq: 1,
          call: { provider: 'wavespeed', operation: job.model },
        });
      }
      await this.usage.release(tx, { ownerId, jobType: 'video', jobId: job.id });
    }
    const runs = await tx
      .update(qcRuns)
      .set({
        state: 'cancelled',
        causeClass: cause,
        causeMessage: 'This check was cancelled.',
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(qcRuns.ownerId, ownerId),
          inArray(qcRuns.state, NON_TERMINAL),
          scope === undefined
            ? undefined
            : inArray(
                qcRuns.videoJobId,
                tx.select({ id: videoJobs.id }).from(videoJobs).where(scope),
              ),
        ),
      )
      .returning({ id: qcRuns.id });
    for (const run of runs) await this.usage.release(tx, { ownerId, jobType: 'qc', jobId: run.id });
    return live.length + runs.length;
  }
}
