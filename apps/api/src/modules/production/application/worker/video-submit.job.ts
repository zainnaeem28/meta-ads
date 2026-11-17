import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../../platform/db/index.js';
import type { Database, DbTx } from '../../../../platform/db/index.js';
import { jobTable } from '../../../../platform/jobs/claim.js';
import { submitOnce } from '../../../../platform/jobs/at-most-once.js';
import type { SubmitResult } from '../../../../platform/jobs/at-most-once.js';
import { BOSS } from '../../../../platform/jobs/boss.js';
import { enqueue } from '../../../../platform/jobs/enqueue.js';
import { schedulePoll } from '../../../../platform/jobs/poll.js';
import { UsageService } from '../../../usage/index.js';
import type { BillableCall } from '../../../usage/index.js';
import { KeySession, gateKey } from './key-session.js';
import {
  PRODUCTION_MEDIA,
  ProviderCallFailed,
  VIDEO_GEN_PORT,
  VIDEO_WORKER_CONFIG,
  VIDEO_WORKER_REPOSITORY,
} from './ports.js';
import type {
  JobLog,
  ProductionMedia,
  VideoCause,
  VideoGenPort,
  VideoJobRow,
  VideoWorkerConfig,
  VideoWorkerRepository,
} from './ports.js';

export const VIDEO_SUBMIT_QUEUE = 'production.video-submit';
export const VIDEO_TABLE = jobTable('video_jobs');
/** A job held back by the running limit tries again after this long (ARCHITECTURE §5.5, shown "queued"). */
export const HELD_RETRY_SEC = 10;
const UNREADABLE_KEY = 'Your WaveSpeed key could not be read. Enter it again.';

export type VideoSubmitOutcome = 'submitted' | 'rejected' | 'outcome_unknown' | 'late_task_id' | 'held' | 'skipped' | 'failed_before_call';

/** What the call closure learns, for the usage and key bookkeeping after `submitOnce` settles the row. */
interface CallFacts {
  /** The request never left the process: no usage event. */
  sent: boolean;
  /** The provider said the key was not accepted (counts toward disabling it). */
  authFailure: boolean;
  latencyMs: number;
  message?: string;
}

const cleanCause = (cause: string): 'temporary' | 'configuration' | 'credit' =>
  cause === 'configuration' || cause === 'credit' ? cause : 'temporary';

/**
 * `production.video-submit` (ARCHITECTURE §5.5): the claim guards, then at most one WaveSpeed submit. `submitting` is
 * committed before the key is opened or the provider called; the answer settles the row, the usage event and the first
 * poll together. A crash between the call and the answer leaves `submitting` with no task id, which the recovery sweep
 * settles as `outcome_unknown`; the submit is never repeated (no provider idempotency key exists).
 */
