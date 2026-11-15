import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { DatabaseUnavailableError, pgErrorOf } from './errors.js';
import { createPool } from './pools.js';
import type { DbConfig, PoolOptions } from './pools.js';
import { assertRoleTimeouts } from './timeouts.js';
import { UnitOfWork } from './unit-of-work.js';

/** The application pool, the Drizzle query builder over it and the transaction helper. */
export class Database {
  readonly db: NodePgDatabase;
  readonly uow: UnitOfWork;

  constructor(readonly pool: pg.Pool) {
    this.db = drizzle(pool);
    this.uow = new UnitOfWork(this.db);
  }

  /** Startup and readiness check: a connection can be acquired, a query runs, application roles carry their timeouts. */
  async checkReady(): Promise<void> {
    try {
      await this.pool.query('select 1');
    } catch (error) {
      const code = pgErrorOf(error)?.code ?? (error as { code?: unknown }).code;
      throw new DatabaseUnavailableError(
        `cannot run a query (${typeof code === 'string' ? code : 'error'})`,
        {
          cause: error,
        },
      );
    }
    await assertRoleTimeouts(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createDatabase(config: DbConfig, options: PoolOptions = {}): Database {
  return new Database(createPool(config, options));
}
