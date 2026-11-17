import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DbTx } from '../../../platform/db/index.js';
import { BOSS } from '../../../platform/jobs/boss.js';
import { enqueue } from '../../../platform/jobs/enqueue.js';
import type { SweepHook, SweepRegistry } from '../../../platform/jobs/sweep-registry.js';
import { UsageService } from '../../usage/index.js';
import { QC_CONFIG } from './qc-ports.js';
import type { QcConfig } from './qc-ports.js';
import { QC_RUN_QUEUE } from './qc-run.job.js';
import { SWEEP_REGISTRY } from './worker/ports.js';

const BATCH = 200;
/** The lock order allows one `spend:` lock per transaction, so a hook that touches the ledger settles one owner per run. */
const OWNER_SLOTS = 8;

type Boss = Parameters<typeof enqueue>[0];
type Usage = Pick<UsageService, 'convertUnconfirmed' | 'release'>;

const INTERRUPTED = 'The check was interrupted. Re-run QC.';
const NOT_STARTED = 'The check did not start in time. Re-run QC.';

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

interface Settled {
  id: string;
  video_job_id: string;
  call_count: number;
}

/**
 * The QC recovery-sweep hooks (ARCHITECTURE §5.6, §5.11), run every minute by `platform.recovery-sweep`:
 * - a `pending` run whose queue message was lost gets one again; one still `pending` past its deadline ends `skipped`;
 * - a run still `submitting` after `SUBMIT_ORPHAN_AFTER_SEC` lost its answer: it ends `skipped` ("interrupted"), a call that
 *   may have been sent keeps its estimate counted (unconfirmed), and it is never repeated.
 * Each settled run releases its reservation and the clip's QC part. The two hooks that touch the ledger settle one owner per run.
 */
export function qcRecoveryHooks(deps: { readonly boss: Boss; readonly usage: Usage; readonly config: QcConfig }): SweepHook[] {
  const { boss, usage, config } = deps;
  const requeue: SweepHook = {
    name: 'production.qc-requeue',
    async run(tx) {
      const waiting = await tx.execute(
        sql`select q.id::text as id from qc_runs q
            where q.state = 'pending' and q.deadline_at > now()
              and q.created_at < now() - make_interval(secs => ${config.requeueAfterSec})
              and not exists (select 1 from pgboss.job j where j.name = ${QC_RUN_QUEUE} and j.singleton_key = q.id::text and j.state in ('created', 'retry', 'active'))
            order by q.created_at limit ${BATCH}`,
      );
      let enqueued = 0;
      for (const { id } of waiting.rows as { id: string }[]) {
        if ((await enqueue(boss, tx, QC_RUN_QUEUE, { runId: id }, { singletonKey: id })) !== null) enqueued += 1;
      }
      return { swept: enqueued };
    },
  };
  const finish = async (tx: DbTx, ownerId: string, settled: readonly Settled[]): Promise<void> => {
    for (const run of settled) {
      if (run.call_count > 0) {
        await usage.convertUnconfirmed(tx, { ownerId, call: { provider: 'openai', operation: config.transcribeModel }, jobType: 'qc', jobId: run.id, callSeq: 1 });
      }
      await usage.release(tx, { ownerId, jobType: 'qc', jobId: run.id });
      await usage.release(tx, { ownerId, jobType: 'video', jobId: run.video_job_id });
    }
  };
  const orphaned = sql`state = 'submitting' and submitting_at <= now() - make_interval(secs => ${config.orphanAfterSec})`;
  const orphans = perOwner(
    'production.qc-orphans',
    (tx) => ownerOf(tx, sql`select owner_id::text as owner_id from qc_runs where ${orphaned} order by submitting_at limit 1`),
    async (tx, ownerId) => {
      const settled = await tx.execute(
        sql`update qc_runs set state = 'completed', qc_state = 'skipped', reason = ${INTERRUPTED}, last_error_code = 'outcome_unknown', updated_at = now()
            where ${orphaned} and owner_id = ${ownerId} returning id::text as id, video_job_id::text as video_job_id, call_count`,
      );
      await finish(tx, ownerId, settled.rows as unknown as Settled[]);
      return settled.rows.length;
    },
  );
  const late = sql`state = 'pending' and deadline_at <= now()`;
  const expired = perOwner(
    'production.qc-expired',
    (tx) => ownerOf(tx, sql`select owner_id::text as owner_id from qc_runs where ${late} order by deadline_at limit 1`),
    async (tx, ownerId) => {
      const settled = await tx.execute(
        sql`update qc_runs set state = 'completed', qc_state = 'skipped', reason = ${NOT_STARTED}, last_error_code = 'provider_timeout', updated_at = now()
            where ${late} and owner_id = ${ownerId} returning id::text as id, video_job_id::text as video_job_id, call_count`,
      );
      await finish(tx, ownerId, settled.rows as unknown as Settled[]);
      return settled.rows.length;
    },
  );
  return [requeue, ...orphans, ...expired];
}

/** Registers the hooks with the worker's sweep registry when the module starts; a hook already registered is left alone. */
@Injectable()
export class QcRecovery implements OnModuleInit {
  constructor(
    @Inject(SWEEP_REGISTRY) private readonly registry: SweepRegistry,
    @Inject(BOSS) private readonly boss: Boss,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(QC_CONFIG) private readonly config: QcConfig,
  ) {}

  onModuleInit(): void {
    const known = new Set(this.registry.names());
    for (const hook of qcRecoveryHooks({ boss: this.boss, usage: this.usage, config: this.config })) {
      if (!known.has(hook.name)) this.registry.register(hook);
    }
  }
}
