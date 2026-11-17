import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../../platform/db/index.js';
import type { Database } from '../../../../platform/db/index.js';
import { EGRESS, EgressError } from '../../../../platform/egress/index.js';
import type { Egress } from '../../../../platform/egress/index.js';
import { UsageService } from '../../../usage/index.js';
import { campaignKey } from '../../../media/index.js';
import type { StoragePort } from '../../../media/index.js';
import { KeySession, followUpKey } from './key-session.js';
import { peekMp4 } from './mp4.js';
import {
  PRODUCTION_MEDIA,
  PRODUCTION_STORAGE,
  ProviderCallFailed,
  VIDEO_GEN_PORT,
  VIDEO_WORKER_CONFIG,
  VIDEO_WORKER_REPOSITORY,
} from './ports.js';
import type {
  JobLog,
  ProductionMedia,
  VideoGenPort,
  VideoJobRow,
  VideoWorkerConfig,
  VideoWorkerRepository,
} from './ports.js';

export { COPY_QUEUE } from './copy-queue.js';

export type VideoCopyOutcome = 'completed' | 'discarded' | 'failed' | 'skipped';

/** Refused for good: a retry would fetch the same thing (the table of ARCHITECTURE §5.10, "output URL" row). */
const FINAL_FETCH = new Set([
  'provider_unknown',
  'invalid_url',
  'not_https',
  'host_not_allowed',
  'blocked_address',
  'redirect_refused',
  'too_large',
  'wrong_type',
]);

const MESSAGES = {
  type: 'The provider returned a file that is not a video.',
  size: 'The clip is larger than the allowed size.',
  host: 'The clip could not be fetched from the provider safely.',
  window: 'The clip could not be copied from the provider in time.',
  key: 'The WaveSpeed key this clip used was removed, so the clip could not be fetched.',
} as const;

/** The first `EgressError` of an error or the errors it wraps. */
function egressCause(error: unknown): EgressError | undefined {
  for (let current: unknown = error, depth = 0; current !== undefined && depth < 5; depth += 1) {
    if (current instanceof EgressError) return current;
    current = (current as { cause?: unknown } | null)?.cause;
  }
  return undefined;
}

/**
 * `video.copy-output` (ARCHITECTURE §5.5, TD-D9, TD-D25): once the provider reported the clip finished, the clip is
 * copied to our storage within `PROVIDER_OUTPUT_COPY_WINDOW_HOURS`, whatever the job's deadline. The output URL is read
 * from the provider each time (never stored), fetched through the egress client (allow-listed host, no private address,
 * no redirect off the host, size bound), type-checked, put under a fixed key, and only then the job is completed in a
 * transaction that checks again that it was not cancelled (guard after put); a refused guard deletes our own object. A
 * retryable fault is thrown so the queue retries it with backoff; a final one fails the job `output_unreachable`.
 */
