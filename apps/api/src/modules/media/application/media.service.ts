import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database, DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { newId } from '../../../platform/shared-kernel/index.js';
import { isOwnedKey, quarantineKey } from '../domain/keys.js';
import {
  STORAGE_PORT,
  StorageKeyExists,
  StorageNotFound,
  StorageTooLarge,
  StorageUnavailable,
} from '../domain/storage.js';
import type { ContentDisposition, StoragePort } from '../domain/storage.js';
import { MEDIA_CONFIG, MEDIA_REPOSITORY } from './ports.js';
import type { MediaConfig, MediaKind, MediaRecord, MediaRepository, MediaState } from './ports.js';

/** What an upload may be before sanitizing; the sniffed type, never the client's claim. */
export const UPLOAD_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

export type SignedUrlPurpose = 'browser' | 'provider-fetch';

export interface QuotaState {
  readonly usedBytes: number;
  readonly allowedBytes: number;
  readonly remainingBytes: number;
}

export interface UploadInput {
  readonly ownerId: string;
  readonly body: Readable | Buffer;
  /** The size the caller announced (request length); the quota is reserved for it before the put. */
  readonly declaredBytes: number;
  /** Type found by sniffing the first bytes. */
  readonly contentType: string;
}

export interface UploadResult {
  readonly id: string;
  readonly state: 'processing';
  readonly bytes: number;
  readonly storageKey: string;
}

export interface RegisterObjectInput {
  readonly id?: string;
  readonly ownerId: string;
  readonly kind: MediaKind;
  readonly storageKey: string;
  readonly bytes: number;
  readonly contentType: string;
  readonly state?: MediaState;
  readonly width?: number;
  readonly height?: number;
  readonly campaignId?: string;
}

export interface SignedUrlInput {
  readonly ownerId: string;
  readonly mediaId: string;
  readonly disposition?: ContentDisposition;
}

export interface SignedUrl {
  readonly url: string;
  readonly expiresInSec: number;
}

const notFound = (): DomainError => new DomainError('not_found', 'Not found.');
const unavailable = (): DomainError =>
  new DomainError(
    'service_unavailable',
    'The service is temporarily unavailable. Try again shortly.',
  );

/**
 * The media module's public service (SB §4.2): quota, upload, registration of objects other modules produce,
 * attachment and signed URLs. Ownership is checked here, from the database, on every call; a foreign and a
 * never-existing id give the same 404.
 */
