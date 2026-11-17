import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { AlertService, AuditService } from '../../audit/index.js';
import type { PendingAlert } from '../../audit/index.js';
import {
  LAST_STEP,
  STEP_HARD_DELETE,
  STEP_MEDIA,
  STEP_PROVIDER_TASKS,
  STEP_VERIFY,
  errorClassOf,
  ledgerBodyOf,
  ledgerKeyOf,
  nextOnFailure,
  verifyDelayMs,
} from '../domain/campaign-deletion.js';
import type { DeletionRun } from '../domain/campaign-deletion.js';
import {
  CAMPAIGN_DELETION_CONFIG,
  CAMPAIGN_DELETION_QUEUEING,
  CAMPAIGN_DELETION_REPOSITORY,
  CAMPAIGN_ERASURE_LEDGER,
  CAMPAIGN_MEDIA_PURGE,
  CAMPAIGN_PROVIDER_TASKS,
} from './campaign-deletion-ports.js';
import type {
  CampaignDeletionConfig,
  CampaignDeletionQueueing,
  CampaignDeletionRepository,
  CampaignErasureLedger,
  CampaignMediaPurge,
  CampaignProviderTasks,
  JobLog,
} from './campaign-deletion-ports.js';

export type CampaignDeletionOutcome = 'skipped' | 'waiting' | 'completed' | 'failed' | 'stuck';

/** The verification count found objects or rows that the delete steps did not remove. */
export class DeletionVerificationFailed extends Error {
  constructor(readonly remaining: number) {
    super(`campaign deletion left ${String(remaining)} items`);
    this.name = 'DeletionVerificationFailed';
  }
}

/**
 * `lifecycle.campaign-deletion` (ARCHITECTURE §5.8): step 0 the ledger object, then 1 provider copies of finished clips,
 * 2 objects and then rows, 3 the wait for the longest job deadline and the verification count, 4 the hard delete. A step
 * that fails counts one attempt and the queue retries it with backoff; at `DELETION_RETRY_LIMIT` the run is `stuck`, an
 * administrator alert is raised once and the campaign stays invisible. Every step can run again on its own.
 */
