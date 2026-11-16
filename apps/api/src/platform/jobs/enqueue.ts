import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgBoss, SendOptions } from 'pg-boss';
import type { DbTx } from '../db/index.js';
import { queueNamed } from './queues.js';

type IDatabase = NonNullable<SendOptions['db']>;

export class UnknownQueueError extends Error {
  constructor(name: string) {
    super(`queue ${name} is not in the catalogue (platform/jobs/queues.ts)`);
    this.name = 'UnknownQueueError';
  }
}

export class RetryOnSubmitQueueError extends Error {
  constructor(name: string) {
    super(`queue ${name} is a submit queue: retryLimit is 0 and cannot be raised per job`);
    this.name = 'RetryOnSubmitQueueError';
  }
}

/** Turns pg-boss's `$1`-style statement into a parameterised Drizzle statement. */
function statement(text: string, values: readonly unknown[]): SQL {
  const parts = text.split(/\$(\d+)/);
  const chunks: SQL[] = [];
  parts.forEach((part, index) => {
    if (index % 2 === 0) {
      if (part !== '') chunks.push(sql.raw(part));
    } else {
      chunks.push(sql`${sql.param(values[Number(part) - 1])}`);
    }
  });
  return sql.join(chunks, sql.raw(''));
}

/** The caller's transaction as the database handle pg-boss writes through, so a job commits and rolls back with it. */
export function onTransaction(tx: DbTx): IDatabase {
  return {
    async executeSql(text, values = []) {
      const result = await tx.execute(statement(text, values));
      return { rows: result.rows as never[] };
    },
  };
}

export type EnqueueOptions = Omit<SendOptions, 'db'>;

/**
 * Enqueue a job on the caller's transaction (ADR-003): it exists only if the transaction commits. Returns the job
 * id, or null when a singleton or throttle rule suppressed it. The queue must be in the catalogue, and a submit
 * queue's single attempt cannot be raised per job.
 */
export async function enqueue(
  boss: Pick<PgBoss, 'send'>,
  tx: DbTx,
  name: string,
  data: object | null,
  options: EnqueueOptions = {},
): Promise<string | null> {
  const queue = queueNamed(name);
  if (queue === undefined) throw new UnknownQueueError(name);
  if (queue.retryLimit === 0 && (options.retryLimit ?? 0) > 0) {
    throw new RetryOnSubmitQueueError(name);
  }
  return boss.send(name, data, { ...options, db: onTransaction(tx) });
}
