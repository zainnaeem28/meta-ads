import { sql } from 'drizzle-orm';
import type { DbTx } from '../../../../platform/db/index.js';
import { enqueue } from '../../../../platform/jobs/enqueue.js';

export const COPY_QUEUE = 'video.copy-output';

/**
 * Enqueues the output copy of a job, once: the job ID is the singleton key, and a copy job already waiting, retrying or
 * running for it means this is not enqueued again (pg-boss itself does not enforce a singleton key on a standard queue).
 */
export async function enqueueCopy(boss: Parameters<typeof enqueue>[0], tx: DbTx, jobId: string): Promise<boolean> {
  const open = await tx.execute(
    sql`select 1 from pgboss.job where name = ${COPY_QUEUE} and singleton_key = ${jobId} and state in ('created', 'retry', 'active') limit 1`,
  );
  if (open.rows.length > 0) return false;
  return (await enqueue(boss, tx, COPY_QUEUE, { jobId }, { singletonKey: jobId })) !== null;
}
