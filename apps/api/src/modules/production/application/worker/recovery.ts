import { sql } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { DbTx } from '../../../../platform/db/index.js';
import { BOSS } from '../../../../platform/jobs/boss.js';
import type { enqueue } from '../../../../platform/jobs/enqueue.js';
import { pollRearmHook } from '../../../../platform/jobs/poll.js';
import type { SweepHook, SweepRegistry } from '../../../../platform/jobs/sweep-registry.js';
import { UsageService } from '../../../usage/index.js';
import { enqueueCopy } from './copy-queue.js';
import { SWEEP_REGISTRY, VIDEO_WORKER_CONFIG } from './ports.js';
import type { VideoWorkerConfig } from './ports.js';
import { VIDEO_TABLE } from './video-submit.job.js';

/** A poll is re-armed once its `next_poll_at` is this far in the past (ARCHITECTURE §5.11). */
export const POLL_REARM_GRACE_SEC = 30;
const BATCH = 200;

type Boss = Parameters<typeof enqueue>[0];
type Usage = Pick<UsageService, 'convertUnconfirmed' | 'release'>;

interface Settled {
  id: string;
  provider_model: string;
}

/**
 * The lock order allows one `spend:` lock per transaction (platform/db/locks.ts) and a sweep hook has one transaction, so a
 * hook that touches the spend ledger settles one owner's rows per run. This many identical hooks run in a row, each taking
 * the first owner still waiting (the one before it has just been settled), so that many owners are settled per tick.
 */
const OWNER_SLOTS = 8;

function perOwner(
  name: string,
  firstOwner: (tx: DbTx) => Promise<string | null>,
  settle: (tx: DbTx, ownerId: string) => Promise<number>,
): SweepHook[] {
  return Array.from({ length: OWNER_SLOTS }, (_, slot) => ({
    name: `${name}-${String(slot + 1)}`,
    async run(tx: DbTx) {
      const ownerId = await firstOwner(tx);
      return { swept: ownerId === null ? 0 : await settle(tx, ownerId) };
    },
  }));
}

const ownerOf = async (tx: DbTx, query: ReturnType<typeof sql>): Promise<string | null> =>
  ((await tx.execute(query)).rows[0] as { owner_id: string } | undefined)?.owner_id ?? null;

/**
 * The production recovery-sweep hooks (ARCHITECTURE §5.5, §5.11), run every minute by `platform.recovery-sweep`:
 * - lost polls are re-armed (a crash after the lease, a purged job) and clips past `deadline_at` with the provider
 *   still working fail `provider_timeout`; a clip the provider finished is never touched by the deadline;
 * - a `submitting` job with no task id after `SUBMIT_ORPHAN_AFTER_SEC` became `outcome_unknown`, its reservation turned
 *   into an unconfirmed usage event in the same transaction, and it is never resubmitted;
 * - a finished clip with no output yet gets its copy job again (a lost job, a worker killed after the commit), and one
 *   past `PROVIDER_OUTPUT_COPY_WINDOW_HOURS` fails `output_unreachable`;
 * - the reservation of a failed or cancelled clip is deleted (the part its first QC would have used).
 * The two hooks that touch the spend ledger settle one owner per run (see `OWNER_SLOTS`).
 */
export function videoRecoveryHooks(deps: {
  readonly boss: Boss;
  readonly usage: Usage;
  readonly config: VideoWorkerConfig;
}): SweepHook[] {
  const { boss, usage, config } = deps;
  const rearm = pollRearmHook(
    'production.video-poll-rearm',
    boss,
    VIDEO_TABLE,
    { intervalSec: config.pollIntervalSec, leaseSec: config.pollLeaseSec },
    POLL_REARM_GRACE_SEC,
  );
  const orphaned = sql`state = 'submitting' and provider_task_id is null
    and submitting_at <= now() - make_interval(secs => ${config.submitOrphanAfterSec})`;
  const orphans = perOwner(
    'production.video-submit-orphans',
    (tx) => ownerOf(tx, sql`select owner_id::text as owner_id from video_jobs where ${orphaned} order by submitting_at limit 1`),
    async (tx, ownerId) => {
      const settled = await tx.execute(
        sql`update video_jobs set state = 'failed', cause_class = 'outcome_unknown', updated_at = now()
            where ${orphaned} and owner_id = ${ownerId} returning id::text as id, provider_model`,
      );
      for (const job of settled.rows as unknown as Settled[]) {
        await usage.convertUnconfirmed(tx, { ownerId, call: { provider: 'wavespeed', operation: job.provider_model }, jobType: 'video', jobId: job.id, callSeq: 1 });
        await usage.release(tx, { ownerId, jobType: 'video', jobId: job.id });
      }
      return settled.rows.length;
    },
  );
  const copies: SweepHook = {
    name: 'production.video-copy',
    async run(tx) {
      const expired = await tx.execute(
        sql`update video_jobs set state = 'failed', cause_class = 'output_unreachable',
                cause_message = 'The clip could not be copied from the provider in time.', updated_at = now()
            where state = 'processing' and provider_completed_at is not null and output_media_id is null
              and provider_completed_at < now() - make_interval(hours => ${config.copyWindowHours})
            returning id::text as id`,
      );
      const open = await tx.execute(
        sql`select id::text as id from video_jobs
            where state = 'processing' and provider_completed_at is not null and output_media_id is null
            order by provider_completed_at limit ${BATCH}`,
      );
      let enqueued = 0;
      for (const row of open.rows as { id: string }[]) if (await enqueueCopy(boss, tx, row.id)) enqueued += 1;
      return { swept: expired.rows.length + enqueued };
    },
  };
  const terminal = sql`from video_jobs j join spend_reservations r on r.job_type = 'video' and r.job_id = j.id
    where j.state in ('failed', 'cancelled')`;
  const reservations = perOwner(
    'production.video-reservations',
    (tx) => ownerOf(tx, sql`select j.owner_id::text as owner_id ${terminal} limit 1`),
    async (tx, ownerId) => {
      const jobs = await tx.execute(sql`select j.id::text as id ${terminal} and j.owner_id = ${ownerId} limit ${BATCH}`);
      for (const { id } of jobs.rows as { id: string }[]) await usage.release(tx, { ownerId, jobType: 'video', jobId: id });
      return jobs.rows.length;
    },
  );
  return [rearm, ...orphans, copies, ...reservations];
}

/** Registers the hooks with the worker's sweep registry when the module starts; a hook already registered is left alone. */
@Injectable()
export class ProductionRecovery implements OnModuleInit {
  constructor(
    @Inject(SWEEP_REGISTRY) private readonly registry: SweepRegistry,
    @Inject(BOSS) private readonly boss: Boss,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(VIDEO_WORKER_CONFIG) private readonly config: VideoWorkerConfig,
  ) {}

  onModuleInit(): void {
    const known = new Set(this.registry.names());
    for (const hook of videoRecoveryHooks({ boss: this.boss, usage: this.usage, config: this.config })) {
      if (!known.has(hook.name)) this.registry.register(hook);
    }
  }
}
