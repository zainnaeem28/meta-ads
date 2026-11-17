import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../../platform/db/index.js';
import type { Database, DbTx } from '../../../../platform/db/index.js';
import { classifyProviderFailure } from '../../../../platform/egress/index.js';
import type { TxScope } from '../../../../platform/jobs/at-most-once.js';
import { BOSS } from '../../../../platform/jobs/boss.js';
import type { enqueue } from '../../../../platform/jobs/enqueue.js';
import { POLL_QUEUE, runPoll } from '../../../../platform/jobs/poll.js';
import type { PollResult } from '../../../../platform/jobs/poll.js';
import { UsageService } from '../../../usage/index.js';
import { KeySession, followUpKey } from './key-session.js';
import { enqueueCopy } from './copy-queue.js';
import { VIDEO_TABLE } from './video-submit.job.js';
import { ProviderCallFailed, VIDEO_GEN_PORT, VIDEO_WORKER_CONFIG, VIDEO_WORKER_REPOSITORY } from './ports.js';
import type { JobLog, VideoGenPort, VideoWorkerConfig, VideoWorkerRepository } from './ports.js';

export { POLL_QUEUE };
export type VideoPollOutcome = 'pending' | 'completed' | 'failed' | 'timed_out' | 'skipped';

const PROVIDER = 'WaveSpeed';
/** The provider no longer knows the task (expired or deleted): the job cannot finish. */
const GONE = 'The provider no longer has this clip. Try again.';

/**
 * `production.poll` for video jobs (ARCHITECTURE §5.5): one status read per lease. The lease (`next_poll_at`) makes a
 * duplicate delivery reach the provider zero times; the deadline stops applying the moment the provider reports the clip
 * finished, and the same commit enqueues the output copy (`video.copy-output`). A failed read gives the lease back and
 * rethrows, so the queue's retry (and the recovery sweep) apply. A poll for a job that is not a video job is ignored.
 */
@Injectable()
export class VideoPollJob {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(VIDEO_WORKER_REPOSITORY) private readonly repository: VideoWorkerRepository,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(KeySession) private readonly keys: KeySession,
    @Inject(VIDEO_GEN_PORT) private readonly video: VideoGenPort,
    @Inject(BOSS) private readonly boss: Parameters<typeof enqueue>[0],
    @Inject(VIDEO_WORKER_CONFIG) private readonly config: VideoWorkerConfig,
  ) {}

  async handle(job: { id: string; data: unknown }, log: JobLog): Promise<VideoPollOutcome> {
    const jobId = (job.data as { jobId?: unknown } | null)?.jobId;
    if (typeof jobId !== 'string') throw new TypeError('production.poll job has no jobId');
    const outcome = await this.run(jobId, log);
    log.info({ module: 'production', outcome: outcome === 'failed' || outcome === 'timed_out' ? 'error' : 'ok', jobId }, `video poll: ${outcome}`);
    return outcome;
  }

  async run(jobId: string, log: JobLog): Promise<VideoPollOutcome> {
    const row = await this.database.uow.run((tx) => this.repository.findJob(tx, jobId));
    if (row === null || (row.state !== 'submitted' && row.state !== 'processing') || row.providerTaskId === null) return 'skipped';
    const taskId = row.providerTaskId;
    let finished = false;
    // The copy job joins the transaction that records completion, so the finished clip and its copy job commit together.
    const scope: TxScope = {
      run: (fn) =>
        this.database.uow.run(async (tx) => {
          const value = await fn(tx);
          if (finished) await enqueueCopy(this.boss, tx, jobId);
          return value;
        }),
    };
    const outcome = await runPoll({
      boss: this.boss,
      uow: scope,
      table: VIDEO_TABLE,
      jobId,
      timing: { intervalSec: this.config.pollIntervalSec, leaseSec: this.config.pollLeaseSec },
      call: async (): Promise<PollResult> => {
        const result = await this.read(row.keyId, row.ownerId, taskId, log);
        finished = result.kind === 'completed';
        return result;
      },
    });
    if (outcome.kind === 'skipped') return 'skipped';
    if (outcome.kind === 'timed_out') {
      await this.releaseReservation(row.ownerId, jobId);
      return 'timed_out';
    }
    if (outcome.result === 'failed') {
      await this.releaseReservation(row.ownerId, jobId);
      return 'failed';
    }
    return outcome.result;
  }

  /** One status read. A key or provider fault that ends the job is returned; a transient one is thrown to retry. */
  private async read(keyId: string | null, ownerId: string, taskId: string, log: JobLog): Promise<PollResult> {
    const key = followUpKey({ keyId, ownerId }, keyId === null ? null : await this.keys.keyOf(keyId));
    if (key === null) return { kind: 'failed', cause: 'key_deleted', message: 'The WaveSpeed key this clip used was removed.' };
    let ended: PollResult | undefined;
    const status = await this.keys.with(key, log, async (credential) => {
      try {
        return await this.video.status(credential, taskId);
      } catch (error) {
        if (!(error instanceof ProviderCallFailed)) throw error;
        const c = error.classification;
        if (c.countsAsAuthFailure) await this.keys.report(key, false, log);
        // The provider refused the read for good: the key is not accepted, or the task is gone.
        if (error.status === 401 || error.status === 403) ended = { kind: 'failed', cause: 'configuration', ...(c.message === undefined ? {} : { message: c.message }) };
        else if (error.status === 404) ended = { kind: 'failed', cause: 'temporary', message: GONE };
        else throw error;
        return undefined;
      }
    });
    if (status === 'unreadable') return { kind: 'failed', cause: 'configuration', message: 'Your WaveSpeed key could not be read. Enter it again.' };
    if (ended !== undefined) return ended;
    if (status === undefined) throw new Error('video status read returned nothing');
    await this.keys.report(key, true, log);
    if (status.state === 'completed') return { kind: 'completed' };
    if (status.state === 'failed') {
      const c = classifyProviderFailure(PROVIDER, { kind: 'poll_failed', authError: status.errorClass === 'auth' });
      return { kind: 'failed', cause: c.causeClass, message: c.causeClass === 'configuration' ? `your ${PROVIDER} key was not accepted` : 'The provider could not make this clip. Try again.' };
    }
    return { kind: 'pending' };
  }

  /** The submit event stands (the provider billed); the unused part of the reservation (the first QC) goes. */
  private async releaseReservation(ownerId: string, jobId: string): Promise<void> {
    await this.database.uow.run((tx: DbTx) => this.usage.release(tx, { ownerId, jobType: 'video', jobId }));
  }
}
