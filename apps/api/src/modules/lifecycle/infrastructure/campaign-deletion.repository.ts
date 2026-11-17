import { and, eq, inArray, sql } from 'drizzle-orm';
import { briefJobs } from '../../../database/schema/brief.js';
import { campaigns } from '../../../database/schema/campaigns.js';
import { deletionRuns } from '../../../database/schema/lifecycle.js';
import type { DbTx } from '../../../platform/db/index.js';
import type {
  CampaignDeletionRepository,
  CancelledBriefJob,
} from '../application/campaign-deletion-ports.js';
import type { DeletionRun, RunState } from '../domain/campaign-deletion.js';

const BRIEF_NON_TERMINAL = ['pending', 'submitting', 'submitted', 'processing'];

function runOf(row: typeof deletionRuns.$inferSelect): DeletionRun {
  return {
    id: row.id,
    kind: row.kind as DeletionRun['kind'],
    subjectId: row.subjectId,
    ownerId: row.ownerId,
    step: row.step,
    state: row.state as RunState,
    attempts: row.attempts,
    remainingObjects: row.remainingObjects,
    lastErrorClass: row.lastErrorClass,
    notBefore: row.notBefore,
    createdAt: row.createdAt,
  };
}

/** Drizzle adapter of the deletion run and of the two statements the request makes on other modules' tables. */
export class DrizzleCampaignDeletionRepository implements CampaignDeletionRepository {
  async markDeleting(tx: DbTx, ownerId: string, campaignId: string): Promise<boolean> {
    const rows = await tx
      .update(campaigns)
      .set({ state: 'deleting', updatedAt: sql`now()` })
      .where(
        and(
          eq(campaigns.id, campaignId),
          eq(campaigns.ownerId, ownerId),
          eq(campaigns.state, 'active'),
        ),
      )
      .returning({ id: campaigns.id });
    return rows.length === 1;
  }

  async cancelBriefJobs(
    tx: DbTx,
    ownerId: string,
    campaignId: string,
  ): Promise<CancelledBriefJob[]> {
    const live = await tx
      .select({ id: briefJobs.id, state: briefJobs.state, callCount: briefJobs.callCount })
      .from(briefJobs)
      .where(
        and(
          eq(briefJobs.ownerId, ownerId),
          eq(briefJobs.campaignId, campaignId),
          inArray(briefJobs.state, BRIEF_NON_TERMINAL),
        ),
      )
      .for('update');
    if (live.length === 0) return [];
    await tx
      .update(briefJobs)
      .set({
        state: 'cancelled',
        causeClass: 'cancelled_campaign_deleted',
        causeMessage: 'The campaign was deleted.',
        updatedAt: sql`now()`,
      })
      .where(
        inArray(
          briefJobs.id,
          live.map((job) => job.id),
        ),
      );
    return live;
  }

  async insertRun(
    tx: DbTx,
    run: { id: string; ownerId: string; campaignId: string },
  ): Promise<void> {
    await tx.insert(deletionRuns).values({
      id: run.id,
      kind: 'campaign',
      subjectId: run.campaignId,
      ownerId: run.ownerId,
      step: 1,
      state: 'running',
    });
  }

  async findRun(tx: DbTx, runId: string): Promise<DeletionRun | null> {
    const [row] = await tx.select().from(deletionRuns).where(eq(deletionRuns.id, runId));
    return row === undefined ? null : runOf(row);
  }

  async advance(
    tx: DbTx,
    runId: string,
    patch: { step: number; remainingObjects?: number | null; notBeforeInMs?: number },
  ): Promise<void> {
    await tx
      .update(deletionRuns)
      .set({
        step: patch.step,
        attempts: 0,
        lastErrorClass: null,
        ...(patch.remainingObjects === undefined
          ? {}
          : { remainingObjects: patch.remainingObjects }),
        ...(patch.notBeforeInMs === undefined
          ? {}
          : { notBefore: sql`now() + make_interval(secs => ${patch.notBeforeInMs / 1000})` }),
        updatedAt: sql`now()`,
      })
      .where(and(eq(deletionRuns.id, runId), eq(deletionRuns.state, 'running')));
  }

  async recordFailure(tx: DbTx, runId: string, errorClass: string): Promise<number> {
    const [row] = await tx
      .update(deletionRuns)
      .set({
        attempts: sql`${deletionRuns.attempts} + 1`,
        lastErrorClass: errorClass,
        updatedAt: sql`now()`,
      })
      .where(and(eq(deletionRuns.id, runId), eq(deletionRuns.state, 'running')))
      .returning({ attempts: deletionRuns.attempts });
    return row?.attempts ?? 0;
  }

  async markStuck(tx: DbTx, runId: string): Promise<void> {
    await tx
      .update(deletionRuns)
      .set({ state: 'stuck', updatedAt: sql`now()` })
      .where(and(eq(deletionRuns.id, runId), eq(deletionRuns.state, 'running')));
  }

  async hardDeleteCampaign(tx: DbTx, campaignId: string): Promise<void> {
    await tx
      .delete(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.state, 'deleting')));
  }

  async complete(tx: DbTx, runId: string): Promise<void> {
    await tx
      .update(deletionRuns)
      .set({ state: 'completed', remainingObjects: 0, lastErrorClass: null, updatedAt: sql`now()` })
      .where(and(eq(deletionRuns.id, runId), eq(deletionRuns.state, 'running')));
  }

  async setRemaining(tx: DbTx, runId: string, remaining: number): Promise<void> {
    await tx
      .update(deletionRuns)
      .set({ remainingObjects: remaining, updatedAt: sql`now()` })
      .where(eq(deletionRuns.id, runId));
  }
}