@Injectable()
export class MediaService {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(MEDIA_REPOSITORY) private readonly repository: MediaRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(MEDIA_CONFIG) private readonly config: MediaConfig,
  ) {}

  /** The owner's used and allowed bytes (REQ-020). */
  async quota(ownerId: string, tx?: DbTx): Promise<QuotaState> {
    const read = async (t: DbTx): Promise<QuotaState> => {
      const usedBytes = await this.repository.usage(t, ownerId);
      const allowedBytes = this.config.quotaBytes;
      return { usedBytes, allowedBytes, remainingBytes: Math.max(0, allowedBytes - usedBytes) };
    };
    return tx === undefined ? this.database.uow.run(read) : read(tx);
  }

  /**
   * Upload skeleton (ARCHITECTURE §1.7, §5.4): quota counted and reserved under the owner's `storage_usage` lock, row
   * `processing` inserted and committed, then the conditional put to `q/{owner}/{id}` outside any transaction. A put
   * that fails after the row exists deletes the row and returns the reservation in a compensating transaction (503).
   * Sanitizing and the `media.sanitize` job are the caller's next step; this method never marks a row `ready`.
   */
  async upload(input: UploadInput): Promise<UploadResult> {
    const { ownerId, declaredBytes, contentType } = input;
    if (!(UPLOAD_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      throw new DomainError('unsupported_media_type', 'This content type is not supported.');
    }
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 1) {
      throw new DomainError('validation_failed', 'The file is empty.');
    }
    if (declaredBytes > this.config.maxUploadBytes) {
      throw new DomainError('payload_too_large', 'The file is too large.');
    }
    const id = newId();
    const storageKey = quarantineKey(ownerId, id);

    await this.database.uow.run(async (tx) => {
      const used = await this.repository.lockUsage(tx, ownerId);
      if (used + declaredBytes > this.config.quotaBytes) {
        throw new DomainError('storage_quota_reached', 'Your storage is full.', [
          { field: 'usedBytes', code: 'used', message: String(used) },
          { field: 'allowedBytes', code: 'allowed', message: String(this.config.quotaBytes) },
        ]);
      }
      await this.repository.insert(tx, {
        id,
        ownerId,
        kind: 'upload',
        state: 'processing',
        storageKey,
        bytes: declaredBytes,
        contentType,
        width: null,
        height: null,
        campaignId: null,
      });
      await this.repository.addUsage(tx, ownerId, declaredBytes);
    });

    let stored: { bytes: number };
    try {
      stored = await this.storage.put(storageKey, input.body, contentType, declaredBytes);
    } catch (error) {
      await this.compensate(id);
      if (error instanceof StorageTooLarge) {
        throw new DomainError('payload_too_large', 'The file is larger than announced.');
      }
      if (error instanceof StorageUnavailable || error instanceof StorageKeyExists)
        throw unavailable();
      throw error;
    }
    if (stored.bytes !== declaredBytes) {
      // The announced size covered more than the file (multipart framing): keep only what is stored.
      await this.database.uow.run(async (tx) => {
        await this.repository.lockUsage(tx, ownerId);
        await this.repository.setBytes(tx, id, stored.bytes);
        await this.repository.addUsage(tx, ownerId, stored.bytes - declaredBytes);
      });
    }
    return { id, state: 'processing', bytes: stored.bytes, storageKey };
  }

  /** Compensating transaction: the row goes, the reservation returns. The object was never stored. */
  private async compensate(id: string): Promise<void> {
    try {
      await this.database.uow.run(async (tx) => {
        const row = await this.repository.remove(tx, id);
        if (row?.bytes != null) await this.repository.addUsage(tx, row.ownerId, -row.bytes);
      });
    } catch {
      // The unattached sweep removes a row without an object after MEDIA_UNATTACHED_TTL_HOURS and returns its bytes.
    }
  }

  /**
   * Records an object another module already stored (a clip, a final video, a thumbstopper). Runs in the caller's
   * transaction so the row and the quota move with the caller's own rows. Not refused over quota: the work was
   * already paid for; the next upload sees the new usage.
   */
  async registerObject(tx: DbTx, input: RegisterObjectInput): Promise<string> {
    if (!isOwnedKey(input.ownerId, input.storageKey)) {
      throw new TypeError('storageKey is outside the owner prefixes');
    }
    if (!Number.isSafeInteger(input.bytes) || input.bytes < 0)
      throw new TypeError('bytes must be >= 0');
    const id = input.id ?? newId();
    await this.repository.lockUsage(tx, input.ownerId);
    await this.repository.insert(tx, {
      id,
      ownerId: input.ownerId,
      kind: input.kind,
      state: input.state ?? 'ready',
      storageKey: input.storageKey,
      bytes: input.bytes,
      contentType: input.contentType,
      width: input.width ?? null,
      height: input.height ?? null,
      campaignId: input.campaignId ?? null,
    });
    await this.repository.addUsage(tx, input.ownerId, input.bytes);
    return id;
  }

  /** Marks the owner's `ready` upload as used (the unattached sweep leaves it alone). Idempotent. */
  async attach(tx: DbTx, ownerId: string, mediaId: string, campaignId?: string): Promise<void> {
    const media = await this.repository.find(tx, mediaId);
    if (media === null || media.ownerId !== ownerId || media.state === 'rejected') throw notFound();
    if (media.state !== 'ready') {
      throw new DomainError('media_not_ready', 'The file is still being checked.');
    }
    await this.repository.attach(tx, ownerId, mediaId, campaignId ?? null);
  }

  /**
   * Deletes a row of the caller's transaction and returns its bytes to the owner; returns the object key so the
   * caller deletes the object after commit.
   */
  async unregisterObject(tx: DbTx, mediaId: string): Promise<MediaRecord | null> {
    const row = await this.repository.remove(tx, mediaId);
    if (row?.bytes != null) {
      await this.repository.lockUsage(tx, row.ownerId);
      await this.repository.addUsage(tx, row.ownerId, -row.bytes);
    }
    return row;
  }

  /**
   * A time-limited read URL for one object, after an ownership check against the database. `browser` lives
   * `MEDIA_BROWSER_URL_TTL_SEC` (5 min by default, at most 15); `provider-fetch` lives `PROVIDER_FETCH_URL_TTL_SEC`
   * (60 min by default). Only a `ready` object is ever signed.
   */
  async signedUrl(purpose: SignedUrlPurpose, input: SignedUrlInput): Promise<SignedUrl> {
    const media = await this.database.uow.run((tx) => this.repository.find(tx, input.mediaId));
    if (media === null || media.ownerId !== input.ownerId || media.state === 'rejected')
      throw notFound();
    if (media.state !== 'ready')
      throw new DomainError('media_not_ready', 'The file is still being checked.');
    const expiresInSec =
      purpose === 'browser' ? this.config.browserUrlTtlSec : this.config.providerFetchUrlTtlSec;
    const disposition: ContentDisposition = input.disposition ?? { type: 'inline' };
    try {
      return {
        url: await this.storage.presignGet(media.storageKey, expiresInSec, disposition),
        expiresInSec,
      };
    } catch (error) {
      if (error instanceof StorageUnavailable || error instanceof StorageNotFound)
        throw unavailable();
      throw error;
    }
  }
}
