import { describe, expect, it, vi } from 'vitest';
import type { DbTx } from '../../../platform/db/index.js';
import { DomainError } from '../../../platform/http/domain-error.js';
import type { MediaRecord } from '../../media/index.js';
import { quarantineKey, uploadKey } from '../../media/index.js';
import type { DraftFields, DraftRecord } from '../domain/draft.js';
import type { DraftRepository } from './draft-ports.js';
import { DraftsService } from './drafts.service.js';

const A = '0197a1b2-0000-7000-8000-000000000001';
const B = '0197a1b2-0000-7000-8000-000000000002';
const IMG = '0197a1b2-0000-7000-8000-0000000000a1';
const IMG2 = '0197a1b2-0000-7000-8000-0000000000a2';
const tx = {} as DbTx;

class FakeRepository implements DraftRepository {
  rows = new Map<string, DraftRecord>();
  taken = new Set<string>();
  raceOnUpdate = false;
  uniqueOnInsert = false;
  async insert(_tx: DbTx, id: string, ownerId: string, fields: DraftFields): Promise<DraftRecord> {
    if (this.uniqueOnInsert) throw Object.assign(new Error('dup'), { code: '23505', constraint: 'drafts_product_media_uq' });
    const row: DraftRecord = {
      id, ownerId, version: 1, step: 1, adStyle: 'ugc', intakeMode: 'description',
      productName: null, productDescription: null, audience: null, direction: null, concept: null, script: null,
      productMediaId: null, campaignId: null, createdAt: '2026-11-16 10:00:00.000001+00', updatedAt: '2026-11-16 10:00:00.000001+00',
      ...fields,
    } as DraftRecord;
    this.rows.set(id, row);
    return row;
  }
  async find(_tx: DbTx, ownerId: string, id: string): Promise<DraftRecord | null> {
    const row = this.rows.get(id);
    return row !== undefined && row.ownerId === ownerId ? row : null;
  }
  async listOpen(_tx: DbTx, ownerId: string, limit: number): Promise<DraftRecord[]> {
    return [...this.rows.values()].filter((r) => r.ownerId === ownerId && r.campaignId === null).slice(0, limit);
  }
  async update(_tx: DbTx, ownerId: string, id: string, expected: number, fields: DraftFields): Promise<DraftRecord | null> {
    const row = this.rows.get(id);
    if (this.raceOnUpdate) {
      this.raceOnUpdate = false;
      return null;
    }
    if (row === undefined || row.ownerId !== ownerId || row.version !== expected || row.campaignId !== null) return null;
    const next = { ...row, ...fields, version: row.version + 1 } as DraftRecord;
    this.rows.set(id, next);
    return next;
  }
  async remove(_tx: DbTx, _ownerId: string, id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
  async mediaTaken(_tx: DbTx, mediaId: string): Promise<boolean> {
    return this.taken.has(mediaId);
  }
}

function setup() {
  const repo = new FakeRepository();
  const attached: string[] = [];
  const media = {
    attach: vi.fn(async (_tx: DbTx, _owner: string, id: string) => {
      if (id === 'missing') throw new DomainError('not_found', 'Not found.');
      if (id === 'processing') throw new DomainError('media_not_ready', 'The file is still being checked.');
      attached.push(id);
    }),
    unregisterObject: vi.fn(async (_tx: DbTx, id: string) => ({ id, storageKey: 'u/x' }) as unknown as MediaRecord),
  };
  const storage = { delete: vi.fn(async (key: string) => void key) };
  const audit = { record: vi.fn(async () => 'event') };
  const database = { uow: { run: <T,>(fn: (t: DbTx) => Promise<T>) => fn(tx) } };
  const service = new DraftsService(database as never, repo, media as never, storage as never, audit as never);
  return { repo, media, storage, audit, service, attached };
}

const code = async (promise: Promise<unknown>): Promise<string> => {
  const error: unknown = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(DomainError);
  return (error as DomainError).code;
};

describe('DraftsService.create', () => {
  it('creates a draft at version 1 and attaches a ready image', async () => {
    const { service, attached } = setup();
    const draft = await service.create(A, { productName: 'Test Tonic', productMediaId: IMG });
    expect(draft).toMatchObject({ version: 1, ownerId: A, productName: 'Test Tonic', productMediaId: IMG });
    expect(attached).toEqual([IMG]);
  });
  it('creates a draft without an image', async () => {
    const { service, media } = setup();
    await service.create(A, { step: 2 });
    expect(media.attach).not.toHaveBeenCalled();
  });
  it('refuses a maximum age below the minimum', async () => {
    const { service } = setup();
    expect(await code(service.create(A, { audience: { ageMin: 40, ageMax: 30 } }))).toBe('validation_failed');
  });
  it('maps an image held elsewhere to state_conflict, in the read and at the unique index', async () => {
    const { service, repo } = setup();
    repo.taken.add(IMG);
    expect(await code(service.create(A, { productMediaId: IMG }))).toBe('state_conflict');
    repo.taken.clear();
    repo.uniqueOnInsert = true;
    expect(await code(service.create(A, { productMediaId: IMG }))).toBe('state_conflict');
  });
  it('lets the media errors through: foreign or unknown 404, still processing 422', async () => {
    const { service } = setup();
    expect(await code(service.create(A, { productMediaId: 'missing' }))).toBe('not_found');
    expect(await code(service.create(A, { productMediaId: 'processing' }))).toBe('media_not_ready');
  });
  it('rethrows an unrelated failure unchanged', async () => {
    const { service, repo } = setup();
    repo.insert = async () => {
      throw new Error('boom');
    };
    await expect(service.create(A, {})).rejects.toThrow('boom');
  });
});

describe('DraftsService reads', () => {
  it('answers a foreign and a never-existing draft the same (TC-AUT)', async () => {
    const { service } = setup();
    const draft = await service.create(A, {});
    expect(await code(service.get(B, draft.id))).toBe('not_found');
    expect(await code(service.get(A, IMG))).toBe('not_found');
    expect((await service.get(A, draft.id)).id).toBe(draft.id);
  });
  it('lists only the owner’s open drafts', async () => {
    const { service, repo } = setup();
    const mine = await service.create(A, {});
    await service.create(B, {});
    const submitted = await service.create(A, {});
    repo.rows.set(submitted.id, { ...submitted, campaignId: IMG2 });
    expect((await service.listOpen(A, 10)).map((d) => d.id)).toEqual([mine.id]);
  });
});

describe('DraftsService.patch', () => {
  it('saves under the matching version and bumps it', async () => {
    const { service } = setup();
    const draft = await service.create(A, {});
    const saved = await service.patch(A, draft.id, 1, { productName: 'X', direction: { segmentCount: 4 } });
    expect(saved).toMatchObject({ version: 2, productName: 'X' });
  });
  it('refuses a stale version with no write (TC-INT-05)', async () => {
    const { service, repo } = setup();
    const draft = await service.create(A, {});
    await service.patch(A, draft.id, 1, { productName: 'tab 1' });
    expect(await code(service.patch(A, draft.id, 1, { productName: 'tab 2' }))).toBe('version_conflict');
    expect(repo.rows.get(draft.id)?.productName).toBe('tab 1');
  });
  it('answers 404 for a foreign draft and state_conflict for a submitted one', async () => {
    const { service, repo } = setup();
    const draft = await service.create(A, {});
    expect(await code(service.patch(B, draft.id, 1, { step: 2 }))).toBe('not_found');
    repo.rows.set(draft.id, { ...draft, campaignId: IMG2 });
    expect(await code(service.patch(A, draft.id, 1, { step: 2 }))).toBe('state_conflict');
  });
  it('names the guard when the conditional update loses a race', async () => {
    const { service, repo } = setup();
    const draft = await service.create(A, {});
    repo.raceOnUpdate = true;
    expect(await code(service.patch(A, draft.id, 1, { step: 2 }))).toBe('version_conflict');
    repo.raceOnUpdate = true;
    const original = repo.find.bind(repo);
    let calls = 0;
    repo.find = async (...args) => {
      calls += 1;
      const row = await original(...args);
      return calls === 2 && row !== null ? { ...row, campaignId: IMG2 } : calls === 3 ? null : row;
    };
    expect(await code(service.patch(A, draft.id, 1, { step: 2 }))).toBe('state_conflict');
    repo.raceOnUpdate = true;
    calls = 2;
    expect(await code(service.patch(A, draft.id, 1, { step: 2 }))).toBe('not_found');
  });
  it('attaches a changed image and leaves an unchanged one alone', async () => {
    const { service, media } = setup();
    const draft = await service.create(A, { productMediaId: IMG });
    media.attach.mockClear();
    await service.patch(A, draft.id, 1, { productMediaId: IMG });
    expect(media.attach).not.toHaveBeenCalled();
    await service.patch(A, draft.id, 2, { productMediaId: IMG2 });
    expect(media.attach).toHaveBeenCalledTimes(1);
    const detached = await service.patch(A, draft.id, 3, { productMediaId: null });
    expect(detached.productMediaId).toBeNull();
    expect(media.attach).toHaveBeenCalledTimes(1);
  });
  it('refuses an image another draft holds, and a rejected maximum age', async () => {
    const { service, repo } = setup();
    const draft = await service.create(A, {});
    repo.taken.add(IMG2);
    expect(await code(service.patch(A, draft.id, 1, { productMediaId: IMG2 }))).toBe('state_conflict');
    expect(await code(service.patch(A, draft.id, 1, { audience: { ageMin: 50, ageMax: 40 } }))).toBe('validation_failed');
  });
});

describe('DraftsService.remove', () => {
  it('deletes the image objects first, then the draft and the media row, and audits', async () => {
    const { service, repo, storage, media, audit } = setup();
    const draft = await service.create(A, { productMediaId: IMG });
    await service.remove(A, draft.id, 'req-1');
    expect(storage.delete.mock.calls.map((c) => c[0])).toEqual([uploadKey(A, IMG), quarantineKey(A, IMG), 'u/x']);
    expect(media.unregisterObject).toHaveBeenCalledWith(tx, IMG);
    expect(repo.rows.has(draft.id)).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(tx, expect.objectContaining({ action: 'draft.deleted', objectId: draft.id, actorId: A, requestId: 'req-1' }));
  });
  it('does not delete the same key twice', async () => {
    const { service, storage, media } = setup();
    media.unregisterObject.mockImplementation(async (_t: DbTx, id: string) => ({ id, storageKey: uploadKey(A, IMG) }) as unknown as MediaRecord);
    const draft = await service.create(A, { productMediaId: IMG });
    await service.remove(A, draft.id, null);
    expect(storage.delete).toHaveBeenCalledTimes(2);
  });
  it('deletes a draft without an image with no storage call', async () => {
    const { service, storage, media } = setup();
    const draft = await service.create(A, {});
    await service.remove(A, draft.id, null);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(media.unregisterObject).not.toHaveBeenCalled();
  });
  it('leaves everything as it was when the object delete fails (503)', async () => {
    const { service, repo, storage } = setup();
    const draft = await service.create(A, { productMediaId: IMG });
    storage.delete.mockRejectedValueOnce(new Error('down'));
    expect(await code(service.remove(A, draft.id, null))).toBe('service_unavailable');
    expect(repo.rows.has(draft.id)).toBe(true);
  });
  it('answers 404 for a foreign draft and 409 for a submitted one, deleting nothing', async () => {
    const { service, repo, storage } = setup();
    const draft = await service.create(A, { productMediaId: IMG });
    expect(await code(service.remove(B, draft.id, null))).toBe('not_found');
    repo.rows.set(draft.id, { ...draft, campaignId: IMG2 });
    expect(await code(service.remove(A, draft.id, null))).toBe('state_conflict');
    expect(storage.delete).not.toHaveBeenCalled();
  });
  it('re-checks under the row lock: a draft submitted or removed in between is refused', async () => {
    const { service, repo } = setup();
    const draft = await service.create(A, {});
    const original = repo.find.bind(repo);
    let calls = 0;
    repo.find = async (...args) => {
      calls += 1;
      const row = await original(...args);
      if (calls === 2) return row === null ? null : { ...row, campaignId: IMG2 };
      return row;
    };
    expect(await code(service.remove(A, draft.id, null))).toBe('state_conflict');
    calls = 0;
    repo.find = async (...args) => {
      calls += 1;
      return calls === 2 ? null : original(...args);
    };
    expect(await code(service.remove(A, draft.id, null))).toBe('not_found');
  });
});
