import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  briefJobs,
  briefSegments,
  briefs,
  claimEvents,
  claimIssues,
} from '../../../database/schema/brief.js';
import { campaigns, drafts } from '../../../database/schema/campaigns.js';
import { mediaObjects } from '../../../database/schema/media.js';
import { providerKeys, sealedKeyColumns } from '../../../database/schema/provider-keys.js';
import type { DbTx } from '../../../platform/db/index.js';
import { claimWithUserLimit, jobTable } from '../../../platform/jobs/claim.js';
import { newId } from '../../../platform/shared-kernel/index.js';
import type {
  BriefContext,
  BriefJobRepository,
  BriefJobRow,
  GenerationWrite,
  IssueRow,
  JobCause,
  MediaFacts,
  NewIssue,
  SealedKeyRow,
  WrittenSegment,
} from '../application/worker/ports.js';
import { CALL_TO_ACTION } from '../application/worker/post-process.js';

const MESSAGE_MAX = 300;
const clip = (text: string): string =>
  text.length <= MESSAGE_MAX ? text : text.slice(0, MESSAGE_MAX);

/** Drizzle access to the brief jobs and what a generation writes (SB-D11: segments are updated in place). */
export class DrizzleBriefJobs implements BriefJobRepository {
  async findJob(tx: DbTx, jobId: string): Promise<BriefJobRow | null> {
    const rows = await tx.select().from(briefJobs).where(eq(briefJobs.id, jobId));
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      ownerId: row.ownerId,
      kind: row.kind as BriefJobRow['kind'],
      campaignId: row.campaignId,
      mediaId: row.mediaId,
      generationSeq: row.generationSeq,
      state: row.state,
      keyId: row.keyId,
      keyVersion: row.keyVersion,
      callCount: row.callCount,
    };
  }

  /** Reads the sealed columns: the worker role is the only one granted them (M0004). */
  async findKey(tx: DbTx, keyId: string): Promise<SealedKeyRow | null> {
    const rows = await tx
      .select(sealedKeyColumns)
      .from(providerKeys)
      .where(eq(providerKeys.id, keyId));
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      ownerId: row.ownerId,
      provider: row.provider as SealedKeyRow['provider'],
      status: row.status as SealedKeyRow['status'],
      version: row.version,
      sealed: {
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        wrappedDek: row.wrappedDek,
        kekVersion: row.kekVersion,
      },
    };
  }

  async findMedia(tx: DbTx, mediaId: string): Promise<MediaFacts | null> {
    const rows = await tx
      .select({
        id: mediaObjects.id,
        ownerId: mediaObjects.ownerId,
        state: mediaObjects.state,
        storageKey: mediaObjects.storageKey,
        contentType: mediaObjects.contentType,
      })
      .from(mediaObjects)
      .where(eq(mediaObjects.id, mediaId));
    return rows[0] ?? null;
  }

  async findContext(tx: DbTx, campaignId: string): Promise<BriefContext | null> {
    const [campaign] = await tx.select().from(campaigns).where(eq(campaigns.id, campaignId));
    const [brief] = await tx.select().from(briefs).where(eq(briefs.campaignId, campaignId));
    const [draft] = await tx.select().from(drafts).where(eq(drafts.campaignId, campaignId));
    if (campaign === undefined || brief === undefined || draft === undefined) return null;
    const segments = await tx
      .select()
      .from(briefSegments)
      .where(eq(briefSegments.briefId, brief.id));
    const issues = await tx
      .select()
      .from(claimIssues)
      .where(
        and(
          eq(claimIssues.briefId, brief.id),
          inArray(claimIssues.resolution, ['open', 'cleared_with_reason']),
        ),
      );
    const mode = draft.intakeMode === 'script' ? 'script' : 'description';
    return {
      briefId: brief.id,
      briefState: brief.state,
      briefGenerationSeq: brief.generationSeq,
      input: {
        productName: campaign.productName,
        productDescription: campaign.productDescription,
        audience: {
          ageMin: draft.audienceAgeMin,
          ageMax: draft.audienceAgeMax,
          gender: draft.audienceGender,
          interests: draft.audienceInterests ?? [],
        },
        direction: { goal: draft.directionGoal, tone: draft.directionTone },
        segmentCount: campaign.segmentCount,
        mode,
        source: (mode === 'script' ? draft.script : draft.concept) ?? '',
        callToAction: CALL_TO_ACTION,
      },
      segments: segments
        .map((row) => ({
          id: row.id,
          position: row.position,
          state: row.state,
          revision: row.revision,
          dialogue: row.dialogue,
          prompt: row.prompt,
        }))
        .sort((a, b) => a.position - b.position),
      issues: issues.map((row): IssueRow => ({
        id: row.id,
        segmentId: row.segmentId,
        field: row.field as IssueRow['field'],
        ruleId: row.ruleId,
        resolution: row.resolution as IssueRow['resolution'],
      })),
    };
  }

  async claim(tx: DbTx, jobId: string): Promise<boolean> {
    const outcome = await claimWithUserLimit(tx, jobTable('brief_jobs'), jobId, { limit: null });
    return outcome.kind === 'claimed';
  }

  async failPending(tx: DbTx, jobId: string, cause: JobCause, message: string): Promise<boolean> {
    const rows = await tx
      .update(briefJobs)
      .set({
        state: 'failed',
        causeClass: cause,
        causeMessage: clip(message),
        updatedAt: sql`now()`,
      })
      .where(and(eq(briefJobs.id, jobId), eq(briefJobs.state, 'pending')))
      .returning({ id: briefJobs.id });
    return rows.length === 1;
  }

  async failSubmitting(
    tx: DbTx,
    jobId: string,
    cause: JobCause,
    message: string,
    errorCode?: string,
  ): Promise<boolean> {
    const rows = await tx
      .update(briefJobs)
      .set({
        state: 'failed',
        causeClass: cause,
        causeMessage: clip(message),
        lastErrorCode: errorCode ?? null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(briefJobs.id, jobId), eq(briefJobs.state, 'submitting')))
      .returning({ id: briefJobs.id });
    return rows.length === 1;
  }

  async startCall(tx: DbTx, jobId: string, seq: number): Promise<boolean> {
    const rows = await tx
      .update(briefJobs)
      .set({ callCount: seq, updatedAt: sql`now()` })
      .where(
        and(
          eq(briefJobs.id, jobId),
          eq(briefJobs.state, 'submitting'),
          eq(briefJobs.callCount, seq - 1),
        ),
      )
      .returning({ id: briefJobs.id });
    return rows.length === 1;
  }

  async completeGeneration(
    tx: DbTx,
    job: BriefJobRow,
    context: BriefContext,
    write: {
      segments: readonly WrittenSegment[];
      close: readonly string[];
      raise: readonly NewIssue[];
    },
  ): Promise<GenerationWrite> {
    const done = await tx
      .update(briefJobs)
      .set({ state: 'completed', updatedAt: sql`now()` })
      .where(and(eq(briefJobs.id, job.id), eq(briefJobs.state, 'submitting')))
      .returning({ id: briefJobs.id });
    if (done.length === 0) return { kind: 'superseded' };
    const locked = await tx
      .select({ id: briefs.id, state: briefs.state, generationSeq: briefs.generationSeq })
      .from(briefs)
      .where(eq(briefs.id, context.briefId))
      .for('update');
    const brief = locked[0];
    if (
      brief === undefined ||
      brief.state !== 'generating' ||
      brief.generationSeq !== job.generationSeq
    ) {
      return { kind: 'superseded' };
    }
    const existing = new Map(context.segments.map((segment) => [segment.id, segment]));
    for (const segment of write.segments) {
      const known = existing.get(segment.id);
      if (known === undefined) {
        await tx.insert(briefSegments).values({
          id: segment.id,
          briefId: context.briefId,
          position: segment.position,
          dialogue: segment.dialogue,
          prompt: segment.prompt,
          wordCount: segment.wordCount,
        });
        continue;
      }
      await tx
        .update(briefSegments)
        .set({
          state: 'active',
          dialogue: segment.dialogue,
          prompt: segment.prompt,
          wordCount: segment.wordCount,
          revision: sql`${briefSegments.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(briefSegments.id, segment.id));
    }
    const written = new Set(write.segments.map((segment) => segment.id));
    const retired = context.segments.filter(
      (segment) => segment.state === 'active' && !written.has(segment.id),
    );
    if (retired.length > 0) {
      await tx
        .update(briefSegments)
        .set({
          state: 'retired',
          revision: sql`${briefSegments.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          inArray(
            briefSegments.id,
            retired.map((segment) => segment.id),
          ),
        );
    }
    if (write.close.length > 0) {
      const closed = await tx
        .update(claimIssues)
        .set({ resolution: 'closed_by_edit', resolvedAt: sql`now()` })
        .where(and(inArray(claimIssues.id, [...write.close]), eq(claimIssues.resolution, 'open')))
        .returning({ id: claimIssues.id, class: claimIssues.class });
      if (closed.length > 0) {
        await tx.insert(claimEvents).values(
          closed.map((row) => ({
            id: newId(),
            ownerId: job.ownerId,
            briefId: context.briefId,
            issueId: row.id,
            class: row.class,
            outcome: 'closed_by_edit',
          })),
        );
      }
    }
    if (write.raise.length > 0) {
      const rows = write.raise.map((issue) => ({
        id: newId(),
        ownerId: job.ownerId,
        briefId: context.briefId,
        segmentId: issue.segmentId,
        field: issue.field,
        ruleId: issue.ruleId,
        class: issue.class,
        message: clip(issue.message),
        spanStart: issue.spanStart,
        spanEnd: issue.spanEnd,
      }));
      await tx.insert(claimIssues).values(rows);
      await tx.insert(claimEvents).values(
        rows.map((row) => ({
          id: newId(),
          ownerId: job.ownerId,
          briefId: context.briefId,
          issueId: row.id,
          class: row.class,
          outcome: 'raised',
        })),
      );
    }
    await tx
      .update(briefs)
      .set({ state: 'draft', version: sql`${briefs.version} + 1`, updatedAt: sql`now()` })
      .where(eq(briefs.id, context.briefId));
    return { kind: 'written' };
  }

  async completeAnalysis(tx: DbTx, jobId: string, description: string): Promise<boolean> {
    const rows = await tx
      .update(briefJobs)
      .set({ state: 'completed', resultText: description, updatedAt: sql`now()` })
      .where(and(eq(briefJobs.id, jobId), eq(briefJobs.state, 'submitting')))
      .returning({ id: briefJobs.id });
    return rows.length === 1;
  }

  async settleBriefAfterFailure(
    tx: DbTx,
    campaignId: string,
    generationSeq: number,
  ): Promise<void> {
    const [brief] = await tx
      .select({ id: briefs.id })
      .from(briefs)
      .where(
        and(
          eq(briefs.campaignId, campaignId),
          eq(briefs.generationSeq, generationSeq),
          eq(briefs.state, 'generating'),
        ),
      )
      .for('update');
    if (brief === undefined) return;
    const text = await tx
      .select({ id: briefSegments.id })
      .from(briefSegments)
      .where(and(eq(briefSegments.briefId, brief.id), sql`${briefSegments.dialogue} <> ''`))
      .limit(1);
    // A regeneration keeps its previous text (SB-D11); a first generation has none and the brief is `failed`.
    await tx
      .update(briefs)
      .set({ state: text.length > 0 ? 'draft' : 'failed', updatedAt: sql`now()` })
      .where(eq(briefs.id, brief.id));
  }
}
