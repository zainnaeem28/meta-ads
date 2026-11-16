import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { MEDIA_REPOSITORY } from '../application/ports.js';
import type { MediaRecord, MediaRepository } from '../application/ports.js';
import { quarantineKey, uploadKey } from '../domain/keys.js';
import { STORAGE_PORT, StorageKeyExists, StorageNotFound } from '../domain/storage.js';
import type { StoragePort } from '../domain/storage.js';
import { IMAGE_CONTENT_TYPES, IMAGE_SANITIZE_PORT, ImageRejected } from './image-sanitize.port.js';
import type { ImageSanitizePort, RejectReason } from './image-sanitize.port.js';
import { MEDIA_MAINTENANCE_REPOSITORY } from './maintenance.js';
import type { JobLog, MediaMaintenanceRepository } from './maintenance.js';

export const SANITIZE_QUEUE = 'media.sanitize';

export type SanitizeOutcome = 'ready' | 'rejected' | 'skipped';

async function readAll(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/**
 * `media.sanitize` (ARCHITECTURE §5.4): the quarantine object is inspected (header only), re-encoded without any
 * metadata, stored at `u/{owner}/media/{id}`, and the row becomes `ready` (dimensions, size, quota adjusted) or
 * `rejected` (reason, reservation returned). The quarantine object is deleted last. Safe to run again after any crash:
 * the clean copy is written conditionally and an existing one is reused, and a row that is no longer `processing`
 * is left alone. A transient failure is thrown so pg-boss retries; on the last retry the row is `rejected`
 * (`decode_failed`) and the job ends.
 */
@Injectable()
export class SanitizeJob {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(MEDIA_REPOSITORY) private readonly repository: MediaRepository,
    @Inject(MEDIA_MAINTENANCE_REPOSITORY) private readonly maintenance: MediaMaintenanceRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(IMAGE_SANITIZE_PORT) private readonly sanitizer: ImageSanitizePort,
  ) {}

  /** The handler: reads the job's retry budget from pg-boss, then runs. */
  async handle(job: { id: string; data: unknown }, log: JobLog): Promise<SanitizeOutcome> {
    const mediaId = (job.data as { mediaId?: unknown } | null)?.mediaId;
    if (typeof mediaId !== 'string') throw new TypeError('media.sanitize job has no mediaId');
    const attempts = await this.database.uow.run((tx) => this.maintenance.jobAttempts(tx, SANITIZE_QUEUE, job.id));
    const finalAttempt = attempts !== null && attempts.retryCount >= attempts.retryLimit;
    const outcome = await this.run(mediaId, finalAttempt, log);
    log.info({ module: 'media', outcome: 'ok', mediaId }, `sanitize: ${outcome}`);
    return outcome;
  }

  async run(mediaId: string, finalAttempt: boolean, log: JobLog): Promise<SanitizeOutcome> {
    const row = await this.database.uow.run((tx) => this.repository.find(tx, mediaId));
    if (row === null) return 'skipped';
    if (row.state !== 'processing') {
      // A previous attempt finished the row but may have died before deleting the quarantine object.
      if (row.state === 'ready') await this.dropQuarantine(row, log);
      return 'skipped';
    }
    try {
      return await this.process(row, log);
    } catch (error) {
      if (error instanceof ImageRejected) {
        await this.reject(row, error.reason, log);
        return 'rejected';
      }
      if (!finalAttempt) throw error;
      log.warn({ module: 'media', outcome: 'error', mediaId }, 'sanitize failed on its last attempt; rejecting');
      await this.reject(row, 'decode_failed', log);
      return 'rejected';
    }
  }

  private async process(row: MediaRecord, log: JobLog): Promise<SanitizeOutcome> {
    const quarantine = quarantineKey(row.ownerId, row.id);
    const target = uploadKey(row.ownerId, row.id);
    let source: Buffer;
    try {
      source = await readAll(await this.storage.get(quarantine));
    } catch (error) {
      if (error instanceof StorageNotFound) {
        // Already moved by an attempt that stored the clean copy but did not record it? Reuse that copy.
        const existing = await this.existingClean(target);
        if (existing === null) throw new ImageRejected('decode_failed');
        return this.finish(row, target, existing, log);
      }
      throw error;
    }
    const info = await this.sanitizer.inspect(source);
    const clean = await this.sanitizer.reencode(source, info.format);
    const contentType = IMAGE_CONTENT_TYPES[info.format];
    try {
      await this.storage.put(target, clean, contentType, clean.length);
    } catch (error) {
      if (!(error instanceof StorageKeyExists)) throw error;
      // An earlier attempt stored it; keep that object and take its facts from it.
      const existing = await this.existingClean(target);
      if (existing === null) throw error;
      return this.finish(row, target, existing, log);
    }
    return this.finish(row, target, clean, log);
  }

  private async existingClean(target: string): Promise<Buffer | null> {
    try {
      return await readAll(await this.storage.get(target));
    } catch (error) {
      if (error instanceof StorageNotFound) return null;
      throw error;
    }
  }

  private async finish(row: MediaRecord, target: string, clean: Buffer, log: JobLog): Promise<SanitizeOutcome> {
    const info = await this.sanitizer.inspect(clean);
    await this.database.uow.run(async (tx) => {
      await this.repository.lockUsage(tx, row.ownerId);
      await this.maintenance.markReady(tx, row.id, {
        storageKey: target,
        bytes: clean.length,
        contentType: IMAGE_CONTENT_TYPES[info.format],
        width: info.width,
        height: info.height,
      });
      await this.repository.addUsage(tx, row.ownerId, clean.length - (row.bytes ?? 0));
    });
    await this.dropQuarantine(row, log);
    return 'ready';
  }

  private async reject(row: MediaRecord, reason: RejectReason, log: JobLog): Promise<void> {
    await this.database.uow.run(async (tx) => {
      await this.repository.lockUsage(tx, row.ownerId);
      await this.maintenance.markRejected(tx, row.id, reason);
      await this.repository.addUsage(tx, row.ownerId, -(row.bytes ?? 0));
    });
    log.info({ module: 'media', outcome: 'ok', mediaId: row.id, reason }, `sanitize rejected: ${reason}`);
    await this.dropQuarantine(row, log);
  }

  /** Last step, best effort: a leftover quarantine object is removed by the next run or the owner's erasure. */
  private async dropQuarantine(row: MediaRecord, log: JobLog): Promise<void> {
    try {
      await this.storage.delete(quarantineKey(row.ownerId, row.id));
    } catch {
      log.warn({ module: 'media', outcome: 'error', mediaId: row.id }, 'quarantine object not deleted');
    }
  }
}
