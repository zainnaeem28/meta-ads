import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../../platform/db/index.js';
import type { Database } from '../../../../platform/db/index.js';
import { KeySession, followUpKey } from './key-session.js';
import { ProviderCallFailed, VIDEO_GEN_PORT, VIDEO_WORKER_REPOSITORY } from './ports.js';
import type { CleanupCandidate, JobLog, VideoGenPort, VideoWorkerRepository } from './ports.js';

export const PROVIDER_COPY_CLEANUP_QUEUE = 'production.provider-copy-cleanup';
const BATCH = 100;

export interface CleanupOutcome {
  readonly deleted: number;
  readonly waiting: number;
  readonly failed: number;
}

/**
 * `production.provider-copy-cleanup`, hourly (ARCHITECTURE §5.11, TD-D30): a WaveSpeed task that outlived its job (failed
 * or cancelled past its deadline, with a task id) may hold a finished output on the provider's side. The task is asked
 * about; when it reports a finished state it is deleted and `provider_output_deleted_at` is set, and a still-running task
 * waits for the next hour. Jobs older than 7 days are not asked (the provider has dropped the output). A completed job
 * whose delete after the copy failed is retried here too. One task's failure never stops the others.
 */
@Injectable()
export class ProviderCopyCleanup {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(VIDEO_WORKER_REPOSITORY) private readonly repository: VideoWorkerRepository,
    @Inject(KeySession) private readonly keys: KeySession,
    @Inject(VIDEO_GEN_PORT) private readonly video: VideoGenPort,
  ) {}

  async run(log: JobLog): Promise<CleanupOutcome> {
    const candidates = await this.database.uow.run((tx) => this.repository.cleanupCandidates(tx, BATCH));
    let deleted = 0;
    let waiting = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        const result = await this.one(candidate, log);
        if (result === 'deleted') deleted += 1;
        else waiting += 1;
      } catch {
        failed += 1;
        log.warn({ module: 'production', outcome: 'error', jobId: candidate.id }, 'provider task cleanup failed; retried next hour');
      }
    }
    return { deleted, waiting, failed };
  }

  private async one(candidate: CleanupCandidate, log: JobLog): Promise<'deleted' | 'waiting'> {
    const key = followUpKey(
      { keyId: candidate.keyId, ownerId: candidate.ownerId },
      candidate.keyId === null ? null : await this.keys.keyOf(candidate.keyId),
    );
    // No key to ask with: nothing can be done from here; the account removal run deletes provider tasks itself.
    if (key === null) return 'waiting';
    const taskId = candidate.providerTaskId;
    const outcome = await this.keys.with(key, log, async (credential): Promise<'deleted' | 'waiting'> => {
      try {
        const status = await this.video.status(credential, taskId);
        if (status.state === 'created' || status.state === 'processing') return 'waiting';
        await this.video.deleteTask(credential, taskId);
        return 'deleted';
      } catch (error) {
        // The provider no longer has the task: there is nothing left to delete.
        if (error instanceof ProviderCallFailed && error.status === 404) return 'deleted';
        throw error;
      }
    });
    if (outcome === 'unreadable') return 'waiting';
    if (outcome === 'deleted') await this.database.uow.run((tx) => this.repository.markOutputDeleted(tx, candidate.id));
    return outcome;
  }
}
