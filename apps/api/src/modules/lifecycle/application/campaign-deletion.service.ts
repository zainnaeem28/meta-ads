import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/index.js';
import { newId } from '../../../platform/shared-kernel/index.js';
import { AuditService } from '../../audit/index.js';
import { ThumbService, VideoJobsService } from '../../production/index.js';
import { UsageService } from '../../usage/index.js';
import {
  CAMPAIGN_BRIEF_TEXT_MODEL,
  CAMPAIGN_DELETION_QUEUEING,
  CAMPAIGN_DELETION_REPOSITORY,
} from './campaign-deletion-ports.js';
import type {
  CampaignDeletionQueueing,
  CampaignDeletionRepository,
} from './campaign-deletion-ports.js';

export interface DeletionAccepted {
  readonly deletionRunId: string;
  readonly state: 'running';
}

/**
 * API-042 (ARCHITECTURE §5.8): one transaction hides the campaign (`deleting`, only while `active`), cancels every
 * unfinished job with its reservation, inserts the run, enqueues it and records the audit event. The response comes
 * after that commit, so the campaign is gone from every read at once and the worker has a run to find.
 */
@Injectable()
export class CampaignDeletionService {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(CAMPAIGN_DELETION_REPOSITORY) private readonly repository: CampaignDeletionRepository,
    @Inject(CAMPAIGN_DELETION_QUEUEING) private readonly queue: CampaignDeletionQueueing,
    @Inject(VideoJobsService) private readonly video: VideoJobsService,
    @Inject(ThumbService) private readonly thumbs: ThumbService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CAMPAIGN_BRIEF_TEXT_MODEL) private readonly textModel: string,
  ) {}

  async request(
    ownerId: string,
    campaignId: string,
    requestId: string | null,
  ): Promise<DeletionAccepted> {
    const accepted = await this.database.uow.run(async (tx): Promise<DeletionAccepted | null> => {
      if (!(await this.repository.markDeleting(tx, ownerId, campaignId))) return null;
      await this.video.cancelForCampaign(tx, ownerId, campaignId);
      await this.thumbs.cancel(tx, ownerId, 'cancelled_campaign_deleted', campaignId);
      for (const job of await this.repository.cancelBriefJobs(tx, ownerId, campaignId)) {
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
      const runId = newId();
      await this.repository.insertRun(tx, { id: runId, ownerId, campaignId });
      await this.queue.send(tx, runId);
      await this.audit.record(tx, {
        actorId: ownerId,
        actorType: 'user',
        action: 'campaign.deleted',
        objectType: 'campaign',
        objectId: campaignId,
        outcome: 'allowed',
        requestId,
      });
      return { deletionRunId: runId, state: 'running' };
    });
    if (accepted !== null) return accepted;
    // A foreign, unknown or already-deleting campaign: one answer for all three, and the attempt is audited.
    await this.database.uow.run((tx) =>
      this.audit.record(tx, {
        actorId: ownerId,
        actorType: 'user',
        action: 'access.denied_foreign',
        objectType: 'campaign',
        objectId: campaignId,
        outcome: 'denied',
        requestId,
      }),
    );
    throw new DomainError('not_found', 'Not found.');
  }
}
