import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  briefJobs,
  briefSegments,
  briefs,
  claimEvents,
  claimIssues,
} from '../../../../database/schema/brief.js';
import { newId } from '../../../../platform/shared-kernel/index.js';
import type { DbTx } from '../../../../platform/db/index.js';
import type {
  BriefRecord,
  BriefRepository,
  ClaimOutcome,
  GenerationJobRecord,
  IssueRecord,
  NewIssue,
  SegmentRecord,
  SegmentWrite,
} from '../../application/brief-ports.js';
import type { ClaimField, Resolution, RuleClass } from '../../domain/index.js';

const briefColumns = {
  id: briefs.id,
  campaignId: briefs.campaignId,
  state: briefs.state,
  version: briefs.version,
  acceptedAt: briefs.acceptedAt,
  updatedAt: briefs.updatedAt,
};

const issueColumns = {
  id: claimIssues.id,
  briefId: claimIssues.briefId,
  segmentId: claimIssues.segmentId,
  segmentPosition: briefSegments.position,
  field: claimIssues.field,
  ruleId: claimIssues.ruleId,
  class: claimIssues.class,
  resolution: claimIssues.resolution,
  message: claimIssues.message,
  spanStart: claimIssues.spanStart,
  spanEnd: claimIssues.spanEnd,
  clearReason: claimIssues.clearReason,
};

type IssueRow = Omit<IssueRecord, 'field' | 'class' | 'resolution'> & {
  field: string;
  class: string;
  resolution: string;
};

const toIssue = (row: IssueRow): IssueRecord => ({
  ...row,
  field: row.field as ClaimField,
  class: row.class as RuleClass,
  resolution: row.resolution as Resolution,
});

const toBrief = (row: Omit<BriefRecord, 'state'> & { state: string }): BriefRecord => ({
  ...row,
  state: row.state as BriefRecord['state'],
});

/** Drizzle persistence of `briefs`, `brief_segments`, `claim_issues` and `claim_events` (M0009). */
export class DrizzleBriefRepository implements BriefRepository {
  async findBrief(
    tx: DbTx,
    ownerId: string,
    campaignId: string,
    lock = false,
  ): Promise<BriefRecord | null> {
    const query = tx
      .select(briefColumns)
      .from(briefs)
      .where(and(eq(briefs.campaignId, campaignId), eq(briefs.ownerId, ownerId)));
    const [row] = await (lock ? query.for('update') : query);
    return row === undefined ? null : toBrief(row);
  }

  async segments(tx: DbTx, briefId: string): Promise<SegmentRecord[]> {
    const rows = await tx
      .select({
        id: briefSegments.id,
        position: briefSegments.position,
        state: briefSegments.state,
        revision: briefSegments.revision,
        dialogue: briefSegments.dialogue,
        prompt: briefSegments.prompt,
        wordCount: briefSegments.wordCount,
      })
      .from(briefSegments)
      .where(eq(briefSegments.briefId, briefId))
      .orderBy(asc(briefSegments.position));
    return rows.map((row) => ({ ...row, state: row.state as SegmentRecord['state'] }));
  }

  async issues(
    tx: DbTx,
    briefId: string,
    acceptedAt: string | null,
    limit: number,
  ): Promise<IssueRecord[]> {
    const since =
      acceptedAt === null ? undefined : sql`${claimIssues.resolvedAt} > ${acceptedAt}::timestamptz`;
    const rows = await tx
      .select(issueColumns)
      .from(claimIssues)
      .innerJoin(briefSegments, eq(briefSegments.id, claimIssues.segmentId))
      .where(
        and(
          eq(claimIssues.briefId, briefId),
          since === undefined ? undefined : sql`(${claimIssues.resolution} = 'open' or ${since})`,
        ),
      )
      .orderBy(
        sql`(${claimIssues.resolution} = 'open') desc`,
        asc(briefSegments.position),
        asc(claimIssues.field),
        asc(claimIssues.ruleId),
        asc(claimIssues.id),
      )
      .limit(limit);
    return rows.map(toIssue);
  }

  async liveIssues(tx: DbTx, briefId: string): Promise<IssueRecord[]> {
    const rows = await tx
      .select(issueColumns)
      .from(claimIssues)
      .innerJoin(briefSegments, eq(briefSegments.id, claimIssues.segmentId))
      .where(
        and(
          eq(claimIssues.briefId, briefId),
          inArray(claimIssues.resolution, ['open', 'cleared_with_reason']),
        ),
      );
    return rows.map(toIssue);
  }

