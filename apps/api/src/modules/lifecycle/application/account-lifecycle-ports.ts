import type { DbTx } from '../../../platform/db/index.js';
import type { CancelledBriefJob } from './campaign-deletion-ports.js';

// Account suspension, removal and erasure (TASK-059): what the request side and the worker steps need, as interfaces.
// The adapters are in `infrastructure/`; the identity module's admin service and identity port are reached through
// adapters because the composition roots do not pass them to this module.

export const ACCOUNT_LIFECYCLE_REPOSITORY = Symbol('ACCOUNT_LIFECYCLE_REPOSITORY');
export const ACCOUNT_ADMIN = Symbol('ACCOUNT_ADMIN');
export const ACCOUNT_IDENTITY = Symbol('ACCOUNT_IDENTITY');
export const ACCOUNT_ERASURE_QUEUEING = Symbol('ACCOUNT_ERASURE_QUEUEING');
/** `ERASURE_HOLD_PERIOD_HOURS` (OI-RET, default 0): the wait between the removal and the first erasure step. */
export const ACCOUNT_HOLD_HOURS = Symbol('ACCOUNT_HOLD_HOURS');
/** `CURSOR_SIGNING_KEY` (registry), read once by the composition root, for API-105. */
export const ACCOUNT_CURSOR_KEY = Symbol('ACCOUNT_CURSOR_KEY');

export type AccountStatus = 'active' | 'suspended' | 'removed';

/** The subject account as the lifecycle reads it (never shown beyond the confirmation check). */
export interface AccountSubject {
  readonly id: string;
  readonly email: string;
  readonly idpSubject: string;
  readonly role: 'user' | 'admin';
  readonly status: AccountStatus;
  readonly version: number;
}

export interface AccountView {
  readonly id: string;
  readonly email: string;
  readonly role: 'user' | 'admin';
  readonly status: AccountStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly erasure: null | { readonly deletionRunId: string; readonly step: number; readonly state: string };
}

/** The identity module's admin service as lifecycle uses it: the status change with the admin invariant, under its lock. */
export interface AccountAdmin {
  setStatus(
    tx: DbTx,
    input: { actorId: string; userId: string; status: AccountStatus; expectedVersion: number },
  ): Promise<AccountView>;
}

/** The identity provider calls of the erasure steps. A missing provider object is already done. */
export interface AccountIdentity {
  revokeSessions(idpSubject: string): Promise<void>;
  deleteUser(idpSubject: string): Promise<void>;
  revokeInvitation(idpInvitationId: string): Promise<void>;
}

export interface AccountRun {
  readonly id: string;
  readonly subjectId: string;
  readonly step: number;
  readonly state: 'running' | 'completed' | 'stuck';
  readonly attempts: number;
  readonly remainingObjects: number | null;
  readonly updatedAt: string;
}

export interface AccountRunQuery {
  readonly state?: 'running' | 'completed' | 'stuck';
  readonly limit: number;
  readonly after?: { readonly updatedAt: string; readonly id: string };
}

export interface AccountRunListed extends AccountRun {
  /** The exact `updated_at` text (microseconds): the sort key of the cursor. */
  readonly updatedAtKey: string;
}

export interface AccountLifecycleRepository {
  /** Takes the `admin-invariant` lock and reads the account; undefined when there is none. */
  lockAndFind(tx: DbTx, userId: string): Promise<AccountSubject | undefined>;
  /** Every non-terminal brief job of the owner becomes `cancelled`; returned for the reservations. */
  cancelBriefJobs(tx: DbTx, ownerId: string, cause: 'cancelled_account_suspended' | 'cancelled_account_removed'): Promise<CancelledBriefJob[]>;
  /** Hard-deletes the owner's provider keys and writes one `deleted` event each; returns how many. */
  deleteKeys(tx: DbTx, ownerId: string): Promise<number>;
  /** Every `active` campaign of the owner becomes `deleting` (invisible at once); returns how many. */
  hideCampaigns(tx: DbTx, ownerId: string): Promise<number>;
  insertRun(tx: DbTx, run: { id: string; userId: string; holdHours: number }): Promise<void>;
  findRunBySubject(tx: DbTx, userId: string): Promise<AccountRun | undefined>;
  listRuns(tx: DbTx, query: AccountRunQuery): Promise<AccountRunListed[]>;
  /** The run of an account run id, with the data the steps need; undefined for another kind. */
  findRun(tx: DbTx, runId: string): Promise<(AccountRun & { createdAt: string; notBefore: string; ownerId: string }) | undefined>;
  advance(tx: DbTx, runId: string, patch: { step: number; remainingObjects?: number | null }): Promise<void>;
  /** The run waits this long before its next step (`not_before`). */
  setNotBefore(tx: DbTx, runId: string, inMs: number): Promise<void>;
  recordFailure(tx: DbTx, runId: string, errorClass: string): Promise<number>;
  markStuck(tx: DbTx, runId: string): Promise<void>;
  setRemaining(tx: DbTx, runId: string, remaining: number): Promise<void>;
  /** `stuck` to `running` with a clean attempt count; false when the run is not stuck. */
  resume(tx: DbTx, runId: string): Promise<boolean>;
  /** The subject's emails and subject id, before the rows go; undefined when the account row is gone already. */
  findSubject(tx: DbTx, userId: string): Promise<{ email: string; idpSubject: string } | undefined>;
  /** Provider invitation ids of the invitations of this email that still hold a provider object. */
  invitationsToRevoke(tx: DbTx, email: string): Promise<string[]>;
  /** SB-D12 `eraseSubjectRecords`: invitations by `lower(email)`, access requests by subject or `lower(email)`. */
  eraseSubjectRecords(tx: DbTx, subject: { email: string; idpSubject: string }): Promise<void>;
  /** The account row; the cascade removes every user-owned table. Idempotent. */
  deleteUser(tx: DbTx, userId: string): Promise<void>;
  complete(tx: DbTx, runId: string): Promise<void>;
}

export interface AccountErasureQueueing {
  send(tx: DbTx, runId: string, options?: { startAfterSec?: number }): Promise<void>;
}
