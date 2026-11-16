import { describe, expect, it, vi } from 'vitest';
import type { CampaignRecord } from './history-ports.js';
import { HistoryService, escapeLike } from './history.service.js';
import { NO_JOBS, noJobsReader } from './progress-reader.js';
import type { CampaignProgressReader } from './progress-reader.js';

const A = '0197a1b2-0000-7000-8000-000000000001';
const C = '0197a1b2-0000-7000-8000-0000000000c1';
const tx = {} as never;

const campaign = (id = C): CampaignRecord => ({
  id, ownerId: A, productName: 'Tonic', productDescription: 'd', productMediaId: null, segmentCount: 2,
  createdAt: '2026-11-16 10:00:00+00', updatedAt: '2026-11-16 10:00:00+00',
});

function setup(reader: CampaignProgressReader = noJobsReader, owned = true) {
  const repository = {
    list: vi.fn(async () => [campaign()]),
    find: vi.fn(async () => ({ campaign: campaign(), draftId: 'd1' })),
    isActive: vi.fn(async () => true),
    ownsActive: vi.fn(async () => owned),
  };
  const database = { uow: { run: <T>(work: (t: never) => Promise<T>) => work(tx) } };
  return { repository, service: new HistoryService(database as never, repository, reader) };
}

describe('escapeLike', () => {
  it('makes %, _ and \\ literal', () => {
    expect(escapeLike('100%_a\\b')).toBe('100\\%\\_a\\\\b');
    expect(escapeLike('plain')).toBe('plain');
  });
});

describe('HistoryService', () => {
  it('lists with the escaped term and a campaign without jobs reads as in progress', async () => {
    const { service, repository } = setup();
    const rows = await service.list(A, 'all', '50%', 21);
    expect(repository.list).toHaveBeenCalledWith(tx, A, { limit: 21, after: undefined, escapedTerm: '50\\%', ids: undefined });
    expect(rows[0]?.snapshot).toBe(NO_JOBS);
  });

  it('restricts to the reader\'s IDs for a filter and returns nothing without touching the table when none match', async () => {
    const reader: CampaignProgressReader = {
      progressFor: async () => new Map(),
      idsWithProgress: async (_o, p) => new Set(p === 'failed' ? [C] : []),
    };
    const { service, repository } = setup(reader);
    await service.list(A, 'failed', undefined, 5);
    expect(repository.list).toHaveBeenCalledWith(tx, A, expect.objectContaining({ ids: [C] }));
    repository.list.mockClear();
    expect(await service.list(A, 'completed', undefined, 5)).toEqual([]);
    expect(repository.list).not.toHaveBeenCalled();
  });

  it('gets a campaign with its draft and 404s a missing one', async () => {
    const { service, repository } = setup();
    expect((await service.get(A, C)).draftId).toBe('d1');
    repository.find.mockResolvedValueOnce(null as never);
    await expect(service.get(A, C)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('assertOwner passes for an owned campaign and 404s otherwise; isActive delegates', async () => {
    await expect(setup().service.assertOwner(tx, A, C)).resolves.toBeUndefined();
    await expect(setup(noJobsReader, false).service.assertOwner(tx, A, C)).rejects.toMatchObject({ code: 'not_found' });
    expect(await setup().service.isActive(tx, C)).toBe(true);
  });

  it('the default reader knows no jobs', async () => {
    expect((await noJobsReader.progressFor(A, [C])).size).toBe(0);
    expect((await noJobsReader.idsWithProgress(A, 'processing')).size).toBe(0);
  });
});
