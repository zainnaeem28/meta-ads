import type { DbTx } from '../../../platform/db/index.js';

/** A campaign row as the history reads it; timestamps are PostgreSQL text with microseconds. */
export interface CampaignRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly productName: string;
  readonly productDescription: string;
  readonly productMediaId: string | null;
  readonly segmentCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HistoryPosition {
  readonly updatedAt: string;
  readonly id: string;
}

export interface HistoryQuery {
  readonly limit: number;
  readonly after?: HistoryPosition | undefined;
  /** Already escaped for `ILIKE ... ESCAPE '\'`, without the wrapping `%`. */
  readonly escapedTerm?: string | undefined;
  /** Restrict to these campaign IDs (the progress filter). */
  readonly ids?: readonly string[] | undefined;
}

/** Module-private reads of `campaigns`; every statement is owner-scoped and never returns a `deleting` row. */
export interface HistoryRepository {
  list(tx: DbTx, ownerId: string, query: HistoryQuery): Promise<CampaignRecord[]>;
  /** The campaign and the draft it came from; null for a foreign, unknown or `deleting` campaign. */
  find(tx: DbTx, ownerId: string, id: string): Promise<{ campaign: CampaignRecord; draftId: string } | null>;
  /** Whether the campaign exists in state `active` (any owner), for callers that already hold the ownership. */
  isActive(tx: DbTx, id: string): Promise<boolean>;
  /** Whether the campaign is the owner's and not `deleting`. */
  ownsActive(tx: DbTx, ownerId: string, id: string): Promise<boolean>;
}

export const HISTORY_REPOSITORY = Symbol('HISTORY_REPOSITORY');
