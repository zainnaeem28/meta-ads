import type { DbTx } from '../../../platform/db/index.js';
import type { DeletionRun } from '../domain/campaign-deletion.js';

// Campaign deletion (TASK-058): what the request side and the worker steps need, as interfaces. The adapters are in
// `infrastructure/`; the composition roots bind the media deletion helper and the provider cleanup of the production
// module, whose classes lifecycle may not import.

export const CAMPAIGN_DELETION_REPOSITORY = Symbol('CAMPAIGN_DELETION_REPOSITORY');
export const CAMPAIGN_MEDIA_PURGE = Symbol('CAMPAIGN_MEDIA_PURGE');
export const CAMPAIGN_PROVIDER_TASKS = Symbol('CAMPAIGN_PROVIDER_TASKS');
export const CAMPAIGN_ERASURE_LEDGER = Symbol('CAMPAIGN_ERASURE_LEDGER');
export const CAMPAIGN_DELETION_CONFIG = Symbol('CAMPAIGN_DELETION_CONFIG');
export const CAMPAIGN_DELETION_QUEUEING = Symbol('CAMPAIGN_DELETION_QUEUEING');
/** `OPENAI_TEXT_MODEL`: the operation a brief call that was in flight at the cancel is converted under. */
export const CAMPAIGN_BRIEF_TEXT_MODEL = Symbol('CAMPAIGN_BRIEF_TEXT_MODEL');

export interface CampaignDeletionConfig {
  /** `DELETION_RETRY_LIMIT`: failures of one run before it is `stuck`. */
  readonly retryLimit: number;
  /** `VIDEO_JOB_DEADLINE_MIN`: the longest a job of the campaign can still be running after the cancel. */
  readonly jobDeadlineMinutes: number;
  /** Seconds added to the deadline before the verification count. */
  readonly graceSeconds: number;
}

export interface JobLog {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

/** A brief generation job that was cancelled with the campaign (its reservation is released or converted). */
export interface CancelledBriefJob {
  readonly id: string;
  readonly state: string;
  readonly callCount: number;
}

export interface CampaignDeletionRepository {
  /** `active` to `deleting` for the owner's own campaign only; false when it is foreign, unknown or already deleting. */
  markDeleting(tx: DbTx, ownerId: string, campaignId: string): Promise<boolean>;
  /** Every non-terminal brief generation job of the campaign becomes `cancelled`; returns them for the reservations. */
  cancelBriefJobs(tx: DbTx, ownerId: string, campaignId: string): Promise<CancelledBriefJob[]>;
  insertRun(tx: DbTx, run: { id: string; ownerId: string; campaignId: string }): Promise<void>;
  findRun(tx: DbTx, runId: string): Promise<DeletionRun | null>;
  /** The step is done: `step` becomes the next one (or the run is completed by `complete`), with the optional wait. */
  advance(tx: DbTx, runId: string, patch: { step: number; remainingObjects?: number | null; notBeforeInMs?: number }): Promise<void>;
  /** A step failed: one more attempt and the class of the failure. */
  recordFailure(tx: DbTx, runId: string, errorClass: string): Promise<number>;
  markStuck(tx: DbTx, runId: string): Promise<void>;
  /** The campaign row and everything below it (cascade); idempotent. */
  hardDeleteCampaign(tx: DbTx, campaignId: string): Promise<void>;
  complete(tx: DbTx, runId: string): Promise<void>;
  /** Sets `remaining_objects` without moving the step. */
  setRemaining(tx: DbTx, runId: string, remaining: number): Promise<void>;
}

/** The media module's deletion helpers (`MediaDeletion`), as the run uses them. */
export interface CampaignMediaPurge {
  deleteForCampaign(campaignId: string): Promise<{ rows: number; objects: number }>;
  sweepPrefix(prefix: string): Promise<number>;
}

/** Provider copies of finished clips (ADR-013), best effort: a failure never stops the run. */
export interface CampaignProviderTasks {
  deleteFinishedTasks(log: JobLog): Promise<void>;
}

/** The write-once erasure ledger (SEC-D §10.8): one conditional put per run; an existing object is success. */
export interface CampaignErasureLedger {
  record(key: string, body: string): Promise<void>;
}

/** Sends the run's job; `startAfterSec` delays it (the wait before the verification count). */
export interface CampaignDeletionQueueing {
  send(tx: DbTx, runId: string, options?: { startAfterSec?: number }): Promise<void>;
}
