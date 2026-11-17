import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { briefJobs, briefs } from '../../../database/schema/brief.js';
import { campaigns, drafts } from '../../../database/schema/campaigns.js';
import type { DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { newId } from '../../../platform/shared-kernel/index.js';
import type { ErrorDetail } from '../../../platform/shared-kernel/index.js';
import { MediaService } from '../../media/index.js';
import { BriefJobCreator, reuseHashOf } from './submit-jobs.js';
import type { JobOutcome } from './submit-jobs.js';

type DraftRow = typeof drafts.$inferSelect;

/** The campaign fields a complete draft yields. */
export interface CampaignFields {
  readonly productName: string;
  readonly productDescription: string;
  readonly segmentCount: number;
}

const required = (field: string, message: string): ErrorDetail => ({
  field,
  code: 'required',
  message,
});

/**
 * Completeness of a draft at submit (ARCHITECTURE §5.3): product name, a product description or the description of a
 * completed image analysis, the audience's age range, the direction's goal and segment count, and the concept (description
 * mode) or the script (script mode). Every missing field is listed, none is guessed.
 */
export function completeness(
  draft: DraftRow,
  analysed: string | null,
): { fields?: CampaignFields; missing: ErrorDetail[] } {
  const missing: ErrorDetail[] = [];
  const name = draft.productName?.trim() ?? '';
  const typed = draft.productDescription?.trim() ?? '';
  const description = typed !== '' ? typed : (analysed?.trim() ?? '');
  if (name === '') missing.push(required('productName', 'Name the product.'));
  if (description === '') {
    missing.push(
      required(
        'productDescription',
        'Describe the product, or add a product image and wait for its description.',
      ),
    );
  }
  if (draft.audienceAgeMin === null)
    missing.push(required('audience.ageMin', 'Set the youngest age of the audience.'));
  if (draft.audienceAgeMax === null)
    missing.push(required('audience.ageMax', 'Set the oldest age of the audience.'));
  if (draft.directionGoal === null)
    missing.push(required('direction.goal', 'Choose the goal of the ad.'));
  if (draft.segmentCount === null)
    missing.push(required('direction.segmentCount', 'Choose how many segments the ad has.'));
  if (draft.intakeMode === 'script') {
    if ((draft.script?.trim() ?? '') === '') missing.push(required('script', 'Write the script.'));
  } else if ((draft.concept?.trim() ?? '') === '') {
    missing.push(required('concept', 'Describe the concept of the ad.'));
  }
  if (missing.length > 0 || draft.segmentCount === null) return { missing };
  return {
    fields: {
      productName: name,
      productDescription: description,
      segmentCount: draft.segmentCount,
    },
    missing,
  };
}

/** API-024 (ARCHITECTURE §2.6): the draft becomes a campaign with its brief and its generation job, in one transaction. */
@Injectable()
export class SubmitService {
  constructor(
    @Inject(BriefJobCreator) private readonly jobs: BriefJobCreator,
    @Inject(MediaService) private readonly media: MediaService,
  ) {}

  async submit(
    ownerId: string,
    draftId: string,
    key: string,
    requestHash: Buffer,
  ): Promise<{ campaignId: string } & JobOutcome> {
    return this.jobs.inTransaction(async (tx) => {
      const [draft] = await tx
        .select()
        .from(drafts)
        .where(and(eq(drafts.id, draftId), eq(drafts.ownerId, ownerId)))
        .for('update');
      if (draft === undefined) throw new DomainError('not_found', 'This draft does not exist.');
      const base = {
        ownerId,
        operationId: 'API-024',
        key,
        requestHash,
        kind: 'brief_generation',
        generationSeq: 1,
      } as const;
      if (draft.campaignId !== null) {
        const campaignId = draft.campaignId;
        const spec = {
          ...base,
          reuseHash: reuseHashOf('brief_generation', campaignId, 1),
          resource: { type: 'campaign', id: campaignId },
        } as const;
        return { campaignId, ...(await this.jobs.replay(tx, spec)) };
      }
      const campaignId = newId();
      const spec = {
        ...base,
        campaignId,
        reuseHash: reuseHashOf('brief_generation', campaignId, 1),
        resource: { type: 'campaign', id: campaignId },
      } as const;
      const outcome = await this.jobs.createOrReuse(tx, spec, () =>
        this.createCampaign(tx, draft, campaignId),
      );
      return { campaignId, ...outcome };
    });
  }

  /** Validate, insert the campaign and its brief, point the draft at the campaign and attach the product image. */
  private async createCampaign(tx: DbTx, draft: DraftRow, campaignId: string): Promise<void> {
    const analysed =
      draft.productMediaId === null
        ? null
        : await this.analysisOf(tx, draft.ownerId, draft.productMediaId);
    const { fields, missing } = completeness(draft, analysed);
    if (fields === undefined)
      throw new DomainError('validation_failed', 'The draft is not complete yet.', missing);
    await tx.insert(campaigns).values({
      id: campaignId,
      ownerId: draft.ownerId,
      productName: fields.productName,
      productDescription: fields.productDescription,
      productMediaId: draft.productMediaId,
      segmentCount: fields.segmentCount,
    });
    await tx.update(drafts).set({ campaignId }).where(eq(drafts.id, draft.id));
    // `media_not_ready` (422) when the image is still being checked, 404 when it is not the owner's.
    if (draft.productMediaId !== null)
      await this.media.attach(tx, draft.ownerId, draft.productMediaId, campaignId);
    await tx.insert(briefs).values({
      id: newId(),
      campaignId,
      ownerId: draft.ownerId,
      state: 'generating',
      generationSeq: 1,
    });
  }

  /** The description of the latest completed analysis of the image, if there is one. */
  private async analysisOf(tx: DbTx, ownerId: string, mediaId: string): Promise<string | null> {
    const [row] = await tx
      .select({ text: briefJobs.resultText })
      .from(briefJobs)
      .where(
        and(
          eq(briefJobs.ownerId, ownerId),
          eq(briefJobs.mediaId, mediaId),
          eq(briefJobs.kind, 'image_analysis'),
          eq(briefJobs.state, 'completed'),
        ),
      )
      .orderBy(desc(briefJobs.createdAt), desc(briefJobs.id))
      .limit(1);
    return row?.text ?? null;
  }
}