@Injectable()
export class VideoCopyJob {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(VIDEO_WORKER_REPOSITORY) private readonly repository: VideoWorkerRepository,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(KeySession) private readonly keys: KeySession,
    @Inject(VIDEO_GEN_PORT) private readonly video: VideoGenPort,
    @Inject(EGRESS) private readonly egress: Pick<Egress, 'fetchStream'>,
    @Inject(PRODUCTION_STORAGE) private readonly storage: StoragePort,
    @Inject(PRODUCTION_MEDIA) private readonly media: ProductionMedia,
    @Inject(VIDEO_WORKER_CONFIG) private readonly config: VideoWorkerConfig,
  ) {}

  async handle(job: { id: string; data: unknown }, log: JobLog): Promise<VideoCopyOutcome> {
    const jobId = (job.data as { jobId?: unknown } | null)?.jobId;
    if (typeof jobId !== 'string') throw new TypeError('video.copy-output job has no jobId');
    const outcome = await this.run(jobId, log);
    log.info(
      { module: 'production', outcome: outcome === 'failed' ? 'error' : 'ok', jobId },
      `video copy: ${outcome}`,
    );
    return outcome;
  }

  async run(jobId: string, log: JobLog): Promise<VideoCopyOutcome> {
    const phase = await this.database.uow.run(async (tx) => {
      const open = await this.repository.copyOpen(tx, jobId, this.config.copyWindowHours);
      if (open !== 'open') return { open, job: null } as const;
      const job = await this.repository.findJob(tx, jobId);
      const active = job !== null && (await this.repository.campaignActive(tx, job.campaignId));
      return { open, job: active ? job : null } as const;
    });
    if (phase.open === 'not_copying') return 'skipped';
    if (phase.open === 'window_passed') return this.fail(jobId, MESSAGES.window, log);
    const job = phase.job;
    // The campaign is going away: the deletion run cancels the job and removes what it finds; nothing is fetched.
    if (job === null || job.providerTaskId === null) return 'skipped';
    const url = await this.outputUrl(job, log);
    if (url === 'final') return this.fail(jobId, MESSAGES.key, log);
    return this.copy(job, url, log);
  }

  /** The finished output's URL, read from the provider now. Throws (retry) when the provider does not give one. */
  private async outputUrl(job: VideoJobRow, log: JobLog): Promise<string | 'final'> {
    const key = followUpKey(job, job.keyId === null ? null : await this.keys.keyOf(job.keyId));
    if (key === null) return 'final';
    const taskId = job.providerTaskId as string;
    const status = await this.keys.with(key, log, async (credential) => {
      try {
        return await this.video.status(credential, taskId);
      } catch (error) {
        if (error instanceof ProviderCallFailed && error.classification.countsAsAuthFailure)
          await this.keys.report(key, false, log);
        throw error;
      }
    });
    if (status === 'unreadable') throw new Error('provider key could not be opened');
    if (status.state !== 'completed' || status.outputUrl === undefined)
      throw new Error('the provider has no finished output to copy yet');
    return status.outputUrl;
  }

  private async copy(job: VideoJobRow, url: string, log: JobLog): Promise<VideoCopyOutcome> {
    // One object per job: a retry after a lost answer finds its own earlier put and registers that.
    const mediaId = job.id;
    const storageKey = campaignKey(job.ownerId, job.campaignId, 'clip', mediaId, 'mp4');
    let response: Awaited<ReturnType<Egress['fetchStream']>>;
    try {
      response = await this.egress.fetchStream('wavespeed', {
        url,
        maxBytes: this.config.outputMaxBytes,
      });
    } catch (error) {
      return this.fetchFailed(job.id, error, log);
    }
    if (response.status < 200 || response.status >= 300) {
      response.body.destroy();
      throw new Error(`the provider output answered ${String(response.status)}`);
    }
    let bytes: number;
    try {
      const peek = await peekMp4(response.body);
      if (!peek.ok) return this.fail(job.id, MESSAGES.type, log);
      bytes = await this.put(storageKey, peek.stream);
    } catch (error) {
      if (error instanceof OutputTooLarge) return this.fail(job.id, MESSAGES.size, log);
      return this.fetchFailed(job.id, error, log);
    }
    const target = { mediaId, storageKey, bytes };
    const guard = await this.database.uow.run((tx) =>
      this.repository.completeCopy(tx, job, target, (inner) =>
        this.media.registerClip(inner, {
          id: mediaId,
          ownerId: job.ownerId,
          campaignId: job.campaignId,
          storageKey,
          bytes,
        }),
      ),
    );
    if (guard.kind === 'refused') {
      await this.discard(storageKey, job.id, log);
      return 'discarded';
    }
    await this.deleteProviderTask(job, log);
    return 'completed';
  }

  /** The put; an object already there from an earlier attempt of this same job is the clip. */
  private async put(storageKey: string, body: Readable): Promise<number> {
    try {
      return (await this.storage.put(storageKey, body, 'video/mp4', this.config.outputMaxBytes))
        .bytes;
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'StorageTooLarge') throw new OutputTooLarge();
      if (name !== 'StorageKeyExists') throw error;
      body.destroy();
      const listed = await this.storage.list(storageKey);
      const own = listed.objects.find((object) => object.key === storageKey);
      if (own === undefined) throw error;
      return own.bytes;
    }
  }

  /** An error while fetching or storing: a final refusal fails the job, anything else is retried. */
  private async fetchFailed(jobId: string, error: unknown, log: JobLog): Promise<VideoCopyOutcome> {
    const egress = egressCause(error);
    if (egress !== undefined && FINAL_FETCH.has(egress.reason)) {
      const message =
        egress.reason === 'too_large'
          ? MESSAGES.size
          : egress.reason === 'wrong_type'
            ? MESSAGES.type
            : MESSAGES.host;
      log.warn(
        { module: 'production', outcome: 'error', jobId, reason: egress.reason },
        'provider output refused',
      );
      return this.fail(jobId, message, log);
    }
    throw error;
  }

  private async fail(jobId: string, message: string, log: JobLog): Promise<VideoCopyOutcome> {
    const failed = await this.database.uow.run(async (tx) => {
      const moved = await this.repository.failCopy(tx, jobId, message);
      if (!moved) return false;
      const job = await this.repository.findJob(tx, jobId);
      // The provider billed the clip and the submit event stands; the unused first QC part of the reservation goes.
      if (job !== null)
        await this.usage.release(tx, { ownerId: job.ownerId, jobType: 'video', jobId });
      return true;
    });
    if (failed)
      log.warn(
        { module: 'production', outcome: 'error', jobId },
        'video output could not be copied',
      );
    return failed ? 'failed' : 'skipped';
  }

  private async discard(storageKey: string, jobId: string, log: JobLog): Promise<void> {
    try {
      await this.storage.delete(storageKey);
    } catch {
      // The campaign deletion run removes whatever is left under the campaign's prefix.
      log.warn(
        { module: 'production', outcome: 'error', jobId },
        'discarded clip could not be deleted',
      );
    }
  }

  /** After our copy exists: delete the provider's output (TD-D9). A failure is left to the hourly cleanup. */
  private async deleteProviderTask(job: VideoJobRow, log: JobLog): Promise<void> {
    try {
      const key = followUpKey(job, job.keyId === null ? null : await this.keys.keyOf(job.keyId));
      if (key === null || job.providerTaskId === null) return;
      const taskId = job.providerTaskId;
      const done = await this.keys.with(key, log, async (credential) => {
        await this.video.deleteTask(credential, taskId);
        return true;
      });
      if (done === true)
        await this.database.uow.run((tx) => this.repository.markOutputDeleted(tx, job.id));
    } catch {
      log.warn(
        { module: 'production', outcome: 'error', jobId: job.id },
        'provider task could not be deleted; the hourly cleanup retries',
      );
    }
  }
}

class OutputTooLarge extends Error {
  constructor() {
    super('the output is larger than the allowed size');
    this.name = 'OutputTooLarge';
  }
}
