import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { LockOrderError } from './errors.js';
import { stateOf } from './tx-state.js';
import type { DbTx } from './unit-of-work.js';

/** Transaction-scoped lock kinds in the one order in which a transaction may take several (ARCHITECTURE 1.5). */
export const LOCK_ORDER = ['admin-invariant', 'spend', 'render-day', 'run'] as const;
export type LockKind = (typeof LOCK_ORDER)[number];

export const RECOVERY_SWEEP_LOCK = 'recovery-sweep';

/** `admin-invariant` has no owner; the others are per owner (`spend:{ownerId}`). */
export function lockName(kind: LockKind, ownerId?: string): string {
  if (kind === 'admin-invariant') return kind;
  if (ownerId === undefined || ownerId === '') throw new Error(`lock ${kind} needs an owner id`);
  return `${kind}:${ownerId}`;
}

/**
 * Take a transaction-scoped advisory lock. A transaction holds at most one lock of each kind and takes them in
 * LOCK_ORDER; anything else is a programming error found here, not a deadlock found in production.
 * Waiting is bounded by the role's (or the transaction's) lock_timeout.
 */
export async function lockXact(tx: DbTx, kind: LockKind, ownerId?: string): Promise<void> {
  const name = lockName(kind, ownerId);
  const state = stateOf(tx);
  const rank = LOCK_ORDER.indexOf(kind);
  const held = state.locks.map((lock) => lock.name);
  if (held.includes(name)) return;
  if (state.locks.some((lock) => lock.rank >= rank)) throw new LockOrderError(name, held);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${name}, 0))`);
  state.locks.push({ name, rank });
}

export interface SessionLock {
  release(): Promise<void>;
}

/**
 * The `recovery-sweep` session lock: `pg_try_advisory_lock` on a connection that stays checked out until
 * released, so exactly one worker runs the sweep. Returns null when another session holds it.
 */
export async function tryRecoverySweepLock(pool: pg.Pool): Promise<SessionLock | null> {
  const client = await pool.connect();
  let acquired = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) as locked',
      [RECOVERY_SWEEP_LOCK],
    );
    acquired = result.rows[0]?.locked === true;
  } finally {
    if (!acquired) client.release();
  }
  if (!acquired) return null;
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [
          RECOVERY_SWEEP_LOCK,
        ]);
        client.release();
      } catch (error) {
        client.release(true);
        throw error;
      }
    },
  };
}
