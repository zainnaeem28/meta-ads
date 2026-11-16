import { sql } from 'drizzle-orm';
import type { DbTx } from '../db/index.js';
import { lockXact } from '../db/locks.js';

/**
 * The provider-job column contract (SB §3.5) is shared by each module's own job table (SB-D4); these helpers take the
 * table name so they stay provider-agnostic. Only a plain lower-case identifier is accepted: it is placed in the
 * statement as an identifier, never as data.
 */
export interface JobTable {
  readonly table: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

export function jobTable(table: string): JobTable {
  if (!IDENTIFIER.test(table)) throw new Error(`invalid job table name: ${table}`);
  return { table };
}

export function tableSql(ref: JobTable) {
  return sql.identifier(jobTable(ref.table).table);
}

/** States in which the user's running limit is held (REQ-009); `pending` waits, the rest are terminal. */
export const RUNNING_STATES = ['submitting', 'submitted', 'processing'] as const;
/** States in which the provider still owes an answer: these are polled. */
export const LIVE_STATES = ['submitted', 'processing'] as const;

export const RUN_LIMIT = 5;

export type ClaimOutcome =
  | { readonly kind: 'claimed'; readonly ownerId: string }
  /** The owner already has `limit` jobs running: the job stays `pending` ("queued"). */
  | { readonly kind: 'held'; readonly ownerId: string; readonly running: number }
  /** Not `pending` (already claimed, finished, cancelled) or no such row: the caller makes no provider call. */
  | { readonly kind: 'not_pending' };

export interface ClaimOptions {
  /** Per-user running limit; 5 by default. `null` skips the count (a table with no per-user limit). */
  readonly limit?: number | null;
}

/**
 * Counted claim (ARCHITECTURE §1.5, §5.5). Under the `run:{ownerId}` advisory lock the owner's running jobs are
 * counted and, when below the limit, the row moves `pending` to `submitting` in the same transaction. The count and
 * the move are one critical section, so concurrent claims cannot both pass at 4; pg-boss group limits are not used.
 * Call it inside a transaction that commits before the provider is called.
 */
export async function claimWithUserLimit(
  tx: DbTx,
  ref: JobTable,
  jobId: string,
  options: ClaimOptions = {},
): Promise<ClaimOutcome> {
  const limit = options.limit === undefined ? RUN_LIMIT : options.limit;
  const table = tableSql(ref);
  const found = await tx.execute(
    sql`select owner_id::text as owner_id from ${table} where id = ${jobId} and state = 'pending'`,
  );
  const ownerId = (found.rows[0] as { owner_id: string } | undefined)?.owner_id;
  if (ownerId === undefined) return { kind: 'not_pending' };

  if (limit !== null) {
    await lockXact(tx, 'run', ownerId);
    const counted = await tx.execute(
      sql`select count(*)::int as n from ${table}
          where owner_id = ${ownerId} and state in ('submitting', 'submitted', 'processing')`,
    );
    const running = (counted.rows[0] as { n: number }).n;
    if (running >= limit) return { kind: 'held', ownerId, running };
  }
  const moved = await tx.execute(
    sql`update ${table} set state = 'submitting', submitting_at = now(), updated_at = now()
        where id = ${jobId} and state = 'pending' returning id`,
  );
  return moved.rows.length === 1 ? { kind: 'claimed', ownerId } : { kind: 'not_pending' };
}
