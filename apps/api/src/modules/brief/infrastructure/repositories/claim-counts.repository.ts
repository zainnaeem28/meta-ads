import { and, count, eq, gte, lt } from 'drizzle-orm';
import { claimEvents } from '../../../../database/schema/brief.js';
import type { DbTx } from '../../../../platform/db/index.js';
import type {
  ClaimCountRow,
  ClaimCountsRepository,
  ClaimOutcome,
  ClaimWindow,
} from '../../application/brief-ports.js';
import type { RuleClass } from '../../domain/index.js';

/** Counts over `claim_events` (append-only history, IDs and classes only). */
export class DrizzleClaimCountsRepository implements ClaimCountsRepository {
  async countEvents(tx: DbTx, window: ClaimWindow): Promise<readonly ClaimCountRow[]> {
    const rows = await tx
      .select({ class: claimEvents.class, outcome: claimEvents.outcome, count: count() })
      .from(claimEvents)
      .where(
        and(
          gte(claimEvents.at, window.from.toISOString()),
          lt(claimEvents.at, window.to.toISOString()),
          window.ownerId === undefined ? undefined : eq(claimEvents.ownerId, window.ownerId),
        ),
      )
      .groupBy(claimEvents.class, claimEvents.outcome);
    return rows.map((row) => ({
      class: row.class as RuleClass,
      outcome: row.outcome as ClaimOutcome,
      count: Number(row.count),
    }));
  }
}