  async openIssueCount(tx: DbTx, briefId: string): Promise<number> {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(claimIssues)
      .where(and(eq(claimIssues.briefId, briefId), eq(claimIssues.resolution, 'open')));
    return row?.count ?? 0;
  }

  async latestGenerationJob(tx: DbTx, campaignId: string): Promise<GenerationJobRecord | null> {
    const [row] = await tx
      .select({
        id: briefJobs.id,
        state: briefJobs.state,
        causeClass: briefJobs.causeClass,
        causeMessage: briefJobs.causeMessage,
        createdAt: briefJobs.createdAt,
        updatedAt: briefJobs.updatedAt,
        deadlineAt: briefJobs.deadlineAt,
      })
      .from(briefJobs)
      .where(and(eq(briefJobs.campaignId, campaignId), eq(briefJobs.kind, 'brief_generation')))
      .orderBy(sql`${briefJobs.createdAt} desc`, sql`${briefJobs.id} desc`)
      .limit(1);
    return row ?? null;
  }

  async updateSegment(tx: DbTx, write: SegmentWrite): Promise<void> {
    await tx
      .update(briefSegments)
      .set({
        dialogue: write.dialogue,
        prompt: write.prompt,
        wordCount: write.wordCount,
        revision: sql`${briefSegments.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(briefSegments.id, write.id));
  }

  async saveBrief(tx: DbTx, briefId: string, state: 'draft' | 'accepted'): Promise<BriefRecord> {
    const [row] = await tx
      .update(briefs)
      .set({
        state,
        version: sql`${briefs.version} + 1`,
        acceptedAt: state === 'accepted' ? sql`now()` : null,
        updatedAt: sql`now()`,
      })
      .where(eq(briefs.id, briefId))
      .returning(briefColumns);
    if (row === undefined) throw new Error(`brief ${briefId} vanished while locked`);
    return toBrief(row);
  }

  async insertIssues(
    tx: DbTx,
    ownerId: string,
    briefId: string,
    issues: readonly NewIssue[],
  ): Promise<void> {
    if (issues.length === 0) return;
    await tx.insert(claimIssues).values(issues.map((issue) => ({ ...issue, ownerId, briefId })));
  }

  async closeIssues(tx: DbTx, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await tx
      .update(claimIssues)
      .set({ resolution: 'closed_by_edit', resolvedAt: sql`now()` })
      .where(and(inArray(claimIssues.id, [...ids]), eq(claimIssues.resolution, 'open')));
  }

  async recordEvents(
    tx: DbTx,
    ownerId: string,
    briefId: string,
    events: readonly { issueId: string; class: RuleClass; outcome: ClaimOutcome }[],
  ): Promise<void> {
    if (events.length === 0) return;
    await tx
      .insert(claimEvents)
      .values(events.map((event) => ({ ...event, id: newId(), ownerId, briefId })));
  }

  async findIssue(
    tx: DbTx,
    ownerId: string,
    issueId: string,
    lock = false,
  ): Promise<IssueRecord | null> {
    // `FOR UPDATE OF claim_issues`: the joined segment row is not locked.
    const query = tx
      .select(issueColumns)
      .from(claimIssues)
      .innerJoin(briefSegments, eq(briefSegments.id, claimIssues.segmentId))
      .where(and(eq(claimIssues.id, issueId), eq(claimIssues.ownerId, ownerId)));
    const [row] = await (lock ? query.for('update', { of: claimIssues }) : query);
    return row === undefined ? null : toIssue(row);
  }

  async clearIssue(
    tx: DbTx,
    issueId: string,
    userId: string,
    reason: string,
  ): Promise<IssueRecord> {
    await tx
      .update(claimIssues)
      .set({
        resolution: 'cleared_with_reason',
        clearedBy: userId,
        clearReason: reason,
        resolvedAt: sql`now()`,
      })
      .where(and(eq(claimIssues.id, issueId), eq(claimIssues.resolution, 'open')));
    const found = await this.findIssue(tx, userId, issueId);
    if (found === null) throw new Error(`issue ${issueId} vanished while locked`);
    return found;
  }
}