@Injectable()
export class VideoSubmitJob {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(VIDEO_WORKER_REPOSITORY) private readonly repository: VideoWorkerRepository,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(KeySession) private readonly keys: KeySession,
    @Inject(VIDEO_GEN_PORT) private readonly video: VideoGenPort,
    @Inject(PRODUCTION_MEDIA) private readonly media: ProductionMedia,
    @Inject(BOSS) private readonly boss: Parameters<typeof enqueue>[0],
    @Inject(VIDEO_WORKER_CONFIG) private readonly config: VideoWorkerConfig,
  ) {}

  /** The queue handler: the job ID is the whole payload. */
  async handle(job: { id: string; data: unknown }, log: JobLog): Promise<VideoSubmitOutcome> {
    const jobId = (job.data as { jobId?: unknown } | null)?.jobId;
    if (typeof jobId !== 'string') throw new TypeError('production.video-submit job has no jobId');
    const outcome = await this.run(jobId, log);
    log.info({ module: 'production', outcome: outcome === 'rejected' || outcome === 'outcome_unknown' ? 'error' : 'ok', jobId }, `video submit: ${outcome}`);
    return outcome;
  }

  async run(jobId: string, log: JobLog): Promise<VideoSubmitOutcome> {
    const plan = await this.plan(jobId, log);
    if (plan.kind === 'done') return plan.outcome;
    const { job, input } = plan;
    const call: BillableCall = { provider: 'wavespeed', operation: job.providerModel };
    const base = { ownerId: job.ownerId, call, jobType: 'video' as const, jobId, callSeq: 1 };
    const facts: CallFacts = { sent: false, authFailure: false, latencyMs: 0 };

    const outcome = await submitOnce({
      uow: this.database.uow,
      table: VIDEO_TABLE,
      jobId,
      limit: this.config.runningJobsPerUser,
      call: () => this.submit(job, plan.key, input, facts, log),
      afterAccepted: async (tx: DbTx, taskId: string) => {
        await this.usage.record(tx, { ...base, outcome: 'succeeded', latencyMs: facts.latencyMs });
        await schedulePoll(this.boss, tx, VIDEO_TABLE, jobId, this.config.pollIntervalSec);
        log.info({ module: 'production', outcome: 'ok', jobId, taskId }, 'video submitted');
      },
    });

    switch (outcome.kind) {
      case 'held':
        await this.database.uow.run((tx) => enqueue(this.boss, tx, VIDEO_SUBMIT_QUEUE, { jobId }, { startAfter: HELD_RETRY_SEC }));
        return 'held';
      case 'skipped':
        return 'skipped';
      case 'submitted':
        await this.keys.report(plan.key, true, log);
        return 'submitted';
      case 'late_task_id':
        // The sweep or a cancel settled the row while the call was in flight: the usage event it wrote stands.
        await this.database.uow.run((tx) => this.usage.record(tx, { ...base, outcome: 'succeeded', latencyMs: facts.latencyMs }));
        return 'late_task_id';
      case 'rejected':
        await this.database.uow.run(async (tx) => {
          if (facts.sent) await this.usage.record(tx, { ...base, outcome: 'rejected', latencyMs: facts.latencyMs });
          await this.usage.release(tx, { ownerId: job.ownerId, jobType: 'video', jobId });
          await this.repository.setErrorCode(tx, jobId, outcome.cause);
        });
        if (facts.authFailure) await this.keys.report(plan.key, false, log);
        return 'rejected';
      case 'outcome_unknown':
        await this.database.uow.run(async (tx) => {
          await this.usage.convertUnconfirmed(tx, base);
          await this.usage.release(tx, { ownerId: job.ownerId, jobType: 'video', jobId });
          await this.repository.setErrorCode(tx, jobId, 'outcome_unknown');
        });
        log.warn({ module: 'production', outcome: 'error', jobId }, 'video submit outcome unknown');
        return 'outcome_unknown';
    }
  }

  /** Everything read before the claim: the job, the key gate, the segment text and the reference image URL. */
  private async plan(
    jobId: string,
    log: JobLog,
  ): Promise<
    | { kind: 'done'; outcome: VideoSubmitOutcome }
    | { kind: 'go'; job: VideoJobRow; key: NonNullable<Awaited<ReturnType<KeySession['keyOf']>>>; input: Parameters<VideoGenPort['submit']>[1] }
  > {
    const read = await this.database.uow.run(async (tx) => {
      const job = await this.repository.findJob(tx, jobId);
      if (job === null || job.state !== 'pending') return { job: null } as const;
      const key = job.keyId === null ? null : await this.repository.findKey(tx, job.keyId);
      const text = await this.repository.findSegmentText(tx, job.segmentId);
      return { job, key, text } as const;
    });
    if (read.job === null) return { kind: 'done', outcome: 'skipped' };
    const { job, key, text } = read;
    const gate = gateKey(job, key);
    if (!gate.ok) return { kind: 'done', outcome: await this.failBeforeCall(job, gate.cause, gate.message, log) };
    if (text === null) return { kind: 'done', outcome: await this.failBeforeCall(job, 'temporary', 'The segment of this clip no longer exists.', log) };
    let imageUrl: string | null = null;
    if (job.referenceMediaId !== null) {
      try {
        imageUrl = await this.media.referenceUrl(job.ownerId, job.referenceMediaId);
      } catch {
        return { kind: 'done', outcome: await this.failBeforeCall(job, 'reference_unreachable', 'The reference image could not be shared with the provider. Try again.', log) };
      }
    }
    const input = {
      model: job.providerModel,
      // The scene and what is said in it; the provider speaks the quoted words (VERIFY against the model's prompt guide).
      prompt: text.dialogue === '' ? text.prompt : `${text.prompt}\n\nThe speaker says: "${text.dialogue}"`,
      imageUrl,
      durationSeconds: job.options.durationSeconds,
      resolution: job.options.resolution,
      aspectRatio: job.options.aspectRatio,
    };
    return { kind: 'go', job, key: gate.key, input };
  }

  /** `pending` to `failed` with no call: the reservation is released and no usage event is written. */
  private async failBeforeCall(job: VideoJobRow, cause: VideoCause, message: string, log: JobLog): Promise<VideoSubmitOutcome> {
    const failed = await this.database.uow.run(async (tx) => {
      const moved = await this.repository.failPending(tx, job.id, cause, message);
      if (moved) await this.usage.release(tx, { ownerId: job.ownerId, jobType: 'video', jobId: job.id });
      return moved;
    });
    log.info({ module: 'production', outcome: 'error', jobId: job.id, cause }, 'video job failed before any call');
    return failed ? 'failed_before_call' : 'skipped';
  }

  /** The one provider call: counted on the job, then made with the key opened by ID and zeroed after. */
  private async submit(
    job: VideoJobRow,
    key: NonNullable<Awaited<ReturnType<KeySession['keyOf']>>>,
    input: Parameters<VideoGenPort['submit']>[1],
    facts: CallFacts,
    log: JobLog,
  ): Promise<SubmitResult> {
    const started = await this.database.uow.run((tx) => this.repository.startCall(tx, job.id));
    if (!started) return { kind: 'unknown' };
    const began = Date.now();
    const result = await this.keys.with<SubmitResult>(key, log, async (credential) => {
      facts.sent = true;
      try {
        const taskId = await this.video.submit(credential, input);
        return { kind: 'accepted', taskId };
      } catch (error) {
        return this.refusal(error, facts);
      } finally {
        facts.latencyMs = Date.now() - began;
      }
    });
    if (result === 'unreadable') return { kind: 'rejected', cause: 'configuration', message: UNREADABLE_KEY };
    return result;
  }

  private refusal(error: unknown, facts: CallFacts): SubmitResult {
    if (!(error instanceof ProviderCallFailed)) {
      // Whether the provider saw the request is unknown; the estimate stays counted.
      return { kind: 'unknown' };
    }
    const c = error.classification;
    facts.authFailure = c.countsAsAuthFailure;
    if (c.usageEvent === 'unconfirmed') return { kind: 'unknown', ...(c.message === undefined ? {} : { message: c.message }) };
    // Refused before acceptance: nothing is billed (a refusal that never left the process is not counted as a call).
    facts.sent = c.usageEvent === 'rejected_zero';
    return { kind: 'rejected', cause: cleanCause(c.causeClass), ...(c.message === undefined ? {} : { message: c.message }) };
  }
}
