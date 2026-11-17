import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { AlertService, AuditService } from '../../audit/index.js';
import type { PendingAlert } from '../../audit/index.js';
import { errorClassOf, nextOnFailure, verifyDelayMs } from '../domain/campaign-deletion.js';
import {
  ACCOUNT_STEP_DELETE_IDP_USER,
  ACCOUNT_STEP_HARD_DELETE,
  ACCOUNT_STEP_PURGE_STORAGE,
  ACCOUNT_STEP_REVOKE_SESSIONS,
  ACCOUNT_STEP_VERIFY,
  accountPrefixes,
  ledgerKeyAndBody,
} from './account-erasure-steps.js';
import {
  ACCOUNT_ERASURE_QUEUEING,
  ACCOUNT_IDENTITY,
  ACCOUNT_LIFECYCLE_REPOSITORY,
} from './account-lifecycle-ports.js';
import type {
  AccountErasureQueueing,
  AccountIdentity,
  AccountLifecycleRepository,
  AccountRun,
} from './account-lifecycle-ports.js';
import {
  CAMPAIGN_DELETION_CONFIG,
  CAMPAIGN_ERASURE_LEDGER,
  CAMPAIGN_MEDIA_PURGE,
  CAMPAIGN_PROVIDER_TASKS,
} from './campaign-deletion-ports.js';
import type {
  CampaignDeletionConfig,
  CampaignErasureLedger,
  CampaignMediaPurge,
  CampaignProviderTasks,
  JobLog,
} from './campaign-deletion-ports.js';

export type AccountErasureOutcome = 'skipped' | 'waiting' | 'completed' | 'failed' | 'stuck';

/** The verification count found objects that the delete steps did not remove. */
export class ErasureVerificationFailed extends Error {
  constructor(readonly remaining: number) {
    super(`account erasure left ${String(remaining)} objects`);
    this.name = 'ErasureVerificationFailed';
  }
}

type FoundRun = AccountRun & { createdAt: string; notBefore: string; ownerId: string };

/**
 * `lifecycle.account-erasure` (ARCHITECTURE §5.8, SB-D12): step 0 the ledger object, before anything is erased; then
 * 1 revoke the sessions, 2 delete the identity provider user, 3 provider copies and the objects under `u/{id}/` and
 * `q/{id}/`, 4 the wait for the longest job deadline and the verification count, 5 `eraseSubjectRecords` and the hard
 * delete of the account in one transaction. A failing step counts one attempt and the queue retries it with backoff; at
 * `DELETION_RETRY_LIMIT` the run is `stuck`, an administrator alert is raised once and `erasure:resume` continues it.
 * Every step can run again on its own.
 */
