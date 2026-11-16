import type { DbTx } from '../../../platform/db/index.js';

export type MediaKind = 'upload' | 'clip' | 'final' | 'thumbstopper';
export type MediaState = 'processing' | 'ready' | 'rejected';

export interface MediaRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: MediaKind;
  readonly state: MediaState;
  readonly storageKey: string;
  readonly bytes: number | null;
  readonly contentType: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly campaignId: string | null;
  readonly attachedAt: Date | null;
  readonly rejectReason: string | null;
  readonly createdAt: Date;
}

export type NewMedia = Omit<MediaRecord, 'attachedAt' | 'rejectReason' | 'createdAt'>;

/** Module-private persistence; other modules never see it. Every method runs in the caller's transaction. */
export interface MediaRepository {
  /**
   * Makes sure the owner's `storage_usage` row exists and locks it (`FOR UPDATE`); returns the bytes in use.
   * Concurrent uploads of one owner queue here, so the quota check and the reservation are one step.
   */
  lockUsage(tx: DbTx, ownerId: string): Promise<number>;
  /** Plain read of the owner's usage (0 when the row does not exist yet). */
  usage(tx: DbTx, ownerId: string): Promise<number>;
  /** Adds `delta` (negative to release) to the owner's usage row, creating it when absent. */
  addUsage(tx: DbTx, ownerId: string, delta: number): Promise<void>;
  insert(tx: DbTx, media: NewMedia): Promise<void>;
  find(tx: DbTx, id: string): Promise<MediaRecord | null>;
  setBytes(tx: DbTx, id: string, bytes: number): Promise<void>;
  /** Sets `attached_at` (and the campaign) once; returns false when no such row of this owner exists. */
  attach(tx: DbTx, ownerId: string, id: string, campaignId: string | null): Promise<boolean>;
  /** Deletes the row; returns what it held, or null. */
  remove(tx: DbTx, id: string): Promise<MediaRecord | null>;
}

export const MEDIA_REPOSITORY = Symbol('MEDIA_REPOSITORY');
export const MEDIA_CONFIG = Symbol('MEDIA_CONFIG');

export interface MediaConfig {
  /** `STORAGE_QUOTA_BYTES` (REQ-020: 20 GB per user by default). */
  readonly quotaBytes: number;
  /** `MEDIA_MAX_UPLOAD_BYTES`. */
  readonly maxUploadBytes: number;
  /** `MEDIA_BROWSER_URL_TTL_SEC`, 300 to 900. */
  readonly browserUrlTtlSec: number;
  /** `PROVIDER_FETCH_URL_TTL_SEC`. */
  readonly providerFetchUrlTtlSec: number;
}
