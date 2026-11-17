import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import { mediaObjects } from '../../../database/schema/media.js';
import type { DbTx } from '../../../platform/db/index.js';
import type { MediaRecord } from '../application/ports.js';
import type { RejectReason } from '../worker/image-sanitize.port.js';
import type { MediaMaintenanceRepository } from '../worker/maintenance.js';
import { toRecord } from './media.repository.js';

export class DrizzleMediaMaintenance implements MediaMaintenanceRepository {
  async lockRow(tx: DbTx, id: string): Promise<MediaRecord | null> {
    const rows = await tx.select().from(mediaObjects).where(eq(mediaObjects.id, id)).for('update');
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async markReady(
    tx: DbTx,
    id: string,
    ready: {
      storageKey: string;
      bytes: number;
      contentType: string;
      width: number;
      height: number;
    },
  ): Promise<void> {
    await tx
      .update(mediaObjects)
      .set({ state: 'ready', ...ready })
      .where(and(eq(mediaObjects.id, id), eq(mediaObjects.state, 'processing')));
  }

  async markRejected(tx: DbTx, id: string, reason: RejectReason): Promise<void> {
    await tx
      .update(mediaObjects)
      .set({ state: 'rejected', rejectReason: reason, bytes: 0 })
      .where(and(eq(mediaObjects.id, id), eq(mediaObjects.state, 'processing')));
  }

  async listUnattachedBefore(
    tx: DbTx,
    cutoff: Date,
    limit: number,
  ): Promise<{ id: string; ownerId: string }[]> {
    return tx
      .select({ id: mediaObjects.id, ownerId: mediaObjects.ownerId })
      .from(mediaObjects)
      .where(
        and(
          eq(mediaObjects.kind, 'upload'),
          isNull(mediaObjects.attachedAt),
          lt(mediaObjects.createdAt, cutoff),
        ),
      )
      .orderBy(asc(mediaObjects.createdAt))
      .limit(limit);
  }

  async listByCampaign(
    tx: DbTx,
    campaignId: string,
    limit: number,
  ): Promise<{ id: string; ownerId: string }[]> {
    return tx
      .select({ id: mediaObjects.id, ownerId: mediaObjects.ownerId })
      .from(mediaObjects)
      .where(eq(mediaObjects.campaignId, campaignId))
      .orderBy(asc(mediaObjects.createdAt))
      .limit(limit);
  }

  async jobAttempts(
    tx: DbTx,
    queue: string,
    jobId: string,
  ): Promise<{ retryCount: number; retryLimit: number } | null> {
    const result = await tx.execute(
      sql`select retry_count, retry_limit from pgboss.job where name = ${queue} and id = ${jobId}::uuid`,
    );
    const row = result.rows[0] as { retry_count: number; retry_limit: number } | undefined;
    return row === undefined ? null : { retryCount: row.retry_count, retryLimit: row.retry_limit };
  }
}
