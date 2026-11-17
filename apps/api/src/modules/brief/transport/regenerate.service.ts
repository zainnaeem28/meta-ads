import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { briefs } from '../../../database/schema/brief.js';
import { campaigns } from '../../../database/schema/campaigns.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { BriefJobCreator, reuseHashOf } from './submit-jobs.js';
import type { JobOutcome } from './submit-jobs.js';

/**
 * API-053 (ARCHITECTURE §5.3): `draft`, `accepted` or `failed` goes back to `generating` with a new job; the old text is
 * kept until the new one is written (SB-D11), so an edit is replaced only when the job succeeds. A brief that is already
 * generating is 409 `state_conflict`, unless the request is a replay of the one that started it.
 */
@Injectable()
export class RegenerateService {
  constructor(@Inject(BriefJobCreator) private readonly jobs: BriefJobCreator) {}

  async regenerate(ownerId: string, campaignId: string, key: string, requestHash: Buffer): Promise<JobOutcome> {
    return this.jobs.inTransaction(async (tx) => {
      const [brief] = await tx
        .select({ id: briefs.id, state: briefs.state, generationSeq: briefs.generationSeq })
        .from(briefs)
        .innerJoin(campaigns, eq(campaigns.id, briefs.campaignId))
        .where(and(eq(briefs.campaignId, campaignId), eq(briefs.ownerId, ownerId), eq(campaigns.state, 'active')))
        .for('update', { of: briefs });
      if (brief === undefined) throw new DomainError('not_found', 'This campaign does not exist.');
      const next = brief.generationSeq + 1;
      const base = { ownerId, operationId: 'API-053', key, requestHash, kind: 'brief_generation', campaignId, resource: { type: 'brief_job' } } as const;
      // A retry of the request that started the generation replays it: the key is looked at before the state.
      const replay = await this.jobs.replayIfRecorded(tx, { ...base, generationSeq: brief.generationSeq, reuseHash: reuseHashOf('brief_generation', campaignId, brief.generationSeq) });
      if (replay !== undefined) return replay;
      if (brief.state === 'generating') {
        throw new DomainError('state_conflict', 'The brief is already being generated.');
      }
      const spec = { ...base, generationSeq: next, reuseHash: reuseHashOf('brief_generation', campaignId, next) };
      return this.jobs.createOrReuse(tx, spec, async () => {
        await tx
          .update(briefs)
          .set({
            state: 'generating',
            generationSeq: next,
            version: sql`${briefs.version} + 1`,
            acceptedAt: null,
            updatedAt: sql`now()`,
          })
          .where(eq(briefs.id, brief.id));
      });
    });
  }
}
