import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { DbTx } from '../db/index.js';
import { enqueue } from './enqueue.js';
import { tableSql } from './claim.js';
import type { JobTable } from './claim.js';
import type { TxScope } from './at-most-once.js';
import type { SweepHook } from './sweep-registry.js';

export const POLL_QUEUE = 'production.poll';

export interface PollTiming {
  /** POLL_INTERVAL_SEC: the gap between two polls of one job. */
  readonly intervalSec: number;
  /** POLL_LEASE_SEC: how long a running poll holds the job before another may take it. */
  readonly leaseSec: number;
}

type Bossish = Pick<PgBoss, 'send'>;

/** pg-boss `startAfter` with the poll's job id as its singleton key: at most one queued poll per job. */
async function enqueuePoll(
  boss: Bossish,
  tx: DbTx,
  jobId: string,
  delaySec: number,
  queue: string,
): Promise<void> {
  await enqueue(boss, tx, queue, { jobId }, { startAfter: delaySec, singletonKey: jobId });
}

/**
 * Arm the next poll (ARCHITECTURE §5.5): `next_poll_at` is the lease. The row is updated only while it is live, the
 * provider has not completed, and no poll is already due or running (`next_poll_at` null or past), and the poll job
 * is enqueued in the same transaction; so a job has one live poll. Returns false when one already exists.
 */
export async function schedulePoll(
  boss: Bossish,
  tx: DbTx,
  ref: JobTable,
  jobId: string,
  delaySec: number,
  queue: string = POLL_QUEUE,
): Promise<boolean> {
  const armed = await tx.execute(
    sql`update ${tableSql(ref)} set next_poll_at = now() + make_interval(secs => ${delaySec}), updated_at = now()
        where id = ${jobId} and state in ('submitted', 'processing') and provider_completed_at is null
          and (next_poll_at is null or next_poll_at <= now())
        returning id`,
  );
  if (armed.rows.length === 0) return false;
  await enqueuePoll(boss, tx, jobId, delaySec, queue);
  return true;
}

/** What one provider status check reported. */
export type PollResult =
  | { readonly kind: 'pending' }
  /** The provider finished: the output is ready to copy. The deadline stops applying (SB §3.5, TD-D25). */
  | { readonly kind: 'completed' }
  | { readonly kind: 'failed'; readonly cause: string; readonly message?: string };

export type PollOutcome =
  | { readonly kind: 'polled'; readonly result: PollResult['kind'] }
  /** Duplicate or early delivery, or the job is no longer polled: the provider is not called. */
  | { readonly kind: 'skipped' }
  | { readonly kind: 'timed_out' };

export interface RunPollInput {
  readonly boss: Bossish;
  readonly uow: TxScope;
  readonly table: JobTable;
  readonly jobId: string;
  readonly timing: PollTiming;
  /** The provider status call; runs outside any transaction, at most once per lease. */
  readonly call: () => Promise<PollResult>;
  readonly queue?: string;
}

/** Past the deadline with the provider still working: the job fails `provider_timeout`. */
const TIMEOUT_SET = sql`state = 'failed', cause_class = 'provider_timeout', updated_at = now()`;
const OVERDUE = sql`deadline_at is not null and deadline_at <= now() and provider_completed_at is null`;

/**
 * Handle one delivered poll job. The lease is taken first (`next_poll_at` pushed `leaseSec` ahead, only if it is due),
 * so of two deliveries for one job exactly one reaches the provider. A failed call gives the lease back and rethrows
 * so the queue's retry applies.
 */
export async function runPoll(input: RunPollInput): Promise<PollOutcome> {
  const table = tableSql(input.table);
  const queue = input.queue ?? POLL_QUEUE;
  const leased = await input.uow.run(async (tx) => {
    const timedOut = await tx.execute(
      sql`update ${table} set ${TIMEOUT_SET}
          where id = ${input.jobId} and state in ('submitted', 'processing') and ${OVERDUE} returning id`,
    );
    if (timedOut.rows.length === 1) return 'timed_out' as const;
    const taken = await tx.execute(
      sql`update ${table} set next_poll_at = now() + make_interval(secs => ${input.timing.leaseSec}), updated_at = now()
          where id = ${input.jobId} and state in ('submitted', 'processing') and provider_completed_at is null
            and (next_poll_at is null or next_poll_at <= now())
          returning id`,
    );
    return taken.rows.length === 1 ? ('leased' as const) : ('skipped' as const);
  });
  if (leased === 'timed_out') return { kind: 'timed_out' };
  if (leased === 'skipped') return { kind: 'skipped' };

  let result: PollResult;
  try {
    result = await input.call();
  } catch (error) {
    await input.uow.run((tx) =>
      tx.execute(
        sql`update ${table} set next_poll_at = now(), updated_at = now()
            where id = ${input.jobId} and state in ('submitted', 'processing')`,
      ),
    );
    throw error;
  }

  await input.uow.run(async (tx) => {
    if (result.kind === 'pending') {
      const moved = await tx.execute(
        sql`update ${table}
            set state = 'processing', next_poll_at = now() + make_interval(secs => ${input.timing.intervalSec}),
                updated_at = now()
            where id = ${input.jobId} and state in ('submitted', 'processing') returning id`,
      );
      if (moved.rows.length === 1) {
        await enqueuePoll(input.boss, tx, input.jobId, input.timing.intervalSec, queue);
      }
    } else if (result.kind === 'completed') {
      await tx.execute(
        sql`update ${table}
            set state = 'processing', provider_completed_at = now(), next_poll_at = null, updated_at = now()
            where id = ${input.jobId} and state in ('submitted', 'processing')`,
      );
    } else {
      await tx.execute(
        sql`update ${table}
            set state = 'failed', cause_class = ${result.cause}, cause_message = ${result.message ?? null},
                next_poll_at = null, updated_at = now()
            where id = ${input.jobId} and state in ('submitted', 'processing')`,
      );
    }
  });
  return { kind: 'polled', result: result.kind };
}

/**
 * Time out jobs whose provider work outlived `deadline_at`. A row with `provider_completed_at` set is never touched:
 * the deadline bounds the provider's work only, the output copy has its own window.
 */
export async function expireOverdue(tx: DbTx, ref: JobTable): Promise<string[]> {
  const expired = await tx.execute(
    sql`update ${tableSql(ref)} set ${TIMEOUT_SET}
        where state in ('submitted', 'processing') and ${OVERDUE} returning id::text as id`,
  );
  return expired.rows.map((row) => (row as { id: string }).id);
}

/**
 * Sweep hook re-arming polls that were lost (a crash after the lease, a purged job): live rows whose `next_poll_at`
 * is older than `graceSec` get a new poll. One live poll per job still holds, through the lease and the singleton key.
 */
export function pollRearmHook(
  name: string,
  boss: Bossish,
  ref: JobTable,
  timing: PollTiming,
  graceSec: number = timing.leaseSec,
  queue: string = POLL_QUEUE,
): SweepHook {
  return {
    name,
    async run(tx) {
      const expired = await expireOverdue(tx, ref);
      const stalled = await tx.execute(
        sql`select id::text as id from ${tableSql(ref)}
            where state in ('submitted', 'processing') and provider_completed_at is null
              and (next_poll_at is null or next_poll_at <= now() - make_interval(secs => ${graceSec}))
            order by next_poll_at nulls first limit 200`,
      );
      let rearmed = 0;
      for (const row of stalled.rows as { id: string }[]) {
        if (await schedulePoll(boss, tx, ref, row.id, 0, queue)) rearmed += 1;
      }
      return { swept: expired.length + rearmed };
    },
  };
}
