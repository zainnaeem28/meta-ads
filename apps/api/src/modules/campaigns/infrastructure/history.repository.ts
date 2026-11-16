import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { campaigns, drafts } from '../../../database/schema/campaigns.js';
import type { DbTx } from '../../../platform/db/index.js';
import type { CampaignRecord, HistoryQuery, HistoryRepository } from '../application/history-ports.js';

const columns = {
  id: campaigns.id,
  ownerId: campaigns.ownerId,
  productName: campaigns.productName,
  productDescription: campaigns.productDescription,
  productMediaId: campaigns.productMediaId,
  segmentCount: campaigns.segmentCount,
  createdAt: campaigns.createdAt,
  updatedAt: campaigns.updatedAt,
};

const active = eq(campaigns.state, 'active');

/** Drizzle reads of `campaigns`; the list rides `campaigns_owner_active_idx` and, for `q`, the trigram indexes. */
export class DrizzleHistoryRepository implements HistoryRepository {
  async list(tx: DbTx, ownerId: string, query: HistoryQuery): Promise<CampaignRecord[]> {
    const pattern = query.escapedTerm === undefined ? undefined : `%${query.escapedTerm}%`;
    return tx
      .select(columns)
      .from(campaigns)
      .where(
        and(
          eq(campaigns.ownerId, ownerId),
          active,
          query.ids === undefined ? undefined : inArray(campaigns.id, [...query.ids]),
          pattern === undefined
            ? undefined
            : or(
                sql`${campaigns.productName} ilike ${pattern} escape '\\'`,
                sql`${campaigns.productDescription} ilike ${pattern} escape '\\'`,
              ),
          query.after === undefined
            ? undefined
            : sql`(${campaigns.updatedAt}, ${campaigns.id}) < (${query.after.updatedAt}::timestamptz, ${query.after.id}::uuid)`,
        ),
      )
      .orderBy(desc(campaigns.updatedAt), desc(campaigns.id))
      .limit(query.limit);
  }

  async find(
    tx: DbTx,
    ownerId: string,
    id: string,
  ): Promise<{ campaign: CampaignRecord; draftId: string } | null> {
    const rows = await tx
      .select({ ...columns, draftId: drafts.id })
      .from(campaigns)
      .innerJoin(drafts, eq(drafts.campaignId, campaigns.id))
      .where(and(eq(campaigns.id, id), eq(campaigns.ownerId, ownerId), active))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const { draftId, ...campaign } = row;
    return { campaign, draftId };
  }

  async isActive(tx: DbTx, id: string): Promise<boolean> {
    const rows = await tx.select({ id: campaigns.id }).from(campaigns).where(and(eq(campaigns.id, id), active)).limit(1);
    return rows.length === 1;
  }

  async ownsActive(tx: DbTx, ownerId: string, id: string): Promise<boolean> {
    const rows = await tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.ownerId, ownerId), active))
      .limit(1);
    return rows.length === 1;
  }
}
