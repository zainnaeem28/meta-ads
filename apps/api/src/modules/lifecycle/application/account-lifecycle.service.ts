import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database, DbTx } from '../../../platform/db/index.js';
import { buildPage, decodeCursor } from '../../../platform/http/cursor.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { PageResult } from '../../../platform/http/response.js';
import { newId } from '../../../platform/shared-kernel/index.js';
import { AuditService } from '../../audit/index.js';
import { ThumbService, VideoJobsService } from '../../production/index.js';
import { UsageService } from '../../usage/index.js';
import { holdMs } from './account-erasure-steps.js';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_CURSOR_KEY,
  ACCOUNT_ERASURE_QUEUEING,
  ACCOUNT_HOLD_HOURS,
  ACCOUNT_LIFECYCLE_REPOSITORY,
} from './account-lifecycle-ports.js';
import type {
  AccountAdmin,
  AccountErasureQueueing,
  AccountLifecycleRepository,
  AccountRun,
  AccountSubject,
  AccountView,
} from './account-lifecycle-ports.js';
import { CAMPAIGN_BRIEF_TEXT_MODEL } from './campaign-deletion-ports.js';

export interface RemovalAccepted {
  readonly deletionRunId: string;
  readonly state: 'running';
}

export interface ErasureRunView {
  readonly id: string;
  readonly kind: 'account';
  readonly subjectId: string;
  readonly step: number;
  readonly state: AccountRun['state'];
  readonly attempts: number;
  readonly remainingObjects: number | null;
  readonly updatedAt: string;
}

export interface ListErasuresInput {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly state?: AccountRun['state'] | undefined;
}

type Cause = 'cancelled_account_suspended' | 'cancelled_account_removed';

/** The email the admin typed against the account email: trimmed and case-insensitive (API-103). */
export function confirmationMatches(typed: string, email: string): boolean {
  return typed.trim().toLowerCase() === email.trim().toLowerCase();
}

/**
 * API-101, 102, 103 and 105 (REQ-026, ARCHITECTURE §3.3, §5.8). Each state change is one transaction under the
 * `admin-invariant` lock: the status through the identity module (so the "at least one admin" rule is its own), the
 * cancel of every unfinished job with its reservation, and the audit event. A removal adds the key delete, the
 * campaigns' `deleting`, the erasure run and its job in the same commit, so nothing is half removed.
 */
