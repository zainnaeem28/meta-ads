import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database } from '../../../platform/db/index.js';
import { CLAIM_COUNTS_REPOSITORY } from './brief-ports.js';
import type { ClaimCountsRepository, ClaimWindow } from './brief-ports.js';
import type { RuleClass } from '../domain/index.js';

/** One entry of the `claimChecks` list of API-130 (UsageReport): the events of one rule class in the window. */
export interface ClaimCheckCounts {
  readonly class: RuleClass;
  readonly raised: number;
  readonly closedByEdit: number;
  readonly clearedWithReason: number;
}

const CLASSES: readonly RuleClass[] = ['high_risk', 'other'];

/** `brief.claimCounts(window)` of shared-boundaries v6 §5: the claim-check history counted for the usage report. */
@Injectable()
export class ClaimCountsService {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(CLAIM_COUNTS_REPOSITORY) private readonly repository: ClaimCountsRepository,
  ) {}

  /**
   * Counts claim events by event time in `[from, to)`, always one entry for `high_risk` and one for `other` (zeros for an
   * empty window). `window.ownerId` limits the count to one account's events; the usage report passes none for the
   * all-accounts view.
   */
  async claimCounts(window: ClaimWindow): Promise<readonly ClaimCheckCounts[]> {
    const rows = await this.database.uow.run((tx) => this.repository.countEvents(tx, window));
    return CLASSES.map((cls) => {
      const of = (outcome: string): number =>
        rows.filter((row) => row.class === cls && row.outcome === outcome).reduce((sum, row) => sum + row.count, 0);
      return { class: cls, raised: of('raised'), closedByEdit: of('closed_by_edit'), clearedWithReason: of('cleared_with_reason') };
    });
  }
}
