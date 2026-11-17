import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { BOSS } from '../../../platform/jobs/boss.js';
import { enqueue } from '../../../platform/jobs/enqueue.js';
import { MediaService } from '../application/media.service.js';
import type { UploadResult } from '../application/media.service.js';
import { MEDIA_CONFIG } from '../application/ports.js';
import type { MediaConfig } from '../application/ports.js';
import { STORAGE_PORT } from '../domain/storage.js';
import type { StoragePort } from '../domain/storage.js';
import { UploadTooLarge, peek, sniffImageType } from './sniff.js';

export const SANITIZE_QUEUE = 'media.sanitize';

/**
 * API-030 as one unit (ARCHITECTURE §5.4): sniff the first bytes, stream the body into quarantine through
 * `MediaService.upload` (quota reserved first, row `processing`), then enqueue `media.sanitize` in a transaction of its
 * own. When the job cannot be queued the row and the object are removed, so a `processing` row always has a job.
 */
@Injectable()
export class MediaUploadService {
  constructor(
    @Inject(MediaService) private readonly media: MediaService,
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(BOSS) private readonly boss: Parameters<typeof enqueue>[0],
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(MEDIA_CONFIG) private readonly config: MediaConfig,
  ) {}

  get maxUploadBytes(): number {
    return this.config.maxUploadBytes;
  }

  async upload(
    ownerId: string,
    file: Readable,
    announcedBytes: number | undefined,
  ): Promise<UploadResult> {
    const { head, body } = await peek(file, this.config.maxUploadBytes);
    const contentType = sniffImageType(head);
    if (contentType === null) {
      file.destroy();
      throw new DomainError('unsupported_media_type', 'This content type is not supported.');
    }
    // The announced length covers the multipart framing too, so it is only an upper bound for the reservation.
    const declaredBytes = Math.min(
      announcedBytes ?? this.config.maxUploadBytes,
      this.config.maxUploadBytes,
    );
    let result: UploadResult;
    try {
      result = await this.media.upload({ ownerId, body, declaredBytes, contentType });
    } catch (error) {
      if (
        error instanceof UploadTooLarge ||
        (error as { cause?: unknown }).cause instanceof UploadTooLarge
      ) {
        throw new DomainError('payload_too_large', 'The file is too large.');
      }
      throw error;
    }
    try {
      await this.database.uow.run((tx) =>
        enqueue(this.boss, tx, SANITIZE_QUEUE, { mediaId: result.id }),
      );
    } catch (error) {
      await this.discard(result);
      throw error;
    }
    return result;
  }

  private async discard(result: UploadResult): Promise<void> {
    try {
      await this.database.uow.run((tx) => this.media.unregisterObject(tx, result.id));
      await this.storage.delete(result.storageKey);
    } catch {
      // The unattached sweep removes what is left (row without a job, then its object).
    }
  }
}