@Injectable()
export class AccountErasureJob {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(ACCOUNT_LIFECYCLE_REPOSITORY) private readonly repository: AccountLifecycleRepository,
    @Inject(ACCOUNT_IDENTITY) private readonly identity: AccountIdentity,
    @Inject(CAMPAIGN_MEDIA_PURGE) private readonly media: CampaignMediaPurge,
    @Inject(CAMPAIGN_PROVIDER_TASKS) private readonly providers: CampaignProviderTasks,
    @Inject(CAMPAIGN_ERASURE_LEDGER) private readonly ledger: CampaignErasureLedger,
    @Inject(ACCOUNT_ERASURE_QUEUEING) private readonly queue: AccountErasureQueueing,
    @Inject(CAMPAIGN_DELETION_CONFIG) private readonly config: CampaignDeletionConfig,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AlertService) private readonly alerts: AlertService,
  ) {}

  async handle(job: { id: string; data: unknown }, log: JobLog): Promise<AccountErasureOutcome> {
    const runId = (job.data as { runId?: unknown } | null)?.runId;
    if (typeof runId !== 'string')
      throw new TypeError('lifecycle.account-erasure job has no runId');
    const outcome = await this.run(runId, log);
    log.info(
      { module: 'lifecycle', outcome: outcome === 'failed' ? 'error' : 'ok', runId },
      `account erasure: ${outcome}`,
    );
    return outcome;
  }

  async run(runId: string, log: JobLog): Promise<AccountErasureOutcome> {
    for (;;) {
      const run = await this.database.uow.run((tx) => this.repository.findRun(tx, runId));
      if (run === undefined || run.state !== 'running') return 'skipped';
      const waitMs = Date.parse(run.notBefore) - Date.now();
      if (waitMs > 0) {
        await this.database.uow.run((tx) =>
          this.queue.send(tx, runId, { startAfterSec: Math.ceil(waitMs / 1000) }),
        );
        return 'waiting';
      }
      try {
        const next = await this.step(run, log);
        if (next === 'completed' || next === 'waiting') return next;
      } catch (error) {
        return this.fail(run, error, log);
      }
    }
  }

  /** Runs the run's current step; `continue` means the next step may run at once. */
  private async step(run: FoundRun, log: JobLog): Promise<'continue' | 'waiting' | 'completed'> {
    switch (run.step) {
      case ACCOUNT_STEP_REVOKE_SESSIONS: {
        // Step 0: nothing is erased until the ledger holds the entry (a repeat of the put is success).
        const entry = ledgerKeyAndBody(run);
        await this.ledger.record(entry.key, entry.body);
        const subject = await this.database.uow.run((tx) =>
          this.repository.findSubject(tx, run.subjectId),
        );
        if (subject !== undefined) await this.identity.revokeSessions(subject.idpSubject);
        await this.advance(run, ACCOUNT_STEP_DELETE_IDP_USER);
        return 'continue';
      }
      case ACCOUNT_STEP_DELETE_IDP_USER: {
        const subject = await this.database.uow.run((tx) =>
          this.repository.findSubject(tx, run.subjectId),
        );
        if (subject !== undefined) await this.identity.deleteUser(subject.idpSubject);
        await this.advance(run, ACCOUNT_STEP_PURGE_STORAGE);
        return 'continue';
      }
      case ACCOUNT_STEP_PURGE_STORAGE: {
        await this.providers.deleteFinishedTasks(log).catch(() => {
          log.warn(
            { module: 'lifecycle', outcome: 'error', runId: run.id },
            'provider task deletion failed; the hourly cleanup retries',
          );
        });
        for (const prefix of accountPrefixes(run.subjectId)) await this.media.sweepPrefix(prefix);
        // Jobs cancelled at the removal may still be inside a provider call or a copy: wait out the longest deadline.
        const delayMs = verifyDelayMs(this.config.jobDeadlineMinutes, this.config.graceSeconds);
        await this.database.uow.run(async (tx) => {
          await this.repository.advance(tx, run.id, { step: ACCOUNT_STEP_VERIFY });
          // The wait is the run's own `not_before`, as in the campaign run.
          await this.repository.setNotBefore(tx, run.id, delayMs);
        });
        return 'continue';
      }
      case ACCOUNT_STEP_VERIFY: {
        await this.providers.deleteFinishedTasks(log).catch(() => undefined);
        let left = 0;
        for (const prefix of accountPrefixes(run.subjectId)) await this.media.sweepPrefix(prefix);
        for (const prefix of accountPrefixes(run.subjectId))
          left += await this.media.sweepPrefix(prefix);
        await this.database.uow.run((tx) => this.repository.setRemaining(tx, run.id, left));
        if (left > 0) throw new ErasureVerificationFailed(left);
        await this.database.uow.run((tx) =>
          this.repository.advance(tx, run.id, {
            step: ACCOUNT_STEP_HARD_DELETE,
            remainingObjects: 0,
          }),
        );
        return 'continue';
      }
      case ACCOUNT_STEP_HARD_DELETE: {
        const subject = await this.database.uow.run((tx) =>
          this.repository.findSubject(tx, run.subjectId),
        );
        if (subject !== undefined) {
          // The invitations of this address that still exist at the provider are revoked first; a retry finds them again.
          const pending = await this.database.uow.run((tx) =>
            this.repository.invitationsToRevoke(tx, subject.email),
          );
          for (const invitationId of pending) await this.identity.revokeInvitation(invitationId);
        }
        await this.database.uow.run(async (tx) => {
          const current = await this.repository.findSubject(tx, run.subjectId);
          if (current !== undefined) {
            await this.repository.eraseSubjectRecords(tx, current);
            await this.repository.deleteUser(tx, run.subjectId);
          }
          await this.repository.complete(tx, run.id);
          await this.audit.record(tx, {
            actorId: null,
            actorType: 'system',
            action: 'account.erasure_completed',
            objectType: 'user',
            objectId: run.subjectId,
            outcome: 'allowed',
          });
        });
        return 'completed';
      }
      default:
        throw new RangeError(`unknown account erasure step ${String(run.step)}`);
    }
  }

  private advance(run: FoundRun, step: number): Promise<void> {
    return this.database.uow.run((tx) => this.repository.advance(tx, run.id, { step }));
  }

  private async fail(run: FoundRun, error: unknown, log: JobLog): Promise<AccountErasureOutcome> {
    const errorClass = errorClassOf(error);
    let alert: PendingAlert | undefined;
    const stuck = await this.database.uow.run(async (tx) => {
      const attempts = await this.repository.recordFailure(tx, run.id, errorClass);
      if (!nextOnFailure(attempts - 1, this.config.retryLimit).stuck) return false;
      await this.repository.markStuck(tx, run.id);
      await this.audit.record(tx, {
        actorId: null,
        actorType: 'system',
        action: 'account.erasure_stuck',
        objectType: 'user',
        objectId: run.subjectId,
        outcome: 'failed',
      });
      alert = await this.alerts.raiseAlert(tx, 'account_erasure_stuck', run.subjectId, {
        attempts,
        step: run.step,
      });
      return true;
    });
    alert?.announce();
    log.warn(
      { module: 'lifecycle', outcome: 'error', runId: run.id, step: run.step, errorClass },
      stuck ? 'account erasure stuck' : 'account erasure step failed; retrying',
    );
    if (stuck) return 'stuck';
    // The queue retries the job with its backoff; this counts as one attempt of the run.
    throw error;
  }
}
