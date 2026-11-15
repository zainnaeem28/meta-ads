import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { NestedTransactionError, normalizeDbError } from './errors.js';
import { TxState, currentTxState, runInTransaction } from './tx-state.js';

/** The handle every owner module receives: a Drizzle transaction. Cross-module use cases pass it along. */
export type DbTx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

export interface TxOptions {
  /** `SET LOCAL lock_timeout` for this transaction; the role default applies when absent. */
  readonly lockTimeoutMs?: number;
  /** `SET LOCAL statement_timeout` for this transaction (the report query uses 15 s). */
  readonly statementTimeoutMs?: number;
}

export interface TxRunner {
  transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>;
}

function assertMillis(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
}

/**
 * One transaction per use case (READ COMMITTED), owned by the application service. While `fn` runs, the
 * egress guard knows a transaction is open, so a network call made through a guarded adapter fails fast.
 */
export class UnitOfWork {
  constructor(private readonly db: TxRunner) {}

  async run<T>(fn: (tx: DbTx) => Promise<T>, options: TxOptions = {}): Promise<T> {
    if (currentTxState() !== undefined) throw new NestedTransactionError();
    try {
      return await this.db.transaction((tx) =>
        runInTransaction(tx, new TxState(), async () => {
          if (options.lockTimeoutMs !== undefined) {
            await tx.execute(
              sql`select set_config('lock_timeout', ${String(assertMillis('lockTimeoutMs', options.lockTimeoutMs))}, true)`,
            );
          }
          if (options.statementTimeoutMs !== undefined) {
            await tx.execute(
              sql`select set_config('statement_timeout', ${String(assertMillis('statementTimeoutMs', options.statementTimeoutMs))}, true)`,
            );
          }
          return fn(tx);
        }),
      );
    } catch (error) {
      throw normalizeDbError(error);
    }
  }
}