@Injectable()
export class AccountLifecycleService {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'db' | 'uow'>,
    @Inject(ACCOUNT_LIFECYCLE_REPOSITORY) private readonly repository: AccountLifecycleRepository,
    @Inject(ACCOUNT_ADMIN) private readonly admin: AccountAdmin,
    @Inject(ACCOUNT_ERASURE_QUEUEING) private readonly queue: AccountErasureQueueing,
    @Inject(VideoJobsService) private readonly video: VideoJobsService,
    @Inject(ThumbService) private readonly thumbs: ThumbService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CAMPAIGN_BRIEF_TEXT_MODEL) private readonly textModel: string,
    @Inject(ACCOUNT_HOLD_HOURS) private readonly holdHours: number,
    @Inject(ACCOUNT_CURSOR_KEY) private readonly cursorKey: string | undefined,
  ) {}

  /** API-101. Already suspended: 200 unchanged, no event. */
  suspend(actorId: string, userId: string, requestId: string | null): Promise<AccountView> {
    return this.database.uow.run(async (tx) => {
      const target = await this.requireTarget(tx, userId);
      if (target.status === 'suspended')
        return this.admin.setStatus(tx, change(actorId, target, 'suspended'));
      const view = await this.admin.setStatus(tx, change(actorId, target, 'suspended'));
      await this.cancelJobs(tx, userId, 'cancelled_account_suspended');
      await this.record(tx, actorId, 'account.suspended', userId, requestId);
      return view;
    });
  }

  /** API-102. Already active: 200 unchanged, no event. Cancelled jobs are not resumed. */
  reinstate(actorId: string, userId: string, requestId: string | null): Promise<AccountView> {
    return this.database.uow.run(async (tx) => {
      const target = await this.requireTarget(tx, userId);
      const view = await this.admin.setStatus(tx, change(actorId, target, 'active'));
      if (target.status !== 'active')
        await this.record(tx, actorId, 'account.reinstated', userId, requestId);
      return view;
    });
  }

  /** API-103: the typed email must match; nothing changes otherwise. */
  remove(
    actorId: string,
    userId: string,
    confirmation: string,
    requestId: string | null,
  ): Promise<RemovalAccepted> {
    return this.database.uow.run(async (tx) => {
      const target = await this.requireTarget(tx, userId);
      if (!confirmationMatches(confirmation, target.email)) {
        throw new DomainError(
          'confirmation_mismatch',
          'The typed email does not match the account.',
          [
            {
              field: 'confirmation',
              code: 'mismatch',
              message: 'Type the exact email of the account.',
            },
          ],
        );
      }
      await this.admin.setStatus(tx, change(actorId, target, 'removed'));
      await this.cancelJobs(tx, userId, 'cancelled_account_removed');
      await this.repository.deleteKeys(tx, userId);
      await this.repository.hideCampaigns(tx, userId);
      const runId = newId();
      await this.repository.insertRun(tx, { id: runId, userId, holdHours: this.holdHours });
      await this.queue.send(
        tx,
        runId,
        this.holdHours > 0 ? { startAfterSec: Math.ceil(holdMs(this.holdHours) / 1000) } : {},
      );
      await this.record(tx, actorId, 'account.removed', userId, requestId);
      return { deletionRunId: runId, state: 'running' as const };
    });
  }

  /** API-105: the account runs, newest change first, IDs only. */
  async listErasures(
    actorId: string,
    input: ListErasuresInput,
  ): Promise<PageResult<ErasureRunView>> {
    const key = this.cursorKey;
    if (key === undefined || key === '') throw new Error('CURSOR_SIGNING_KEY is not configured');
    const scope = { owner: actorId, filters: { state: input.state ?? null, list: 'erasures' } };
    let after: { updatedAt: string; id: string } | undefined;
    if (input.cursor !== undefined) {
      const sortKey = decodeCursor(key, input.cursor, scope);
      const at = sortKey.indexOf('|');
      const id = sortKey.slice(at + 1);
      if (at < 1 || !/^[0-9a-f-]{36}$/.test(id) || Number.isNaN(Date.parse(sortKey.slice(0, at)))) {
        throw new DomainError('validation_failed', 'The request is not valid.', [
          {
            field: 'cursor',
            code: 'cursor_invalid',
            message: 'The cursor is invalid or has expired.',
          },
        ]);
      }
      after = { updatedAt: sortKey.slice(0, at), id };
    }
    const rows = await this.database.uow.run((tx) =>
      this.repository.listRuns(tx, {
        limit: input.limit + 1,
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(after === undefined ? {} : { after }),
      }),
    );
    const page = buildPage(rows, input.limit, (row) => `${row.updatedAtKey}|${row.id}`, key, scope);
    return new PageResult(
      page.items.map((row) => ({
        id: row.id,
        kind: 'account' as const,
        subjectId: row.subjectId,
        step: row.step,
        state: row.state,
        attempts: row.attempts,
        remainingObjects: row.remainingObjects,
        updatedAt: new Date(row.updatedAt).toISOString(),
      })),
      page.pagination,
    );
  }

  /** `erasure:resume <runId>` (ops-cli, audit-logged as `operator`): a stuck run goes back to running and is queued. */
  async resume(runId: string): Promise<boolean> {
    return this.database.uow.run(async (tx) => {
      const run = await this.repository.findRun(tx, runId);
      if (run === undefined || !(await this.repository.resume(tx, runId))) return false;
      await this.queue.send(tx, runId);
      await this.audit.record(tx, {
        actorId: null,
        actorType: 'operator',
        action: 'erasure.resumed',
        objectType: 'user',
        objectId: run.subjectId,
        outcome: 'allowed',
      });
      return true;
    });
  }

  private async requireTarget(tx: DbTx, userId: string): Promise<AccountSubject> {
    const target = await this.repository.lockAndFind(tx, userId);
    if (target === undefined) throw new DomainError('not_found', 'The account was not found.');
    if (target.status === 'removed')
      throw new DomainError('state_conflict', 'The account was removed.');
    return target;
  }

  /** Every unfinished job of the owner, with its reservation, in the caller's transaction (SB-D16). */
  private async cancelJobs(tx: DbTx, ownerId: string, cause: Cause): Promise<void> {
    await this.video.cancelForOwner(tx, ownerId, cause);
    await this.thumbs.cancel(tx, ownerId, cause);
    for (const job of await this.repository.cancelBriefJobs(tx, ownerId, cause)) {
      // A call that may already have been sent has an unknown outcome and keeps its estimate counted (SB-D9).
      if (job.state === 'submitting' && job.callCount >= 1) {
        await this.usage.convertUnconfirmed(tx, {
          ownerId,
          jobType: 'brief_generation',
          jobId: job.id,
          callSeq: job.callCount,
          call: { provider: 'openai', operation: this.textModel },
        });
      }
      await this.usage.release(tx, { ownerId, jobType: 'brief_generation', jobId: job.id });
    }
  }

  private async record(
    tx: DbTx,
    actorId: string,
    action: 'account.suspended' | 'account.reinstated' | 'account.removed',
    userId: string,
    requestId: string | null,
  ): Promise<void> {
    await this.audit.record(tx, {
      actorId,
      actorType: 'admin',
      action,
      objectType: 'user',
      objectId: userId,
      outcome: 'allowed',
      requestId,
    });
  }
}

function change(
  actorId: string,
  target: AccountSubject,
  status: 'active' | 'suspended' | 'removed',
): {
  actorId: string;
  userId: string;
  status: 'active' | 'suspended' | 'removed';
  expectedVersion: number;
} {
  return { actorId, userId: target.id, status, expectedVersion: target.version };
}
