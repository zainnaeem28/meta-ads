import type { DbTx } from '../../../platform/db/index.js';
import type { MediaRecord } from '../application/ports.js';
import type { RejectReason } from './image-sanitize.port.js';

/** Module-private queries of the worker jobs; every method runs in the caller's transaction. */
export interface MediaMaintenanceRepository {
  /** The row, locked (`FOR UPDATE`), or null. */
  lockRow(tx: DbTx, id: string): Promise<MediaRecord | null>;
  /** `processing` to `ready`: the sanitized object, its size and dimensions. */
  markReady(
    tx: DbTx,
    id: string,
    ready: {
      storageKey: string;
      bytes: number;
      contentType: string;
      width: number;
      height: number;
    },
  ): Promise<void>;
  /** `processing` to `rejected`: the reservation is returned by the caller (bytes drop to 0). */
  markRejected(tx: DbTx, id: string, reason: RejectReason): Promise<void>;
  /** Ids of uploads never attached and created before `cutoff`, oldest first. */
  listUnattachedBefore(
    tx: DbTx,
    cutoff: Date,
    limit: number,
  ): Promise<{ id: string; ownerId: string }[]>;
  listByCampaign(
    tx: DbTx,
    campaignId: string,
    limit: number,
  ): Promise<{ id: string; ownerId: string }[]>;
  /** How many retries the job has used and how many it may use, or null when pg-boss no longer holds it. */
  jobAttempts(
    tx: DbTx,
    queue: string,
    jobId: string,
  ): Promise<{ retryCount: number; retryLimit: number } | null>;
}

export const MEDIA_MAINTENANCE_REPOSITORY = Symbol('MEDIA_MAINTENANCE_REPOSITORY');
export const WORKER_MEDIA_CONFIG = Symbol('WORKER_MEDIA_CONFIG');

export interface WorkerMediaConfig {
  /** `MEDIA_UNATTACHED_TTL_HOURS`. */
  readonly unattachedTtlHours: number;
}

export interface JobLog {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}
