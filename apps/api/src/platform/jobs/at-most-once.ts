import { sql } from 'drizzle-orm';
import type { DbTx } from '../db/index.js';
import { claimWithUserLimit, tableSql } from './claim.js';
import type { ClaimOptions, JobTable } from './claim.js';
import type { SweepHook } from './sweep-registry.js';

/** SB §3.5 cause classes a submit can end in. */
export type SubmitFailureCause = 'temporary' | 'configuration' | 'credit' | 'outcome_unknown';

/**
 * What the provider call reports. `accepted` carries the provider's task id. `rejected` is a definitive, unbilled
 * refusal (4xx with no task: SB-D9). `unknown` is anything after the request may have been sent (5xx, timeout,
 * dropped connection); a thrown error counts as `unknown` too.
 */
export type SubmitResult =
  | { readonly kind: 'accepted'; readonly taskId: string }
  | {
      readonly kind: 'rejected';
      readonly cause: Exclude<SubmitFailureCause, 'outcome_unknown'>;
      readonly message?: string;
    }
  | { readonly kind: 'unknown'; readonly message?: string };

/** The one place a transaction is opened: `UnitOfWork` satisfies it. */
export interface TxScope {
  run<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>;
}

export type SubmitOutcome =
  | { readonly kind: 'submitted'; readonly taskId: string }
  | { readonly kind: 'rejected'; readonly cause: SubmitFailureCause }
  | { readonly kind: 'outcome_unknown' }
  /** The task id came after the sweep had already settled the row as `outcome_unknown`: recorded, never revived. */
  | { readonly kind: 'late_task_id'; readonly taskId: string }
  | { readonly kind: 'held' }
  | { readonly kind: 'skipped' };

export interface SubmitOnceInput extends ClaimOptions {
  readonly uow: TxScope;
  readonly table: JobTable;
  readonly jobId: string;
  /** The provider call. Runs outside any transaction, after `submitting` has been committed; it is called at most once. */
  readonly call: () => Promise<SubmitResult>;
  /** Runs in the transaction that records the task id, so the first poll is scheduled with it (or neither). */
  readonly afterAccepted?: (tx: DbTx, taskId: string) => Promise<void>;
}

/**
 * The at-most-once submit (ARCHITECTURE §5.5, SB-D4, REQ-009):
 * 1. claim (`pending` to `submitting`) and commit, before anything leaves the process;
 * 2. call the provider once, outside a transaction; a job already past `pending` never reaches this step again,
 *    so a redelivery, a second worker or a restart cannot submit twice;
 * 3. record the answer. A crash between 2 and 3 leaves `submitting` with no task id, which `sweepSubmitOrphans`
 *    settles as `outcome_unknown` after SUBMIT_ORPHAN_AFTER; it is never resubmitted.
 */
export async function submitOnce(input: SubmitOnceInput): Promise<SubmitOutcome> {
  const claimOptions: ClaimOptions = input.limit === undefined ? {} : { limit: input.limit };
  const claim = await input.uow.run((tx) =>
    claimWithUserLimit(tx, input.table, input.jobId, claimOptions),
  );
  if (claim.kind === 'held') return { kind: 'held' };
  if (claim.kind === 'not_pending') return { kind: 'skipped' };

  let result: SubmitResult;
  try {
    result = await input.call();
  } catch {
    result = { kind: 'unknown' };
  }
  return input.uow.run((tx) =>
    settleSubmit(tx, input.table, input.jobId, result, input.afterAccepted),
  );
}

async function settleSubmit(
  tx: DbTx,
  ref: JobTable,
  jobId: string,
  result: SubmitResult,
  afterAccepted?: (tx: DbTx, taskId: string) => Promise<void>,
): Promise<SubmitOutcome> {
  const table = tableSql(ref);
  if (result.kind === 'accepted') {
    const moved = await tx.execute(
      sql`update ${table} set state = 'submitted', provider_task_id = ${result.taskId}, updated_at = now()
          where id = ${jobId} and state = 'submitting' and provider_task_id is null returning id`,
    );
    if (moved.rows.length === 1) {
      await afterAccepted?.(tx, result.taskId);
      return { kind: 'submitted', taskId: result.taskId };
    }
    // Settled while the call was in flight (orphan sweep, cancellation): record the id so the provider's work is
    // known and can be confirmed or deleted, but never move the row forward again.
    const late = await tx.execute(
      sql`update ${table} set provider_task_id = ${result.taskId}, updated_at = now()
          where id = ${jobId} and provider_task_id is null returning id`,
    );
    return late.rows.length === 1
      ? { kind: 'late_task_id', taskId: result.taskId }
      : { kind: 'skipped' };
  }
  const cause: SubmitFailureCause = result.kind === 'rejected' ? result.cause : 'outcome_unknown';
  const message = result.message ?? null;
  const failed = await tx.execute(
    sql`update ${table} set state = 'failed', cause_class = ${cause}, cause_message = ${message}, updated_at = now()
        where id = ${jobId} and state = 'submitting' returning id`,
  );
  if (failed.rows.length === 0) return { kind: 'skipped' };
  return cause === 'outcome_unknown' ? { kind: 'outcome_unknown' } : { kind: 'rejected', cause };
}

/**
 * The orphan sweep: a row still `submitting` with no task id after `orphanAfterSec` (SUBMIT_ORPHAN_AFTER_SEC) lost
 * its answer. It becomes `failed` / `outcome_unknown` and is never resubmitted; the owning module records the
 * unconfirmed usage estimate (SB-D9) for the ids returned.
 */
export async function sweepSubmitOrphans(
  tx: DbTx,
  ref: JobTable,
  orphanAfterSec: number,
): Promise<string[]> {
  if (!Number.isFinite(orphanAfterSec) || orphanAfterSec < 0) {
    throw new Error('orphanAfterSec must be a non-negative number');
  }
  const swept = await tx.execute(
    sql`update ${tableSql(ref)} set state = 'failed', cause_class = 'outcome_unknown', updated_at = now()
        where state = 'submitting' and provider_task_id is null
          and submitting_at <= now() - make_interval(secs => ${orphanAfterSec})
        returning id::text as id`,
  );
  return swept.rows.map((row) => (row as { id: string }).id);
}

/** The orphan sweep as a hook a job-owning module registers (`sweep-registry.ts`). */
export function submitOrphanHook(
  name: string,
  ref: JobTable,
  orphanAfterSec: number,
  onSwept?: (ids: readonly string[], tx: DbTx) => Promise<void>,
): SweepHook {
  return {
    name,
    async run(tx) {
      const ids = await sweepSubmitOrphans(tx, ref, orphanAfterSec);
      if (ids.length > 0) await onSwept?.(ids, tx);
      return { swept: ids.length };
    },
  };
}
