import type pg from 'pg';
import { tryRecoverySweepLock } from '../db/index.js';
import type { DbTx, SessionLock } from '../db/index.js';
import type { SweepHookResult, SweepRegistry } from './sweep-registry.js';

export const SWEEP_QUEUE = 'platform.recovery-sweep';

export interface SweepLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface SweepDeps {
  readonly registry: SweepRegistry;
  /** One transaction per hook (`UnitOfWork.run` satisfies it). */
  readonly inTx: <T>(fn: (tx: DbTx) => Promise<T>) => Promise<T>;
  readonly log: SweepLog;
  /** The session lock that makes one worker sweep at a time; defaults to `pg_try_advisory_lock('recovery-sweep')`. */
  readonly acquire: () => Promise<SessionLock | null>;
}

export type SweepRun =
  /** Another worker holds the lock: this tick does nothing. */
  | { readonly kind: 'skipped' }
  | {
      readonly kind: 'ran';
      readonly results: readonly SweepHookResult[];
      readonly durationMs: number;
    };

export function sweepLockOf(pool: pg.Pool): SweepDeps['acquire'] {
  return () => tryRecoverySweepLock(pool);
}

/**
 * One recovery sweep (ARCHITECTURE §5.11 F-SWEEP): take the session lock without waiting, run every registered hook,
 * release. A tick that cannot take the lock is skipped, never queued; a failing hook is logged and does not stop
 * the others (the registry isolates each in its own transaction).
 */
export async function runRecoverySweep(deps: SweepDeps): Promise<SweepRun> {
  const lock = await deps.acquire();
  if (lock === null) {
    deps.log.info(
      { module: 'worker', outcome: 'skipped' },
      'recovery sweep skipped: another worker holds the lock',
    );
    return { kind: 'skipped' };
  }
  const started = Date.now();
  try {
    const results = await deps.registry.runAll(deps.inTx);
    const failed = results.filter((result) => result.error !== undefined);
    for (const result of failed) {
      deps.log.warn(
        { module: 'worker', jobType: result.name, outcome: 'error' },
        `sweep hook failed: ${result.error ?? ''}`,
      );
    }
    const swept = results.reduce((sum, result) => sum + result.swept, 0);
    deps.log.info(
      {
        module: 'worker',
        outcome: failed.length === 0 ? 'ok' : 'error',
        durationMs: Date.now() - started,
      },
      `recovery sweep finished: ${String(swept)} settled`,
    );
    return { kind: 'ran', results, durationMs: Date.now() - started };
  } finally {
    await lock.release();
  }
}
