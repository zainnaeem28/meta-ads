import { Inject } from '@nestjs/common';
import type { PgBoss } from 'pg-boss';
import type { DbTx } from '../../../platform/db/index.js';
import { enqueue } from '../../../platform/jobs/enqueue.js';
import { BOSS } from '../../../platform/jobs/boss.js';
import type { CampaignDeletionQueueing } from '../application/campaign-deletion-ports.js';
import { CAMPAIGN_DELETION_QUEUE } from '../domain/campaign-deletion.js';

/** Sends the run's job on the caller's transaction (ADR-003): it exists only if the request or step commits. */
export class PgBossCampaignDeletionQueueing implements CampaignDeletionQueueing {
  constructor(@Inject(BOSS) private readonly boss: Pick<PgBoss, 'send'>) {}

  async send(tx: DbTx, runId: string, options: { startAfterSec?: number } = {}): Promise<void> {
    await enqueue(
      this.boss,
      tx,
      CAMPAIGN_DELETION_QUEUE,
      { runId },
      options.startAfterSec === undefined ? {} : { startAfter: options.startAfterSec },
    );
  }
}
