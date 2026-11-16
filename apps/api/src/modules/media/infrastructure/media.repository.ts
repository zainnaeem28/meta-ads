import { eq, sql } from 'drizzle-orm';
import { mediaObjects, storageUsage } from '../../../database/schema/media.js';
import type { DbTx } from '../../../platform/db/index.js';
import type {
  MediaKind,
  MediaRecord,
  MediaRepository,
  MediaState,
  NewMedia,
} from '../application/ports.js';

type Row = typeof mediaObjects.$inferSelect;

function toRecord(row: Row): MediaRecord {
  return {
    id: row.id,
    ownerId: row.ownerId,
    kind: row.kind as MediaKind,
    state: row.state as MediaState,
    storageKey: row.storageKey,
    bytes: row.bytes,
    contentType: row.contentType,
    width: row.width,
    height: row.height,
    campaignId: row.campaignId,
    attachedAt: row.attachedAt,
    rejectReason: row.rejectReason,
    createdAt: row.createdAt,
  };
}

export class DrizzleMediaRepository implements MediaRepository {
  async lockUsage(tx: DbTx, ownerId: string): Promise<number> {
    await tx.insert(storageUsage).values({ ownerId }).onConflictDoNothing();
    const rows = await tx
      .select({ used: storageUsage.bytesUsed })
      .from(storageUsage)
      .where(eq(storageUsage.ownerId, ownerId))
      .for('update');
    return rows[0]?.used ?? 0;
  }

  async usage(tx: DbTx, ownerId: string): Promise<number> {
    const rows = await tx
      .select({ used: storageUsage.bytesUsed })
      .from(storageUsage)
      .where(eq(storageUsage.ownerId, ownerId));
    return rows[0]?.used ?? 0;
  }

  async addUsage(tx: DbTx, ownerId: string, delta: number): Promise<void> {
    // Create the row empty, then add: PostgreSQL checks the proposed row of an upsert against `bytes_used >= 0`
    // before it looks for the conflict, so a negative delta cannot be written as an upsert.
    await tx.insert(storageUsage).values({ ownerId }).onConflictDoNothing();
    await tx
      .update(storageUsage)
      .set({ bytesUsed: sql`${storageUsage.bytesUsed} + ${delta}` })
      .where(eq(storageUsage.ownerId, ownerId));
  }

  async insert(tx: DbTx, media: NewMedia): Promise<void> {
    await tx.insert(mediaObjects).values(media);
  }

  async find(tx: DbTx, id: string): Promise<MediaRecord | null> {
    const rows = await tx.select().from(mediaObjects).where(eq(mediaObjects.id, id));
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async setBytes(tx: DbTx, id: string, bytes: number): Promise<void> {
    await tx.update(mediaObjects).set({ bytes }).where(eq(mediaObjects.id, id));
  }

  async attach(tx: DbTx, ownerId: string, id: string, campaignId: string | null): Promise<boolean> {
    const result = await tx.execute(sql`
      update media_objects
         set attached_at = coalesce(attached_at, now()),
             campaign_id = coalesce(${campaignId}::uuid, campaign_id)
       where id = ${id} and owner_id = ${ownerId}
       returning id`);
    return result.rows.length === 1;
  }

  async remove(tx: DbTx, id: string): Promise<MediaRecord | null> {
    const rows = await tx.delete(mediaObjects).where(eq(mediaObjects.id, id)).returning();
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }
}
