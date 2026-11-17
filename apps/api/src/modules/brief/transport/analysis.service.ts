import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { briefJobs } from '../../../database/schema/brief.js';
import { mediaObjects } from '../../../database/schema/media.js';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database, DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { BriefJobCreator, reuseHashOf } from './submit-jobs.js';
import type { JobOutcome, JobRow } from './submit-jobs.js';

export interface AnalysisView {
  readonly job: JobRow | null;
  readonly productDescription: string | null;
}

const JOB_COLUMNS = {
  id: briefJobs.id,
  state: briefJobs.state,
  causeClass: briefJobs.causeClass,
  causeMessage: briefJobs.causeMessage,
  createdAt: briefJobs.createdAt,
  updatedAt: briefJobs.updatedAt,
  deadlineAt: briefJobs.deadlineAt,
};

/** API-035 and API-036 (ARCHITECTURE §5.4, REQ-006): the product-only analysis of one ready image of mine. */
@Injectable()
export class AnalysisService {
  constructor(
    @Inject(BriefJobCreator) private readonly jobs: BriefJobCreator,
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
  ) {}

  /** Starts the analysis, or returns the one that is live or done for this image (a failed one is started again). */
  async request(
    ownerId: string,
    mediaId: string,
    key: string,
    requestHash: Buffer,
  ): Promise<JobOutcome> {
    return this.jobs.inTransaction(async (tx) => {
      const media = await this.find(tx, ownerId, mediaId);
      if (media.state !== 'ready')
        throw new DomainError('media_not_ready', 'The image is not ready to be analysed yet.');
      const spec = {
        ownerId,
        operationId: 'API-035',
        key,
        requestHash,
        kind: 'image_analysis',
        mediaId,
        generationSeq: 0,
        reuseHash: reuseHashOf('image_analysis', mediaId),
        resource: { type: 'brief_job' },
      } as const;
      return this.jobs.createOrReuse(tx, spec);
    });
  }

  /** The latest analysis job of the image and the description of the latest completed one. */
  async latest(ownerId: string, mediaId: string): Promise<AnalysisView> {
    return this.database.uow.run(async (tx) => {
      await this.find(tx, ownerId, mediaId);
      const owned = and(
        eq(briefJobs.ownerId, ownerId),
        eq(briefJobs.mediaId, mediaId),
        eq(briefJobs.kind, 'image_analysis'),
      );
      const [job] = await tx
        .select(JOB_COLUMNS)
        .from(briefJobs)
        .where(owned)
        .orderBy(desc(briefJobs.createdAt), desc(briefJobs.id))
        .limit(1);
      const [done] = await tx
        .select({ text: briefJobs.resultText })
        .from(briefJobs)
        .where(and(owned, eq(briefJobs.state, 'completed')))
        .orderBy(desc(briefJobs.createdAt), desc(briefJobs.id))
        .limit(1);
      return { job: job ?? null, productDescription: done?.text ?? null };
    });
  }

  /** A foreign and a missing image look the same (404). */
  private async find(tx: DbTx, ownerId: string, mediaId: string): Promise<{ state: string }> {
    const [media] = await tx
      .select({ state: mediaObjects.state, kind: mediaObjects.kind })
      .from(mediaObjects)
      .where(and(eq(mediaObjects.id, mediaId), eq(mediaObjects.ownerId, ownerId)));
    if (media === undefined || media.kind !== 'upload')
      throw new DomainError('not_found', 'This image does not exist.');
    return media;
  }
}
