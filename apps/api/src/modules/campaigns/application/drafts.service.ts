import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, isUniqueViolation } from '../../../platform/db/index.js';
import type { Database, DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import { newId } from '../../../platform/shared-kernel/index.js';
import { AuditService } from '../../audit/index.js';
import { MediaService, STORAGE_PORT, quarantineKey, uploadKey } from '../../media/index.js';
import type { StoragePort } from '../../media/index.js';
import { assertAudience } from '../domain/draft.js';
import type { DraftFields, DraftRecord } from '../domain/draft.js';
import { DRAFT_REPOSITORY } from './draft-ports.js';
import type { DraftPosition, DraftRepository } from './draft-ports.js';

const notFound = (): DomainError => new DomainError('not_found', 'Not found.');
const submitted = (): DomainError =>
  new DomainError('state_conflict', 'This draft has been submitted and can no longer be changed.');
const mediaTaken = (): DomainError =>
  new DomainError('state_conflict', 'This image is already used by another draft or campaign.');
const unavailable = (): DomainError =>
  new DomainError(
    'service_unavailable',
    'The service is temporarily unavailable. Try again shortly.',
  );

/**
 * Drafts of the intake wizard (API-020 to API-023, API-025; ARCHITECTURE §2.6, §5.3). Every read and write is scoped to
 * the owner in the statement itself, so a foreign and a deleted draft both answer 404. Submit (API-024) is the next slice.
 */
@Injectable()
export class DraftsService {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(DRAFT_REPOSITORY) private readonly repository: DraftRepository,
    @Inject(MediaService) private readonly media: MediaService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** The owner's unsubmitted drafts, newest first; the caller asks for one row more than a page to learn about the next. */
  listOpen(ownerId: string, limit: number, after?: DraftPosition): Promise<DraftRecord[]> {
    return this.database.uow.run((tx) => this.repository.listOpen(tx, ownerId, limit, after));
  }

  async get(ownerId: string, id: string): Promise<DraftRecord> {
    const draft = await this.database.uow.run((tx) => this.repository.find(tx, ownerId, id));
    if (draft === null) throw notFound();
    return draft;
  }

  /** A new draft at version 1; "Start over" is another call to this, never a reset of an old draft. */
  async create(ownerId: string, fields: DraftFields): Promise<DraftRecord> {
    assertAudience(fields.audience);
    const id = newId();
    return this.guarded(() =>
      this.database.uow.run(async (tx) => {
        if (fields.productMediaId != null)
          await this.claimMedia(tx, ownerId, fields.productMediaId, null);
        return this.repository.insert(tx, id, ownerId, fields);
      }),
    );
  }

  /**
   * Saves a step under `If-Match`. A submitted draft is 409 `state_conflict` (SB-D13), a stale version 409
   * `version_conflict`; in both cases nothing is written, so a failed save keeps the stored values.
   */
  async patch(
    ownerId: string,
    id: string,
    expectedVersion: number,
    fields: DraftFields,
  ): Promise<DraftRecord> {
    assertAudience(fields.audience);
    return this.guarded(() =>
      this.database.uow.run(async (tx) => {
        const current = await this.repository.find(tx, ownerId, id);
        if (current === null) throw notFound();
        if (current.campaignId !== null) throw submitted();
        if (current.version !== expectedVersion) throw this.versionConflict();
        if (fields.productMediaId != null && fields.productMediaId !== current.productMediaId) {
          await this.claimMedia(tx, ownerId, fields.productMediaId, id);
        }
        const saved = await this.repository.update(tx, ownerId, id, expectedVersion, fields);
        if (saved !== null) return saved;
        // Lost a race between the read and the conditional update: say which guard it was.
        const now = await this.repository.find(tx, ownerId, id);
        if (now === null) throw notFound();
        throw now.campaignId !== null ? submitted() : this.versionConflict();
      }),
    );
  }

  /**
   * Deletes an unsubmitted draft and its product image (REQ-013): the object first, then the rows, so a failed object
   * delete (503) leaves everything as it was and a retry finds the same draft. The audit event shares the row delete's
   * transaction and carries IDs only.
   */
  async remove(ownerId: string, id: string, requestId: string | null): Promise<void> {
    const draft = await this.database.uow.run(async (tx) => {
      const found = await this.repository.find(tx, ownerId, id);
      if (found === null) throw notFound();
      if (found.campaignId !== null) throw submitted();
      return found;
    });
    const derived =
      draft.productMediaId === null
        ? []
        : [uploadKey(ownerId, draft.productMediaId), quarantineKey(ownerId, draft.productMediaId)];
    await this.deleteObjects(derived);
    const row = await this.database.uow.run(async (tx) => {
      const locked = await this.repository.find(tx, ownerId, id, true);
      if (locked === null) throw notFound();
      if (locked.campaignId !== null) throw submitted();
      await this.repository.remove(tx, ownerId, id);
      const media =
        locked.productMediaId === null
          ? null
          : await this.media.unregisterObject(tx, locked.productMediaId);
      await this.audit.record(tx, {
        actorId: ownerId,
        actorType: 'user',
        action: 'draft.deleted',
        objectType: 'draft',
        objectId: id,
        outcome: 'allowed',
        requestId,
      });
      return media;
    });
    // The row names the key it really held; anything the derived keys missed goes now (the delete is idempotent).
    if (row !== null && !derived.includes(row.storageKey))
      await this.deleteObjects([row.storageKey]);
  }

  private versionConflict(): DomainError {
    return new DomainError(
      'version_conflict',
      'The draft was changed elsewhere. Reload it and try again.',
    );
  }

  /** Deletes objects (idempotent); a storage failure is 503 and nothing else has changed yet. */
  private async deleteObjects(keys: readonly string[]): Promise<void> {
    try {
      for (const key of keys) await this.storage.delete(key);
    } catch {
      throw unavailable();
    }
  }

  /** The caller's own, `ready` image that no other draft or campaign holds; attaching marks it as used. */
  private async claimMedia(
    tx: DbTx,
    ownerId: string,
    mediaId: string,
    draftId: string | null,
  ): Promise<void> {
    await this.media.attach(tx, ownerId, mediaId);
    if (await this.repository.mediaTaken(tx, mediaId, draftId)) throw mediaTaken();
  }

  /** A second claim on one image that slipped past the read is caught by `drafts_product_media_uq`. */
  private async guarded<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isUniqueViolation(error, 'drafts_product_media_uq')) throw mediaTaken();
      throw error;
    }
  }
}
