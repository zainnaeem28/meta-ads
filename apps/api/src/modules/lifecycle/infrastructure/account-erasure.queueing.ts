import { Inject } from '@nestjs/common';
import type { PgBoss } from 'pg-boss';
import type { DbTx } from '../../../platform/db/index.js';
import { enqueue } from '../../../platform/jobs/enqueue.js';
import { BOSS } from '../../../platform/jobs/boss.js';
import { ACCOUNT_ERASURE_QUEUE } from '../application/account-erasure-steps.js';
import type { AccountErasureQueueing } from '../application/account-lifecycle-ports.js';

/** Sends the run's job on the caller's transaction (ADR-003): it exists only if the removal or step commits. */
export class PgBossAccountErasureQueueing implements AccountErasureQueueing {
  constructor(@Inject(BOSS) private readonly boss: Pick<PgBoss, 'send'>) {}

  async send(tx: DbTx, runId: string, options: { startAfterSec?: number } = {}): Promise<void> {
    await enqueue(
      this.boss,
      tx,
      ACCOUNT_ERASURE_QUEUE,
      { runId },
      options.startAfterSec === undefined ? {} : { startAfter: options.startAfterSec },
    );
  }
}
