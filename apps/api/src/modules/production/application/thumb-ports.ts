import type { DbTx } from '../../../platform/db/index.js';
import type { CompiledRules } from '../../brief/index.js';
import type { ProviderCredential, SealedKeyRow } from './worker/ports.js';

// The thumbstopper (TASK-057, ARCHITECTURE §1.3, §5.5): what the job needs of the provider and persistence, as interfaces.
// The adapters live in `infrastructure/openai-image/`; `production.module.ts` binds them.

/** What an image the provider returned is, once checked: the bytes are one of these types and nothing else is stored. */
export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface GeneratedImage {
  readonly bytes: Buffer;
  readonly contentType: ImageType;
  readonly extension: 'png' | 'jpg' | 'webp';
}

/**
 * ImageGenPort (ARCHITECTURE §1.3): `generate` is one paid call, made at most once per thumbstopper job (the queue is a
 * submit queue). 120 s timeout; a refusal or failure is `ProviderCallFailed`, an answer that is not an image of an allowed
 * type is `ProviderInvalidResponse` (the call was made and is billed).
 */
export interface ImageGenPort {
  generate(
    credential: ProviderCredential,
    input: { readonly prompt: string },
  ): Promise<GeneratedImage>;
}
export const IMAGE_GEN_PORT = Symbol('IMAGE_GEN_PORT');

export interface ThumbConfig {
  /** `OPENAI_IMAGE_MODEL`; undefined when the process has none (the call-out cannot be generated then). */
  readonly imageModel: string | undefined;
  /** The provider work of one job is bounded at 5 minutes (the submit queue expiry). */
  readonly deadlineMinutes: number;
  readonly idempotencyTtlHours: number;
  /** `SUBMIT_ORPHAN_AFTER_SEC`: a job still `submitting` this long after the claim lost its answer. */
  readonly orphanAfterSec: number;
  /** A `pending` job whose queue message was lost is queued again after this long. */
  readonly requeueAfterSec: number;
  /** Largest image the job stores (`PROVIDER_OUTPUT_MAX_BYTES`). */
  readonly outputMaxBytes: number;
  /** Test seam: the image endpoint, a local stand-in for api.openai.com (the host stays allow-listed). The product never sets it. */
  readonly imageUrl?: string;
}
export const THUMB_CONFIG = Symbol('THUMB_CONFIG');

/** The active claim rules the call-out is checked with (the brief module's reader). */
export interface CalloutRules {
  activeRules(): Promise<CompiledRules>;
}
export const CALLOUT_RULES = Symbol('CALLOUT_RULES');

/** One thumbstopper job with what the worker reads of its campaign, in one statement. */
export interface ThumbJobContext {
  readonly id: string;
  readonly ownerId: string;
  readonly campaignId: string;
  readonly calloutText: string;
  readonly providerModel: string;
  readonly state: string;
  readonly keyId: string | null;
  readonly keyVersion: number | null;
  readonly callCount: number;
  readonly campaignActive: boolean;
}

export type ThumbCause =
  | 'temporary'
  | 'configuration'
  | 'credit'
  | 'provider_timeout'
  | 'key_replaced'
  | 'key_deleted'
  | 'output_unreachable'
  | 'outcome_unknown';

/** What the job handler reads and writes of `thumbstopper_jobs`; every method runs in the caller's transaction. */
export interface ThumbRepository {
  findJob(tx: DbTx, jobId: string): Promise<ThumbJobContext | null>;
  findKey(tx: DbTx, keyId: string): Promise<SealedKeyRow | null>;
  /** `pending` to `failed` (no call was made). False when the job is no longer `pending`. */
  failPending(tx: DbTx, jobId: string, cause: ThumbCause, message: string): Promise<boolean>;
  /** Counts the one call on a `submitting` job. False when a cancel or the sweep already settled it. */
  startCall(tx: DbTx, jobId: string): Promise<boolean>;
  /** `submitting` to `failed`. False when the job left `submitting` (cancelled, swept). */
  fail(
    tx: DbTx,
    jobId: string,
    cause: ThumbCause,
    message: string,
    errorCode: string | null,
  ): Promise<boolean>;
  /**
   * `submitting` to `completed` with the registered image, guarded in the same transaction: the job must still be
   * `submitting` and the campaign `active`. `register` records the stored object. False when the guard refuses.
   */
  complete(
    tx: DbTx,
    job: ThumbJobContext,
    mediaId: string,
    register: (tx: DbTx) => Promise<void>,
  ): Promise<boolean>;
}
export const THUMB_REPOSITORY = Symbol('THUMB_REPOSITORY');

/** What the worker needs of the media module: the stored image's row, in the caller's transaction (quota and row). */
export interface ThumbMedia {
  registerImage(
    tx: DbTx,
    input: {
      readonly id: string;
      readonly ownerId: string;
      readonly campaignId: string;
      readonly storageKey: string;
      readonly bytes: number;
      readonly contentType: ImageType;
    },
  ): Promise<void>;
}
export const THUMB_MEDIA = Symbol('THUMB_MEDIA');
