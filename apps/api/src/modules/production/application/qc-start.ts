import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DbTx } from '../../../platform/db/index.js';
import { enqueue } from '../../../platform/jobs/enqueue.js';
import { newId } from '../../../platform/shared-kernel/index.js';
import { QC_RUN_QUEUE } from './qc-run.job.js';

/** A QC run's provider work is bounded at 10 minutes (ARCHITECTURE §5.5). */
export const QC_DEADLINE_MINUTES = 10;

/** One live run per `(owner, reuse hash)`: the hash is unique per run, so a re-run is a new row and a finished run stays. */
export const qcReuseHash = (videoJobId: string, runId: string | 'first'): string =>
  createHash('sha256').update(`qc:${videoJobId}:${runId}`).digest('hex');

type Boss = Parameters<typeof enqueue>[0];

/**
 * The first QC of a completed clip (ARCHITECTURE §5.6), in the transaction that completes the clip: system-created, no cap
 * refusal (its estimate was reserved with the clip) and no key stamped, so the handler uses whatever OpenAI key the owner
 * has when it runs. Once per clip: a clip that already has a run gets none. Returns the run ID, or null when none was made.
 */
export async function startFirstQc(boss: Boss, tx: DbTx, input: { readonly ownerId: string; readonly videoJobId: string }): Promise<string | null> {
  const id = newId();
  const inserted = await tx.execute(
    sql`insert into qc_runs (id, owner_id, video_job_id, reuse_hash, deadline_at)
        select ${id}, ${input.ownerId}, ${input.videoJobId}, ${qcReuseHash(input.videoJobId, 'first')},
               now() + make_interval(mins => ${QC_DEADLINE_MINUTES})
        where not exists (select 1 from qc_runs where video_job_id = ${input.videoJobId})
        returning id::text`,
  );
  if (inserted.rows.length === 0) return null;
  await enqueue(boss, tx, QC_RUN_QUEUE, { runId: id }, { singletonKey: id });
  return id;
}