@Injectable()
export class CampaignDeletionJob {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(CAMPAIGN_DELETION_REPOSITORY) private readonly repository: CampaignDeletionRepository,
    @Inject(CAMPAIGN_MEDIA_PURGE) private readonly media: CampaignMediaPurge,
    @Inject(CAMPAIGN_PROVIDER_TASKS) private readonly providers: CampaignProviderTasks,
    @Inject(CAMPAIGN_ERASURE_LEDGER) private readonly ledger: CampaignErasureLedger,
    @Inject(CAMPAIGN_DELETION_QUEUEING) private readonly queue: CampaignDeletionQueueing,
    @Inject(CAMPAIGN_DELETION_CONFIG) private readonly config: CampaignDeletionConfig,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AlertService) private readonly alerts: AlertService,
  ) {}

  async handle(job: { id: string; data: unknown }, log: JobLog): Promise<CampaignDeletionOutcome> {
    const runId = (job.data as { runId?: unknown } | null)?.runId;
    if (typeof runId !== 'string')
      throw new TypeError('lifecycle.campaign-deletion job has no runId');
    const outcome = await this.run(runId, log);
    log.info(
      { module: 'lifecycle', outcome: outcome === 'failed' ? 'error' : 'ok', runId },
      `campaign deletion: ${outcome}`,
    );
    return outcome;
  }

  async run(runId: string, log: JobLog): Promise<CampaignDeletionOutcome> {
    for (;;) {
      const run = await this.database.uow.run((tx) => this.repository.findRun(tx, runId));
      if (run === null || run.kind !== 'campaign' || run.state !== 'running') return 'skipped';
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
  private async step(run: DeletionRun, log: JobLog): Promise<'continue' | 'waiting' | 'completed'> {
    const campaignId = run.subjectId;
    switch (run.step) {
      case STEP_PROVIDER_TASKS: {
        // Step 0, then the best-effort provider deletion: a provider that cannot be reached never holds the run.
        await this.ledger.record(ledgerKeyOf(run.createdAt, run.id), ledgerBodyOf(run));
        await this.providers.deleteFinishedTasks(log).catch(() => {
          log.warn(
            { module: 'lifecycle', outcome: 'error', runId: run.id },
            'provider task deletion failed; the hourly cleanup retries',
          );
        });
        await this.database.uow.run((tx) =>
          this.repository.advance(tx, run.id, { step: STEP_MEDIA }),
        );
        return 'continue';
      }
      case STEP_MEDIA: {
        await this.media.deleteForCampaign(campaignId);
        await this.media.sweepPrefix(prefixOf(run));
        // Jobs cancelled at the request may still be inside a provider call or a copy: wait out the longest deadline.
        const delayMs = verifyDelayMs(this.config.jobDeadlineMinutes, this.config.graceSeconds);
        await this.database.uow.run((tx) =>
          this.repository.advance(tx, run.id, { step: STEP_VERIFY, notBeforeInMs: delayMs }),
        );
        return 'continue';
      }
      case STEP_VERIFY: {
        await this.providers.deleteFinishedTasks(log).catch(() => undefined);
        // The sweep removes what a late copy or an earlier failed step left; the count after it must be zero.
        await this.media.deleteForCampaign(campaignId);
        await this.media.sweepPrefix(prefixOf(run));
        const left = await this.countRemaining(run);
        await this.database.uow.run((tx) => this.repository.setRemaining(tx, run.id, left));
        if (left > 0) throw new DeletionVerificationFailed(left);
        await this.database.uow.run((tx) =>
          this.repository.advance(tx, run.id, { step: STEP_HARD_DELETE, remainingObjects: 0 }),
        );
        return 'continue';
      }
      case STEP_HARD_DELETE: {
        await this.database.uow.run(async (tx) => {
          await this.repository.hardDeleteCampaign(tx, campaignId);
          await this.repository.complete(tx, run.id);
          await this.audit.record(tx, {
            actorId: null,
            actorType: 'system',
            action: 'campaign.deletion_completed',
            objectType: 'campaign',
            objectId: campaignId,
            outcome: 'allowed',
          });
        });
        return 'completed';
      }
      default:
        throw new RangeError(
          `unknown campaign deletion step ${String(run.step)} (last is ${String(LAST_STEP)})`,
        );
    }
  }

  /** Objects under the campaign prefix plus media rows still registered for the campaign. */
  private async countRemaining(run: DeletionRun): Promise<number> {
    const [first, again] = [
      await this.media.deleteForCampaign(run.subjectId),
      await this.media.sweepPrefix(prefixOf(run)),
    ];
    return first.rows + first.objects + again;
  }

  private async fail(
    run: DeletionRun,
    error: unknown,
    log: JobLog,
  ): Promise<CampaignDeletionOutcome> {
    const errorClass = errorClassOf(error);
    let alert: PendingAlert | undefined;
    const stuck = await this.database.uow.run(async (tx) => {
      const attempts = await this.repository.recordFailure(tx, run.id, errorClass);
      if (!nextOnFailure(attempts - 1, this.config.retryLimit).stuck) return false;
      await this.repository.markStuck(tx, run.id);
      await this.audit.record(tx, {
        actorId: null,
        actorType: 'system',
        action: 'campaign.deletion_stuck',
        objectType: 'campaign',
        objectId: run.subjectId,
        outcome: 'failed',
      });
      alert = await this.alerts.raiseAlert(tx, 'campaign_deletion_stuck', run.ownerId, {
        attempts,
        step: run.step,
      });
      return true;
    });
    alert?.announce();
    log.warn(
      { module: 'lifecycle', outcome: 'error', runId: run.id, step: run.step, errorClass },
      stuck ? 'campaign deletion stuck' : 'campaign deletion step failed; retrying',
    );
    if (stuck) return 'stuck';
    // The queue retries the job with its backoff; this counts as one attempt of the run.
    throw error;
  }
}

function prefixOf(run: DeletionRun): string {
  return `u/${run.ownerId}/c/${run.subjectId}/`;
}
