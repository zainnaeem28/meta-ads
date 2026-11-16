import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database, DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { HISTORY_REPOSITORY } from './history-ports.js';
import type { CampaignRecord, HistoryPosition, HistoryRepository } from './history-ports.js';
import { CAMPAIGN_PROGRESS_READER, NO_JOBS } from './progress-reader.js';
import type { CampaignProgress, CampaignProgressReader, ProgressSnapshot } from './progress-reader.js';

export type HistoryFilter = 'all' | 'processing' | 'completed' | 'failed';

export interface CampaignListItem {
  readonly campaign: CampaignRecord;
  readonly snapshot: ProgressSnapshot;
}

export interface CampaignDetail extends CampaignListItem {
  readonly draftId: string;
}

/** `%`, `_` and `\` made literal for `ILIKE ... ESCAPE '\'`; the caller wraps the result in `%`. */
export const escapeLike = (term: string): string => term.replace(/[\\%_]/g, (c) => `\\${c}`);

const notFound = (): DomainError => new DomainError('not_found', 'Not found.');

/**
 * The history of campaigns (API-040, API-041; ARCHITECTURE §3.2). Reads are owner-scoped in the statement, so a foreign,
 * a `deleting` and a never-existing campaign all answer 404. Progress comes from the injected reader, never from a
 * production import.
 */
@Injectable()
export class HistoryService {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(HISTORY_REPOSITORY) private readonly repository: HistoryRepository,
    @Inject(CAMPAIGN_PROGRESS_READER) private readonly progress: CampaignProgressReader,
  ) {}

  /**
   * One page, newest first, plus one row to learn about the next page. `term` is the trimmed, unescaped search text.
   * A filter that no campaign matches gives an empty page without touching `campaigns`.
   */
  async list(
    ownerId: string,
    filter: HistoryFilter,
    term: string | undefined,
    limit: number,
    after?: HistoryPosition,
  ): Promise<CampaignListItem[]> {
    let ids: readonly string[] | undefined;
    if (filter !== 'all') {
      const matching = await this.progress.idsWithProgress(ownerId, filter);
      if (matching.size === 0) return [];
      ids = [...matching];
    }
    const rows = await this.database.uow.run((tx) =>
      this.repository.list(tx, ownerId, {
        limit,
        after,
        escapedTerm: term === undefined ? undefined : escapeLike(term),
        ids,
      }),
    );
    const snapshots = await this.progress.progressFor(
      ownerId,
      rows.map((r) => r.id),
    );
    return rows.map((campaign) => ({ campaign, snapshot: snapshots.get(campaign.id) ?? NO_JOBS }));
  }

  async get(ownerId: string, id: string): Promise<CampaignDetail> {
    const found = await this.database.uow.run((tx) => this.repository.find(tx, ownerId, id));
    if (found === null) throw notFound();
    const snapshots = await this.progress.progressFor(ownerId, [id]);
    return { ...found, snapshot: snapshots.get(id) ?? NO_JOBS };
  }

  /** For the other campaign slices: the campaign is the owner's and not being deleted, else 404 (never 403). */
  async assertOwner(tx: DbTx, ownerId: string, id: string): Promise<void> {
    if (!(await this.repository.ownsActive(tx, ownerId, id))) throw notFound();
  }

  /** True while the campaign exists and is not `deleting`; background steps use it to stop work on a deleted campaign. */
  isActive(tx: DbTx, id: string): Promise<boolean> {
    return this.repository.isActive(tx, id);
  }
}

export type { CampaignProgress };
