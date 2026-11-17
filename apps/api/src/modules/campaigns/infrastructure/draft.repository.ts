import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { campaigns, drafts } from '../../../database/schema/campaigns.js';
import type { DbTx } from '../../../platform/db/index.js';
import type { DraftPosition, DraftRepository } from '../application/draft-ports.js';
import type { Audience, Direction, DraftFields, DraftRecord } from '../domain/draft.js';

type Row = typeof drafts.$inferSelect;

function audienceOf(row: Row): Audience | null {
  const audience: {
    ageMin?: number;
    ageMax?: number;
    gender?: 'all' | 'female' | 'male';
    interests?: string[];
  } = {};
  if (row.audienceAgeMin !== null) audience.ageMin = row.audienceAgeMin;
  if (row.audienceAgeMax !== null) audience.ageMax = row.audienceAgeMax;
  if (row.audienceGender !== null)
    audience.gender = row.audienceGender as 'all' | 'female' | 'male';
  if (row.audienceInterests !== null) audience.interests = row.audienceInterests;
  return Object.keys(audience).length === 0 ? null : audience;
}

function directionOf(row: Row): Direction | null {
  const direction: {
    goal?: 'awareness' | 'conversion' | 'retention';
    tone?: string;
    segmentCount?: number;
  } = {};
  if (row.directionGoal !== null)
    direction.goal = row.directionGoal as 'awareness' | 'conversion' | 'retention';
  if (row.directionTone !== null) direction.tone = row.directionTone;
  if (row.segmentCount !== null) direction.segmentCount = row.segmentCount;
  return Object.keys(direction).length === 0 ? null : direction;
}

const toRecord = (row: Row): DraftRecord => ({
  id: row.id,
  ownerId: row.ownerId,
  version: row.version,
  step: row.step,
  adStyle: row.adStyle as 'ugc',
  intakeMode: row.intakeMode as 'description' | 'script',
  productName: row.productName,
  productDescription: row.productDescription,
  audience: audienceOf(row),
  direction: directionOf(row),
  concept: row.concept,
  script: row.script,
  productMediaId: row.productMediaId,
  campaignId: row.campaignId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** Columns for the fields that are present; an object field is replaced as a whole, `null` clears all of its columns. */
function columns(fields: DraftFields): Partial<typeof drafts.$inferInsert> {
  const set: Partial<typeof drafts.$inferInsert> = {};
  if (fields.step !== undefined) set.step = fields.step;
  if (fields.adStyle !== undefined) set.adStyle = fields.adStyle;
  if (fields.intakeMode !== undefined) set.intakeMode = fields.intakeMode;
  if (fields.productName !== undefined) set.productName = fields.productName;
  if (fields.productDescription !== undefined) set.productDescription = fields.productDescription;
  if (fields.audience !== undefined) {
    set.audienceAgeMin = fields.audience?.ageMin ?? null;
    set.audienceAgeMax = fields.audience?.ageMax ?? null;
    set.audienceGender = fields.audience?.gender ?? null;
    set.audienceInterests =
      fields.audience?.interests === undefined ? null : [...fields.audience.interests];
  }
  if (fields.direction !== undefined) {
    set.directionGoal = fields.direction?.goal ?? null;
    set.directionTone = fields.direction?.tone ?? null;
    set.segmentCount = fields.direction?.segmentCount ?? null;
  }
  if (fields.concept !== undefined) set.concept = fields.concept;
  if (fields.script !== undefined) set.script = fields.script;
  if (fields.productMediaId !== undefined) set.productMediaId = fields.productMediaId;
  return set;
}

/** Drizzle persistence of `drafts`. Every statement carries the owner, so a foreign ID is indistinguishable from a missing one. */
export class DrizzleDraftRepository implements DraftRepository {
  async insert(tx: DbTx, id: string, ownerId: string, fields: DraftFields): Promise<DraftRecord> {
    const rows = await tx
      .insert(drafts)
      .values({ id, ownerId, ...columns(fields) })
      .returning();
    return toRecord(rows[0] as Row);
  }

  async find(tx: DbTx, ownerId: string, id: string, lock = false): Promise<DraftRecord | null> {
    const query = tx
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, id), eq(drafts.ownerId, ownerId)));
    const rows = await (lock ? query.for('update') : query);
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async listOpen(
    tx: DbTx,
    ownerId: string,
    limit: number,
    after?: DraftPosition,
  ): Promise<DraftRecord[]> {
    const rows = await tx
      .select()
      .from(drafts)
      .where(
        and(
          eq(drafts.ownerId, ownerId),
          isNull(drafts.campaignId),
          after === undefined
            ? undefined
            : sql`(${drafts.updatedAt}, ${drafts.id}) < (${after.updatedAt}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(drafts.updatedAt), desc(drafts.id))
      .limit(limit);
    return rows.map(toRecord);
  }

  async update(
    tx: DbTx,
    ownerId: string,
    id: string,
    expectedVersion: number,
    fields: DraftFields,
  ): Promise<DraftRecord | null> {
    const rows = await tx
      .update(drafts)
      .set({
        ...columns(fields),
        version: sql`${drafts.version} + 1`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(drafts.id, id),
          eq(drafts.ownerId, ownerId),
          eq(drafts.version, expectedVersion),
          isNull(drafts.campaignId),
        ),
      )
      .returning();
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async remove(tx: DbTx, ownerId: string, id: string): Promise<boolean> {
    const rows = await tx
      .delete(drafts)
      .where(and(eq(drafts.id, id), eq(drafts.ownerId, ownerId), isNull(drafts.campaignId)))
      .returning({ id: drafts.id });
    return rows.length === 1;
  }

  async mediaTaken(tx: DbTx, mediaId: string, exceptDraftId: string | null): Promise<boolean> {
    const otherDraft = await tx
      .select({ id: drafts.id })
      .from(drafts)
      .where(
        and(
          eq(drafts.productMediaId, mediaId),
          exceptDraftId === null ? undefined : ne(drafts.id, exceptDraftId),
        ),
      )
      .limit(1);
    if (otherDraft.length > 0) return true;
    const campaign = await tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(eq(campaigns.productMediaId, mediaId))
      .limit(1);
    return campaign.length > 0;
  }
}
