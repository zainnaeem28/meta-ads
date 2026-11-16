import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { MediaDeletion } from './media-deletion.js';
import { MEDIA_MAINTENANCE_REPOSITORY, WORKER_MEDIA_CONFIG } from './maintenance.js';
import type { MediaMaintenanceRepository, WorkerMediaConfig } from './maintenance.js';

export const UNATTACHED_SWEEP_QUEUE = 'media.unattached-sweep';
const BATCH = 100;
const MAX_PER_RUN = 2000;

export interface SweepOutcome {
  readonly deleted: number;
  readonly failed: number;
}

/**
 * `media.unattached-sweep` (hourly, ARCHITECTURE §5.11): an upload still unattached after `MEDIA_UNATTACHED_TTL_HOURS`
 * goes, object first and then row, and its bytes return to the owner. Attached uploads and generated media are never
 * touched. The row is re-checked under its lock, so an upload attached a moment ago is kept.
 */
@Injectable()
export class UnattachedSweep {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(MEDIA_MAINTENANCE_REPOSITORY) private readonly maintenance: MediaMaintenanceRepository,
    @Inject(MediaDeletion) private readonly deletion: MediaDeletion,
    @Inject(WORKER_MEDIA_CONFIG) private readonly config: WorkerMediaConfig,
  ) {}

  async run(now: Date = new Date()): Promise<SweepOutcome> {
    const cutoff = new Date(now.getTime() - this.config.unattachedTtlHours * 3_600_000);
    const seen = new Set<string>();
    let deleted = 0;
    let failed = 0;
    while (seen.size < MAX_PER_RUN) {
      const batch = (
        await this.database.uow.run((tx) => this.maintenance.listUnattachedBefore(tx, cutoff, BATCH + seen.size))
      ).filter((row) => !seen.has(row.id));
      if (batch.length === 0) break;
      for (const { id } of batch.slice(0, BATCH)) {
        seen.add(id);
        try {
          const done = await this.deletion.deleteOne(
            id,
            (row) => row.kind === 'upload' && row.attachedAt === null && row.createdAt < cutoff,
          );
          if (done) deleted += 1;
        } catch {
          failed += 1; // the object or the row could not be removed: it stays and the next hour tries again
        }
      }
    }
    return { deleted, failed };
  }
}
