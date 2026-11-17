import type { Classification } from '../../../../platform/egress/index.js';
import type { DbTx } from '../../../../platform/db/index.js';

// The worker side of production (TASK-053): what the video handlers need of the provider, persistence, key custody and
// storage, as interfaces. The adapters live in `infrastructure/wavespeed/`; `bootstrap/worker.module.ts` binds the unsealer.

/** The owner's unsealed provider key for one call. The caller zeroes it; the port never logs or stores it. */
export interface ProviderCredential {
  readonly apiKey: Buffer;
}

export interface VideoSubmitInput {
  readonly model: string;
  /** The scene description and the spoken dialogue, as one prompt. */
  readonly prompt: string;
  /** A one-object provider-fetch signed URL of the reference image, or null for text-to-video. */
  readonly imageUrl: string | null;
  readonly durationSeconds: number;
  readonly resolution: string;
  readonly aspectRatio: string;
}

export type ProviderState = 'created' | 'processing' | 'completed' | 'failed';

export interface VideoStatus {
  readonly state: ProviderState;
  /** Set only when `state` is `completed`. A provider URL: never stored, never shown to a user. */
  readonly outputUrl?: string;
  /** Set only when `state` is `failed`: `auth` when the provider names a key fault, else `other`. Never a body. */
  readonly errorClass?: 'auth' | 'other';
}

/**
 * VideoGenPort (ARCHITECTURE §1.3): `submit` is called at most once per job row and never retried (the provider has no
 * idempotency key); `status` is a read and may repeat; `deleteTask` runs only after the job completed and our copy exists.
 */
export interface VideoGenPort {
  submit(credential: ProviderCredential, input: VideoSubmitInput): Promise<string>;
  status(credential: ProviderCredential, taskId: string): Promise<VideoStatus>;
  deleteTask(credential: ProviderCredential, taskId: string): Promise<void>;
}
export const VIDEO_GEN_PORT = Symbol('VIDEO_GEN_PORT');

/** A provider call failed; `classification` is the ARCHITECTURE §5.10 row (cause class, usage effect, auth failure). */
export class ProviderCallFailed extends Error {
  constructor(
    readonly classification: Classification,
    /** The HTTP status when the provider answered; lets a caller treat 404 as "already gone". */
    readonly status?: number,
  ) {
    super(`provider call failed: ${classification.causeClass}`);
    this.name = 'ProviderCallFailed';
  }
}

/** The answer was received but is not what the port expects. For a submit the call may still be billed. */
export class ProviderInvalidResponse extends Error {
  constructor(readonly reason: string) {
    super(`provider returned an invalid response: ${reason}`);
    this.name = 'ProviderInvalidResponse';
  }
}

export type VideoCause =
  | 'temporary'
  | 'configuration'
  | 'credit'
  | 'provider_timeout'
  | 'key_replaced'
  | 'key_deleted'
  | 'reference_unreachable'
  | 'output_unreachable'
  | 'outcome_unknown'
  | 'cancelled_campaign_deleted';

export interface VideoJobRow {
  readonly id: string;
  readonly ownerId: string;
  readonly campaignId: string;
  readonly segmentId: string;
  readonly segmentRevision: number;
  readonly referenceMediaId: string | null;
  readonly providerModel: string;
  readonly options: {
    readonly durationSeconds: number;
    readonly resolution: string;
    readonly aspectRatio: string;
  };
  readonly state: string;
  readonly keyId: string | null;
  readonly keyVersion: number | null;
  readonly providerTaskId: string | null;
  readonly providerCompletedAt: string | null;
  readonly outputMediaId: string | null;
}

/** A stored key: the sealed parts and the facts the claim guard checks. Read by key ID only. */
export interface SealedKeyRow {
  readonly id: string;
  readonly ownerId: string;
  readonly provider: 'openai' | 'wavespeed';
  readonly status: 'active' | 'untested' | 'disabled';
  readonly version: number;
  readonly sealed: {
    readonly ciphertext: Buffer;
    readonly nonce: Buffer;
    readonly wrappedDek: Buffer;
    readonly kekVersion: number;
  };
}

/** Opens a sealed key. Bound by the worker composition root alone to `KeyUnsealer` (layer rule L3). */
export interface KeyOpener {
  unseal(
    sealed: SealedKeyRow['sealed'],
    aad: {
      readonly userId: string;
      readonly provider: 'openai' | 'wavespeed';
      readonly keyId: string;
      readonly version: number;
    },
  ): Buffer;
}
export const KEY_OPENER = Symbol('KEY_OPENER');

