import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { assemblyJobs } from '../../../../database/schema/production-assembly.js';
import { BOSS } from '../../../../platform/jobs/boss.js';
import { enqueue } from '../../../../platform/jobs/enqueue.js';
import type { SweepHook, SweepRegistry } from '../../../../platform/jobs/sweep-registry.js';
import { ASSEMBLY_RENDER_QUEUE } from '../assembly.service.js';
import { ASSEMBLY_WORKER_CONFIG } from './assembly-ports.js';
import type { AssemblyWorkerConfig } from './assembly-ports.js';
import { ASSEMBLY_MESSAGES } from './assembly-render.job.js';
import { SWEEP_REGISTRY } from './ports.js';

const BATCH = 100;

type Boss = Parameters<typeof enqueue>[0];

/**
 * The assembly recovery-sweep hooks (ARCHITECTURE §5.7, §5.11), run every minute by `platform.recovery-sweep`:
 * - a job still `pending` or `queued` whose queue message is gone gets one again;
 * - a job in a working state whose lease ran out (its worker died) gets a message too, and the handler resumes it from
 *   `fetching`; one that has used all its attempts ends `render_failed` instead.
 * A message is not added while one is waiting, retrying or running for the job.
 */
export function assemblyRecoveryHooks(deps: { readonly boss: Boss; readonly config: AssemblyWorkerConfig }): SweepHook[] {
  const { boss, config } = deps;
  const noMessage = sql`not exists (select 1 from pgboss.job p where p.name = ${ASSEMBLY_RENDER_QUEUE} and (p.singleton_key = a.id::text or p.data->>'jobId' = a.id::text) and p.state in ('created', 'retry', 'active'))`;
  const send = async (tx: Parameters<SweepHook['run']>[0], ids: readonly string[]): Promise<number> => {
    let enqueued = 0;
    for (const id of ids) {
      if ((await enqueue(boss, tx, ASSEMBLY_RENDER_QUEUE, { jobId: id }, { singletonKey: id })) !== null) enqueued += 1;
    }
    return enqueued;
  };
  const requeue: SweepHook = {
    name: 'production.assembly-requeue',
    async run(tx) {
      const waiting = await tx.execute(
        sql`select a.id::text as id from assembly_jobs a
            where a.state in ('pending', 'queued') and a.attempts < ${config.maxAttempts}
              and a.updated_at < now() - make_interval(secs => ${config.requeueAfterSec}) and ${noMessage}
            order by a.updated_at limit ${BATCH}`,
      );
      const ids = (waiting.rows as { id: string }[]).map((row) => row.id);
      if (ids.length > 0) await tx.update(assemblyJobs).set({ state: 'queued', updatedAt: sql`now()` }).where(and(inArray(assemblyJobs.id, ids), eq(assemblyJobs.state, 'pending')));
      return { swept: await send(tx, ids) };
    },
  };
  const resume: SweepHook = {
    name: 'production.assembly-resume',
    async run(tx) {
      const abandoned = await tx.execute(
        sql`select a.id::text as id from assembly_jobs a
            where a.state in ('fetching', 'rendering', 'saving') and coalesce(a.lease_until, '-infinity') < now()
              and a.attempts < ${config.maxAttempts} and ${noMessage}
            order by a.lease_until limit ${BATCH}`,
      );
      return { swept: await send(tx, (abandoned.rows as { id: string }[]).map((row) => row.id)) };
    },
  };
  const exhausted: SweepHook = {
    name: 'production.assembly-exhausted',
    async run(tx) {
      const spent = await tx.execute(
        sql`update assembly_jobs set state = 'failed', cause_class = 'render_failed', cause_message = ${ASSEMBLY_MESSAGES.interrupted},
              lease_until = null, updated_at = now()
            where attempts >= ${config.maxAttempts}
              and (state in ('pending', 'queued') or (state in ('fetching', 'rendering', 'saving') and coalesce(lease_until, '-infinity') < now()))
            returning id`,
      );
      return { swept: spent.rows.length };
    },
  };
  return [requeue, resume, exhausted];
}

/** Registers the hooks with the worker's sweep registry when the module starts; a hook already registered is left alone. */
@Injectable()
export class AssemblyRecovery implements OnModuleInit {
  constructor(
    @Inject(SWEEP_REGISTRY) private readonly registry: SweepRegistry,
    @Inject(BOSS) private readonly boss: Boss,
    @Inject(ASSEMBLY_WORKER_CONFIG) private readonly config: AssemblyWorkerConfig,
  ) {}

  onModuleInit(): void {
    const known = new Set(this.registry.names());
    for (const hook of assemblyRecoveryHooks({ boss: this.boss, config: this.config })) {
      if (!known.has(hook.name)) this.registry.register(hook);
    }
  }
}
