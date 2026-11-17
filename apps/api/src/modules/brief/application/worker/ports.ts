import type { DbTx } from '../../../../platform/db/index.js';
import type { CompiledRules } from '../../domain/claim-check.js';
import type { BriefInput } from './text-ai.port.js';

// The worker side of the brief module (TASK-049): what the two job handlers need from persistence, key custody and
// storage, as interfaces. The adapters live in `infrastructure/`; `bootstrap/worker.module.ts` binds the unsealer.

export type BriefJobKind = 'brief_generation' | 'image_analysis';

export type JobCause =
  | 'temporary'
  | 'configuration'
  | 'credit'
  | 'outcome_unknown'
  | 'key_replaced'
  | 'key_deleted'
  | 'cancelled_campaign_deleted';

export interface BriefJobRow {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: BriefJobKind;
  readonly campaignId: string | null;
  readonly mediaId: string | null;
  readonly generationSeq: number;
  readonly state: string;
  readonly keyId: string | null;
  readonly keyVersion: number | null;
  readonly callCount: number;
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

export interface BriefSegmentRow {
  readonly id: string;
  readonly position: number;
  readonly state: string;
  readonly revision: number;
  readonly dialogue: string;
  readonly prompt: string;
}

export interface IssueRow {
  readonly id: string;
  readonly segmentId: string;
  readonly field: 'dialogue' | 'prompt';
  readonly ruleId: string;
  readonly resolution: 'open' | 'closed_by_edit' | 'cleared_with_reason';
}

export interface BriefContext {
  readonly briefId: string;
  readonly briefState: string;
  readonly briefGenerationSeq: number;
  readonly input: BriefInput;
  readonly segments: readonly BriefSegmentRow[];
  readonly issues: readonly IssueRow[];
}

export interface MediaFacts {
  readonly id: string;
  readonly ownerId: string;
  readonly state: string;
  readonly storageKey: string;
  readonly contentType: string | null;
}

/** A segment as written when a generation lands. */
export interface WrittenSegment {
  /** The existing row's id, or a new one for a position that had no row. */
  readonly id: string;
  readonly position: number;
  readonly dialogue: string;
  readonly prompt: string;
  readonly wordCount: number;
}

export interface NewIssue {
  readonly segmentId: string;
  readonly field: 'dialogue' | 'prompt';
  readonly ruleId: string;
  readonly class: 'high_risk' | 'other';
  readonly message: string;
  readonly spanStart: number | null;
  readonly spanEnd: number | null;
}

export type GenerationWrite =
  | { readonly kind: 'written' }
  /** The brief or campaign is gone, or a newer generation has replaced this one: nothing was written. */
  | { readonly kind: 'superseded' };

export interface BriefJobRepository {
  /** The job row, or null. */
  findJob(tx: DbTx, jobId: string): Promise<BriefJobRow | null>;
  findKey(tx: DbTx, keyId: string): Promise<SealedKeyRow | null>;
  findMedia(tx: DbTx, mediaId: string): Promise<MediaFacts | null>;
  /** Intake, brief and segments of a campaign for a generation; null when the campaign or its brief is gone. */
  findContext(tx: DbTx, campaignId: string): Promise<BriefContext | null>;
  /**
   * `pending` to `submitting` under the owner's `run:` lock, committed before any provider call (ARCHITECTURE §5.5). Brief
   * jobs have no running limit. False when the job is not `pending` any more (redelivery, cancel, a second worker).
   */
  claim(tx: DbTx, jobId: string): Promise<boolean>;
  /** `pending` to `failed` (no call was made). False when the job is no longer `pending`. */
  failPending(tx: DbTx, jobId: string, cause: JobCause, message: string): Promise<boolean>;
  /** `submitting` to `failed`. False when the job already left `submitting` (the sweep settled it). */
  failSubmitting(
    tx: DbTx,
    jobId: string,
    cause: JobCause,
    message: string,
    errorCode?: string,
  ): Promise<boolean>;
  /** Marks provider call `seq` as started on a `submitting` job (`call_count` goes from seq-1 to seq). */
  startCall(tx: DbTx, jobId: string, seq: number): Promise<boolean>;
  /**
   * Writes a generated brief in place and completes the job, in one transaction: segments (revision +1 where text
   * changed), the issues to close and to raise with their `claim_events`, the brief to `draft` (version +1) and the job
   * to `completed`.
   */
  completeGeneration(
    tx: DbTx,
    job: BriefJobRow,
    context: BriefContext,
    write: {
      segments: readonly WrittenSegment[];
      close: readonly string[];
      raise: readonly NewIssue[];
    },
  ): Promise<GenerationWrite>;
  /** `submitting` to `completed` with the description. */
  completeAnalysis(tx: DbTx, jobId: string, description: string): Promise<boolean>;
  /** A failed job: the brief becomes `failed` (first generation) or returns to `draft` (regenerate). */
  settleBriefAfterFailure(tx: DbTx, campaignId: string, generationSeq: number): Promise<void>;
}

export const BRIEF_JOB_REPOSITORY = Symbol('BRIEF_JOB_REPOSITORY');

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
export const BRIEF_AUTH_THRESHOLD = Symbol('BRIEF_AUTH_THRESHOLD');

/** The active claim rules, compiled (the seeded table, never a stale copy). */
export interface ClaimRules {
  activeRules(): Promise<CompiledRules>;
}
export const CLAIM_RULES = Symbol('CLAIM_RULES');

/** Reads the sanitized product image. */
export interface ImageSource {
  read(storageKey: string): Promise<Buffer>;
}
export const IMAGE_SOURCE = Symbol('IMAGE_SOURCE');

export interface BriefWorkerConfig {
  readonly textModel: string;
  readonly visionModel: string;
  /** Terms the image-analysis filter drops sentences for (`config/brand-rules.json`). */
  readonly sensitiveTerms: readonly string[];
  /** The chat completions URL; the OpenAI endpoint unless a test points it at a local server (the host stays allow-listed). */
  readonly chatUrl?: string;
}
export const BRIEF_WORKER_CONFIG = Symbol('BRIEF_WORKER_CONFIG');

export interface JobLog {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}
