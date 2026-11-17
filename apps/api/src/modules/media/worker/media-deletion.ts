import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../../platform/db/index.js';
import type { Database, DbTx } from '../../../platform/db/index.js';
import { MEDIA_REPOSITORY } from '../application/ports.js';
import type { MediaRecord, MediaRepository } from '../application/ports.js';
import { uploadKey } from '../domain/keys.js';
import { STORAGE_PORT } from '../domain/storage.js';
import type { StoragePort } from '../domain/storage.js';
import { MEDIA_MAINTENANCE_REPOSITORY } from './maintenance.js';
import type { MediaMaintenanceRepository } from './maintenance.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** The prefixes `sweepPrefix` accepts: an owner's, or one of an owner's campaigns. Never the bucket or all owners. */
const SWEEPABLE = new RegExp(`^(?:[uq]/${UUID}/|u/${UUID}/c/${UUID}/)$`);
const BATCH = 200;
const PREFIX_BATCH = 1000;

/**
 * Object deletion helpers (SB-D17): the object goes first, then the row and the owner's bytes, in one transaction that
 * holds the row lock. A failed object delete leaves the row, so the next run finds it again; deleting an object that is
 * already gone is not an error.
 */
@Injectable()
export class MediaDeletion {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'uow'>,
    @Inject(MEDIA_REPOSITORY) private readonly repository: MediaRepository,
    @Inject(MEDIA_MAINTENANCE_REPOSITORY) private readonly maintenance: MediaMaintenanceRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  /**
   * Deletes the objects and rows of these media ids and returns the bytes to their owners; an unknown id is skipped.
   * Returns how many rows were deleted.
   */
  async deleteObjects(ids: readonly string[]): Promise<number> {
    let deleted = 0;
    for (const id of new Set(ids)) {
      if (await this.deleteOne(id)) deleted += 1;
    }
    return deleted;
  }

  /** Every object and row of a campaign, then whatever is left under its key prefixes (unregistered objects). */
  async deleteForCampaign(campaignId: string): Promise<{ rows: number; objects: number }> {
    let rows = 0;
    const owners = new Set<string>();
    for (;;) {
      const batch = await this.database.uow.run((tx) =>
        this.maintenance.listByCampaign(tx, campaignId, BATCH),
      );
      if (batch.length === 0) break;
      for (const { ownerId } of batch) owners.add(ownerId);
      const done = await this.deleteObjects(batch.map((row) => row.id));
      rows += done;
      if (done === 0) break;
    }
    let objects = 0;
    for (const owner of owners) objects += await this.sweepPrefix(`u/${owner}/c/${campaignId}/`);
    return { rows, objects };
  }

  /** Deletes every object under an owner or campaign prefix in batches; returns how many were deleted. */
  async sweepPrefix(prefix: string): Promise<number> {
    if (!SWEEPABLE.test(prefix)) throw new TypeError('prefix must be an owner or campaign prefix');
    return this.storage.deletePrefix(prefix, PREFIX_BATCH);
  }

  /** The unattached sweep's step: deletes the row only while `eligible` still holds under the row lock. */
  async deleteOne(id: string, eligible?: (row: MediaRecord) => boolean): Promise<boolean> {
    return this.database.uow.run(async (tx: DbTx) => {
      const row = await this.maintenance.lockRow(tx, id);
      if (row === null || (eligible !== undefined && !eligible(row))) return false;
      await this.storage.delete(row.storageKey);
      // A sanitize that died after storing the clean copy leaves it under the `u/` key.
      if (row.kind === 'upload' && row.state === 'processing')
        await this.storage.delete(uploadKey(row.ownerId, row.id));
      await this.repository.remove(tx, id);
      if (row.bytes !== null && row.bytes > 0) {
        await this.repository.lockUsage(tx, row.ownerId);
        await this.repository.addUsage(tx, row.ownerId, -row.bytes);
      }
      return true;
    });
  }
}