/** Reports what a provider call told about the key: a 401 counts toward disabling it, a success resets the count. */
export interface KeyAuthReporter {
  report(keyId: string, version: number, ok: boolean): Promise<void>;
}
export const KEY_AUTH_REPORTER = Symbol('KEY_AUTH_REPORTER');
/** `KEY_AUTO_DISABLE_THRESHOLD`: consecutive provider 401s that disable a key. */
export const KEY_AUTH_THRESHOLD = Symbol('KEY_AUTH_THRESHOLD');

export interface CopyTarget {
  readonly mediaId: string;
  readonly storageKey: string;
  readonly bytes: number;
}

export type CopyGuard =
  /** Our object is registered and the job is `completed`. */
  | { readonly kind: 'completed' }
  /** The job was cancelled or failed, or the campaign is going away: nothing registered, the caller deletes its object. */
  | { readonly kind: 'refused' };

export interface CleanupCandidate {
  readonly id: string;
  readonly ownerId: string;
  readonly keyId: string | null;
  readonly providerTaskId: string;
}

/** What the worker handlers read and write of `video_jobs`; every method runs in the caller's transaction. */
export interface VideoWorkerRepository {
  findJob(tx: DbTx, jobId: string): Promise<VideoJobRow | null>;
  findKey(tx: DbTx, keyId: string): Promise<SealedKeyRow | null>;
  /** The segment's text as it is now. */
  findSegmentText(
    tx: DbTx,
    segmentId: string,
  ): Promise<{ readonly prompt: string; readonly dialogue: string } | null>;
  /** True while the campaign exists and is not being deleted. */
  campaignActive(tx: DbTx, campaignId: string): Promise<boolean>;
  /** `pending` to `failed` (no call was made). False when the job is no longer `pending`. */
  failPending(tx: DbTx, jobId: string, cause: VideoCause, message: string): Promise<boolean>;
  /** Counts the one submit on a `submitting` job. False when the sweep or a cancel already settled it. */
  startCall(tx: DbTx, jobId: string): Promise<boolean>;
  /** Records the last error code of a failed call for support (never a provider body). */
  setErrorCode(tx: DbTx, jobId: string, code: string): Promise<void>;
  /** The job in the copy phase: `processing`, provider finished, no output yet, copy window still open. */
  copyOpen(
    tx: DbTx,
    jobId: string,
    windowHours: number,
  ): Promise<'open' | 'window_passed' | 'not_copying'>;
  /**
   * Guard after the put (ARCHITECTURE §5.5): in one transaction the job must still be `processing` with the provider
   * finished and the campaign `active`; then the job becomes `completed` with the registered media row.
   */
  completeCopy(
    tx: DbTx,
    job: VideoJobRow,
    target: CopyTarget,
    register: (tx: DbTx) => Promise<void>,
  ): Promise<CopyGuard>;
  /** `processing` (copying) to `failed` `output_unreachable`. False when the job already left that state. */
  failCopy(tx: DbTx, jobId: string, message: string): Promise<boolean>;
  markOutputDeleted(tx: DbTx, jobId: string): Promise<void>;
  /** Jobs whose provider task may still hold output we should delete (TD-D30). */
  cleanupCandidates(tx: DbTx, limit: number): Promise<readonly CleanupCandidate[]>;
}
export const VIDEO_WORKER_REPOSITORY = Symbol('VIDEO_WORKER_REPOSITORY');

/** What the copy handler and the submit handler read of the media module. */
export interface ProductionMedia {
  /** The one-object provider-fetch signed URL of the reference image (60 min). Throws when it is not `ready` or not the owner's. */
  referenceUrl(ownerId: string, mediaId: string): Promise<string>;
  /** Records the stored clip in the caller's transaction (quota and row). */
  registerClip(
    tx: DbTx,
    input: {
      readonly id: string;
      readonly ownerId: string;
      readonly campaignId: string;
      readonly storageKey: string;
      readonly bytes: number;
    },
  ): Promise<void>;
}
export const PRODUCTION_MEDIA = Symbol('PRODUCTION_MEDIA');

export interface VideoWorkerConfig {
  readonly runningJobsPerUser: number;
  readonly pollIntervalSec: number;
  readonly pollLeaseSec: number;
  readonly submitOrphanAfterSec: number;
  readonly copyWindowHours: number;
  /** Largest clip the copy accepts. */
  readonly outputMaxBytes: number;
  /** The base URL of the WaveSpeed API; the real endpoint unless a test points it at a local server (the host stays allow-listed). */
  readonly baseUrl?: string;
}
export const VIDEO_WORKER_CONFIG = Symbol('VIDEO_WORKER_CONFIG');

export interface JobLog {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

/** The worker's recovery-sweep registry, passed in by the composition root. */
export const SWEEP_REGISTRY = Symbol('SWEEP_REGISTRY');

/** The worker's object storage as this module reads it (resolved lazily from the media module's own storage). */
export const PRODUCTION_STORAGE = Symbol('PRODUCTION_STORAGE');
