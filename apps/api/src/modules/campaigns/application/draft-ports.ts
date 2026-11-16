import type { DbTx } from '../../../platform/db/index.js';
import type { DraftFields, DraftRecord } from '../domain/draft.js';

/** Where a page of drafts resumes: the last row's `updated_at` text and ID. */
export interface DraftPosition {
  readonly updatedAt: string;
  readonly id: string;
}

/** Module-private persistence of `drafts`; every method runs in the caller's transaction and is owner-scoped. */
export interface DraftRepository {
  insert(tx: DbTx, id: string, ownerId: string, fields: DraftFields): Promise<DraftRecord>;
  /** `lock` takes the row `FOR UPDATE`. A foreign and a never-existing ID both give null. */
  find(tx: DbTx, ownerId: string, id: string, lock?: boolean): Promise<DraftRecord | null>;
  /** The owner's unsubmitted drafts, newest first (`updated_at desc, id desc`), after `after`. */
  listOpen(tx: DbTx, ownerId: string, limit: number, after?: DraftPosition): Promise<DraftRecord[]>;
  /** Conditional update `WHERE version = expected AND campaign_id IS NULL`; null when nothing matched. */
  update(
    tx: DbTx,
    ownerId: string,
    id: string,
    expectedVersion: number,
    fields: DraftFields,
  ): Promise<DraftRecord | null>;
  remove(tx: DbTx, ownerId: string, id: string): Promise<boolean>;
  /** Whether another draft, or any campaign, already holds this product image (one image, one owner of it; SB-D2). */
  mediaTaken(tx: DbTx, mediaId: string, exceptDraftId: string | null): Promise<boolean>;
}

export const DRAFT_REPOSITORY = Symbol('DRAFT_REPOSITORY');
